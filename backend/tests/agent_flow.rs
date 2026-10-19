//! The answer loop end to end with a scripted model, a throwaway MariaDB
//! database, the embedding server and the Oracle demo rows (mock mode).

mod support;

use llm_agent::agent::{self, Events, Question};
use serde_json::{Value, json};
use support::*;
use tokio_util::sync::CancellationToken;

async fn ask(app: &std::sync::Arc<llm_agent::app::App>, conversation: &str, message: &str, history: Vec<(String, String)>) -> (anyhow::Result<agent::Answer>, Vec<Value>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let result = agent::answer(
        app,
        Question {
            conversation_id: conversation.into(),
            message: message.into(),
            history,
        },
        Events::new(Some(tx)),
        CancellationToken::new(),
    )
    .await;
    let mut events = vec![];
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    (result, events)
}

#[tokio::test]
async fn search_method_query_and_table_reference() {
    let Some(db) = TestDb::create("flow") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let config = db.config();
    if !embedding_available(&config).await {
        return skip("no embedding server");
    }
    let method = db.scalar("SELECT seq FROM qa_method WHERE title = '배치 작업 상태 확인'");
    let llm = Scripted::new(vec![
        calls(vec![call("c1", "search", json!({"query":"배치 작업 상태 확인","targets":["qa_method","query"]}))]),
        calls(vec![call("c2", "method_read", json!({"ids":[format!("m{method}")]}))]),
        calls(vec![call("c3", "query_run", json!({"query_name":"batch_job_status","params":{":job_id":"BATCH001"}}))]),
        text("BATCH001은 실패 상태입니다.\n\n```table\nstep: 1\n```"),
    ]);
    let (app, _dir) = app(config, llm.clone());
    // The seed has no vectors yet: one sync embeds it.
    let config = app.config();
    let summary = app.sync.run(&app.db, &config, &app.shutdown).await.unwrap();
    assert!(summary.embedded > 0, "{summary}");

    let (result, events) = ask(&app, "conv-1", "BATCH001 배치 상태 알려줘", vec![]).await;
    let answer = result.unwrap();
    assert!(answer.answer.contains("```table\nstep: 1"));

    // Progress events in the former shapes, paired by id.
    let search = ev(&events, "search");
    let done = ev(&events, "search_done");
    assert_eq!(search.len(), 1);
    assert_eq!(done[0]["id"], search[0]["id"]);
    assert!(done[0]["hits"]["qaMethods"].as_u64().unwrap() >= 1, "{done:?}");
    assert!(done[0]["hits"]["queries"].as_u64().unwrap() >= 1, "{done:?}");
    assert!(done[0]["hits"]["knowledge"].is_null() && done[0].get("failed").is_none(), "knowledge was not searched: {done:?}");
    let tool = ev(&events, "tool");
    assert_eq!(tool[0]["name"], "method_read");
    assert_eq!(ev(&events, "tool_done")[0]["status"], "ok");
    let run = ev(&events, "run_query");
    let run_done = ev(&events, "run_query_done");
    assert_eq!(run[0]["query_name"], "batch_job_status");
    assert_eq!(run[0]["params"], json!({"job_id":"BATCH001"}));
    assert_eq!(run_done[0]["id"], run[0]["id"]);
    assert_eq!(run_done[0]["rowCount"], 1);
    assert_eq!(run_done[0]["targetDb"], "ORDER_DB");
    assert!(!ev(&events, "answer_delta").is_empty());

    // The trace carries the search and the query with every fetched row.
    let query_step = answer.trace.iter().find(|s| s["query_name"].is_string()).unwrap();
    assert_eq!(query_step["step"], 1);
    assert_eq!(query_step["rows"][0]["STATUS"], "FAILED");
    assert!(answer.trace.iter().any(|s| s["search"] == "배치 작업 상태 확인"));
    assert!(answer.trace.iter().any(|s| s["tool"] == "method_read"));
    assert_eq!(answer.log["v"], 5);

    // What the model saw.
    let requests = llm.requests();
    let search_result = tool_result(&requests[1], "c1");
    let methods = &search_result["data"]["results"]["qa_method"]["items"];
    assert!(methods.as_array().unwrap().iter().any(|m| m["id"] == format!("m{method}")), "{search_result}");
    let method_result = tool_result(&requests[2], "c2");
    assert!(method_result["data"]["items"][0]["queries"].as_array().unwrap().iter().any(|q| q["name"] == "batch_job_status"));
    let run_result = tool_result(&requests[3], "c3");
    assert_eq!(run_result["data"]["step"], 1);
    assert_eq!(run_result["data"]["rows"][0]["JOB_ID"], "BATCH001");

    // A follow-up in the same conversation keeps the earlier results in
    // context and runs the identical query again: the DB is live, and a later
    // question may ask for the values as they are now. Within that question
    // the repeat is refused for result_read; the earlier question's rows stay
    // readable and referable.
    let run = |id: &str| call(id, "query_run", json!({"query_name":"batch_job_status","params":{"job_id":"BATCH001"}}));
    llm.push(vec![
        calls(vec![run("c4")]),
        calls(vec![run("c5")]),
        calls(vec![call("c6", "result_read", json!({"step":1,"cols":["status"]}))]),
        text("지금도 실패 상태입니다.\n\n```chart\ntype: bar\ntitle: 상태\ndata: step 1\n```"),
    ]);
    let (result, events) = ask(&app, "conv-1", "지금 다시 조회해줘", vec![]).await;
    let answer = result.unwrap();
    let requests = llm.requests();
    let first_of_followup = &requests[4];
    assert!(
        first_of_followup["messages"].as_array().unwrap().iter().any(|m| m["tool_call_id"] == "c3"),
        "earlier tool results stay in context"
    );
    let rerun = tool_result(&requests[5], "c4");
    assert_eq!(rerun["status"], "ok", "{rerun}");
    assert_eq!(rerun["data"]["step"], 2);
    let run_done = ev(&events, "run_query_done");
    assert_eq!(run_done[0]["rowCount"], 1);
    assert_eq!(run_done[1]["error"], "같은 조회를 이미 실행했습니다.");
    let repeated = tool_result(&requests[6], "c5");
    assert_eq!(repeated["recovery"]["code"], "repeated_call", "{repeated}");
    assert!(repeated["error"].as_str().unwrap().contains("이번 질문에서") && repeated["error"].as_str().unwrap().contains("(step 2)"), "{repeated}");
    // The refusal is a loop guard, not a failed query: no error step (the
    // chat_log failed-question query counts steps[].error).
    assert!(answer.trace.iter().all(|s| s.get("error").is_none()), "{:?}", answer.trace);
    let steps: Vec<&Value> = answer.trace.iter().filter(|s| s["query_name"].is_string()).collect();
    assert_eq!(steps.len(), 1, "{steps:?}");
    assert_eq!(steps[0]["step"], 2);
    assert_eq!(answer.log["search"]["searches"], 0);
    let read = tool_result(&requests[7], "c6");
    assert_eq!(read["data"]["columns"], json!(["STATUS"]));
    assert_eq!(answer.refs[0]["step"], 1);
    assert_eq!(answer.refs[0]["rows"][0]["STATUS"], "FAILED");
}

#[tokio::test]
async fn a_repeat_in_a_question_runs_again_once_its_rows_are_gone() {
    let Some(db) = TestDb::create("rerun") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let run = |id: &str, job: &str| call(id, "query_run", json!({"query_name":"batch_job_status","params":{"job_id":job}}));
    let llm = Scripted::new(vec![
        calls(vec![run("c1", "BATCH001")]),
        calls(vec![run("c2", "BATCH002")]),
        calls(vec![run("c3", "BATCH001")]),
        calls(vec![run("c4", "BATCH001")]),
        text("확인했습니다."),
    ]);
    // The result store keeps only the newest result's rows (a size below
    // what the settings accept, so it is set after saving them).
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.toml");
    let mut config = db.config();
    config.save(&path).unwrap();
    config.agent.result_store_bytes = 1;
    let app = llm_agent::app::App::new(path, config, llm.clone());
    let (result, _) = ask(&app, "conv-rerun", "배치 상태 확인해줘", vec![]).await;
    result.unwrap();
    let requests = llm.requests();
    // Step 2 dropped step 1's rows: the refusal would point at rows that are
    // gone, so the repeat runs.
    let again = tool_result(&requests[3], "c3");
    assert_eq!(again["data"]["step"], 3, "{again}");
    // Step 3 is kept: its repeat is refused.
    let repeated = tool_result(&requests[4], "c4");
    assert_eq!(repeated["recovery"]["code"], "repeated_call", "{repeated}");
    assert!(repeated["error"].as_str().unwrap().contains("(step 3)"), "{repeated}");
}

#[tokio::test]
async fn lost_conversations_restore_from_the_browser_history() {
    let Some(db) = TestDb::create("restore") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let llm = Scripted::new(vec![text("네, 이어서 답합니다.")]);
    let (app, _dir) = app(db.config(), llm.clone());
    let history = vec![
        ("user".to_owned(), "홍길동 주문 상태 알려줘".to_owned()),
        ("assistant".to_owned(), "O-777은 배송중입니다.".to_owned()),
        ("system".to_owned(), "무시".to_owned()),
    ];
    let (result, _) = ask(&app, "conv-restore", "그 주문 금액은?", history.clone()).await;
    assert_eq!(result.unwrap().answer, "네, 이어서 답합니다.");
    let request = &llm.requests()[0];
    let users = messages(request, "user");
    assert_eq!(users[0]["content"], "홍길동 주문 상태 알려줘");
    assert_eq!(messages(request, "assistant")[0]["content"], "O-777은 배송중입니다.");
    assert!(users.iter().all(|m| m.get("restored").is_none()), "internal flags stay internal");
    // The conversation now exists: a second question does not restore again.
    llm.push(vec![text("두 번째")]);
    ask(&app, "conv-restore", "또?", history).await.0.unwrap();
    let second = &llm.requests()[1];
    assert_eq!(
        messages(second, "user").iter().filter(|m| m["content"] == "홍길동 주문 상태 알려줘").count(),
        1
    );
}

#[tokio::test]
async fn cancelling_stops_the_run_and_unknown_tools_are_refused() {
    let Some(db) = TestDb::create("cancel") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let llm = Scripted::new(vec![]);
    llm.hang.store(true, std::sync::atomic::Ordering::Relaxed);
    let (app, _dir) = app(db.config(), llm.clone());
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        trigger.cancel();
    });
    let result = agent::answer(
        &app,
        Question { conversation_id: "c".into(), message: "질문".into(), history: vec![] },
        Events::new(None),
        cancel,
    )
    .await;
    assert_eq!(result.err().unwrap().to_string(), "cancelled");

    llm.hang.store(false, std::sync::atomic::Ordering::Relaxed);
    llm.push(vec![
        calls(vec![
            call("x1", "file_write", json!({"path":"a"})),
            call("x2", "file_read", json!({"path":"a"})),
        ]),
        text("끝"),
    ]);
    let (result, events) = ask(&app, "c2", "파일 써줘", vec![]).await;
    assert_eq!(result.unwrap().answer, "끝");
    let request = llm.requests().last().unwrap().clone();
    assert_eq!(tool_result(&request, "x1")["status"], "unsupported");
    // Without projects the source tools are not offered either.
    assert_eq!(tool_result(&request, "x2")["status"], "unsupported");
    assert_eq!(ev(&events, "tool_done").len(), 2);
    assert!(request["tools"].as_array().unwrap().iter().all(|t| t["function"]["name"] != "file_read"));
}

/// A stopped question whose tools waited on the management DB (a table
/// another session locked, the DB unreachable) went on until each query's
/// time limit (30 s), holding its conversation: the question asked next in
/// it waited as long. Its reads now end with the stop, and the calls stay in
/// the conversation as cancelled.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_next_question_does_not_wait_for_the_db_reads_of_a_stopped_one() {
    let Some(db) = TestDb::create("stopdb") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let run = json!({"query_name":"batch_job_status","params":{"job_id":"BATCH001"}});
    // The knowledge and registry reads; the target DB's registration, read
    // before an Oracle statement (not in mock mode).
    for (tables, mock, reads) in [
        ("knowledge_chunk WRITE, query_registry WRITE", true, vec![call("r1", "knowledge_read", json!({"id":"k1"})), call("q1", "query_run", run.clone())]),
        ("target_db WRITE", false, vec![call("q1", "query_run", run.clone())]),
    ] {
        let mut config = db.config();
        config.mariadb.timeout_ms = 20_000;
        config.oracle.mock = mock;
        let ids: Vec<String> = reads.iter().map(|c| c.id.clone()).collect();
        let llm = Scripted::new(vec![calls(reads), text("두 번째 답")]);
        let (app, _dir) = app(config, llm.clone());
        let cfg = app.config();
        let mut holder = app.db.lock_conn(&cfg.mariadb).await.unwrap();
        llm_agent::db::plain_on(&cfg.mariadb, &mut holder, &format!("LOCK TABLES {tables}")).await.unwrap();
        let first = {
            let app = app.clone();
            tokio::spawn(async move { ask(&app, "c", "첫 질문", vec![]).await.0.map(|a| a.answer).map_err(|e| e.to_string()) })
        };
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        // Asked again in the conversation, as after the stop button.
        let started = std::time::Instant::now();
        let (second, _) = tokio::time::timeout(std::time::Duration::from_secs(10), ask(&app, "c", "두 번째 질문", vec![]))
            .await
            .unwrap_or_else(|_| panic!("{tables}: the next question waited for the stopped one's DB reads"));
        assert_eq!(second.unwrap().answer, "두 번째 답", "{tables}: after {:?}", started.elapsed());
        assert_eq!(first.await.unwrap().unwrap_err(), "cancelled");
        let request = llm.requests().last().unwrap().clone();
        for id in ids {
            assert_eq!(tool_result(&request, &id)["status"], "cancelled", "{tables}: {id}");
        }
        llm_agent::db::plain_on(&cfg.mariadb, &mut holder, "UNLOCK TABLES").await.unwrap();
    }
}

#[tokio::test]
async fn every_call_of_a_response_runs() {
    let Some(db) = TestDb::create("calls") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let names = ["batch_job_status", "find_customer_id", "today_date"];
    let batch = (0..40).map(|i| call(&format!("d{i}"), "query_describe", json!({"names":[names[i % 3]]}))).collect();
    let llm = Scripted::new(vec![calls(batch), text("끝")]);
    let (app, _dir) = app(db.config(), llm.clone());
    let (result, events) = ask(&app, "calls", "쿼리 설명해줘", vec![]).await;
    let answer = result.unwrap();
    assert_eq!(answer.answer, "끝");
    let requests = llm.requests();
    let state = messages(&requests[0], "user").last().unwrap()["content"].as_str().unwrap().to_owned();
    assert!(!state.contains("max_tool_calls") && !state.contains("remaining_model_requests"), "{state}");
    for i in 0..40 {
        assert_eq!(tool_result(&requests[1], &format!("d{i}"))["status"], "ok", "d{i}");
    }
    assert_eq!(ev(&events, "tool_done").len(), 40);
    assert_eq!(answer.trace.iter().filter(|s| s["tool"] == "query_describe").count(), 40);
}

/// A question runs until it answers: past the former 24 model requests, and
/// a tool that keeps failing still runs. Needs no MariaDB.
#[tokio::test]
async fn a_question_runs_until_it_answers() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.txt"), "a\n").unwrap();
    let mut config = llm_agent::config::Config::default();
    config.mariadb.port = 9;
    config.llm.base_url = "http://127.0.0.1:9/v1".into();
    config.llm.model = "gpt-4o".into();
    config.projects.push(llm_agent::config::Project {
        name: "app".into(),
        root: root.clone(),
        ..Default::default()
    });
    let mut script: Vec<_> = (0..30).map(|i| calls(vec![call(&format!("f{i}"), "file_read", json!({"path":format!("missing{i}.txt")}))])).collect();
    script.push(text("끝"));
    let llm = Scripted::new(script);
    let (long_app, _long_dir) = app(config, llm.clone());
    let (result, _) = ask(&long_app, "long", "없는 파일들 찾아봐", vec![]).await;
    assert_eq!(result.unwrap().answer, "끝");
    let requests = llm.requests();
    assert_eq!(requests.len(), 31);
    let last = tool_result(&requests[30], "f29");
    assert_eq!(last["recovery"]["code"], "file_not_found", "the 30th failure still ran: {last}");
}

#[tokio::test]
async fn project_sources_are_read_and_old_bundles_leave_the_context() {
    let Some(db) = TestDb::create("source") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/search.rs"), "const MAX_DIST: f64 = 0.4;\nfn search() {}\n").unwrap();
    std::fs::write(dir.path().join("guide.md"), "# 가이드\n검색 문턱은 MAX_DIST다.\n").unwrap();
    std::fs::write(root.join("big.txt"), "긴 줄입니다 ".repeat(3000)).unwrap();
    let mut config = db.config();
    config.projects.push(llm_agent::config::Project {
        name: "app".into(),
        description: "검색 서버".into(),
        root: root.clone(),
        docs: vec![dir.path().join("guide.md").display().to_string()],
        ..Default::default()
    });
    config.llm.context_tokens = 16_000;
    config.llm.output_tokens = 2_000;
    config.agent.result_tokens = Some(3_000);
    let guide = dir.path().join("guide.md").display().to_string();
    let llm = Scripted::new(vec![
        calls(vec![
            call("s1", "file_read", json!({"path":guide})),
            call("s2", "source_search", json!({"project":"app","query":"MAX_DIST"})),
        ]),
        text("검색 문턱은 src/search.rs:1-1 의 MAX_DIST(0.4)입니다."),
    ]);
    let (app, _dir) = app(config, llm.clone());
    let (result, events) = ask(&app, "src", "검색 문턱은 어디서 정해?", vec![]).await;
    assert!(result.unwrap().answer.contains("MAX_DIST"));
    let request = &llm.requests()[1];
    let state = messages(request, "user").last().unwrap()["content"].as_str().unwrap().to_owned();
    assert!(state.contains("\"projects\"") && state.contains("검색 서버"), "{state}");
    let read = tool_result(request, "s1");
    assert_eq!(read["status"], "ok", "{read}");
    assert!(read["data"]["content"]["numbered_text"].as_str().unwrap().starts_with("1|# 가이드"));
    let found = tool_result(request, "s2");
    assert_eq!(found["data"]["matches"][0]["path"], "src/search.rs", "paths are shown relative to the root: {found}");
    assert!(found["data"]["matches"][0].get("source").is_none());
    let summaries: Vec<String> = ev(&events, "tool").iter().map(|e| e["summary"].as_str().unwrap().to_owned()).collect();
    assert!(summaries.iter().any(|s| s.starts_with("[app] 소스 검색")), "{summaries:?}");

    // Large reads fill the small context; the oldest bundles leave it whole
    // and the history tool appears to reach them.
    let mut script = vec![];
    for i in 0..4 {
        script.push(calls(vec![call(&format!("b{i}"), "file_read", json!({"path":"big.txt","start_line":1,"max_lines":1,"force_read":true}))]));
    }
    script.push(text("끝"));
    llm.push(script);
    let (result, _) = ask(&app, "src", "큰 파일 봐줘", vec![]).await;
    assert_eq!(result.unwrap().answer, "끝");
    let requests = llm.requests();
    let last = requests.last().unwrap();
    let ids: Vec<&str> = last["messages"].as_array().unwrap().iter().filter_map(|m| m["tool_call_id"].as_str()).collect();
    assert!(!ids.contains(&"s1"), "the oldest bundle left the context: {ids:?}");
    assert!(ids.contains(&"b3"), "the newest stays: {ids:?}");
    assert!(last["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == "history"));
    assert!(
        messages(last, "user").iter().any(|m| m["content"] == "큰 파일 봐줘"),
        "the current question stays"
    );
}

/// Every result gets the whole result budget however many calls one response
/// makes; only results that cannot fit the context even with every older
/// bundle evicted are cut, the largest first. Needs no MariaDB.
#[tokio::test]
async fn each_result_gets_the_whole_budget_and_an_overflowing_response_is_cut() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    let body: String = (1..=3000).map(|i| format!("line {i} {}\n", "word ".repeat(12))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    let config = |context: usize, output: usize, result: usize| {
        let mut config = llm_agent::config::Config::default();
        config.mariadb.port = 9;
        config.llm.base_url = "http://127.0.0.1:9/v1".into();
        config.llm.model = "gpt-4o".into();
        config.llm.context_tokens = context;
        config.llm.output_tokens = output;
        config.agent.result_tokens = Some(result);
        config.projects.push(llm_agent::config::Project {
            name: "app".into(),
            root: root.clone(),
            ..Default::default()
        });
        config
    };
    let reads = |prefix: &str| {
        calls((1..=4).map(|i| call(&format!("{prefix}{i}"), "file_read", json!({"path":"big.txt","start_line":i * 500}))).collect())
    };
    let delivered = |request: &Value, id: &str| {
        let message = messages(request, "tool").into_iter().find(|m| m["tool_call_id"] == id).unwrap();
        llm_agent::context::count(&message, "gpt-4o")
    };

    // Four large reads in one response each fill the 3,000 tokens (the
    // former split gave each a quarter of 8,000).
    let llm = Scripted::new(vec![reads("a"), text("끝")]);
    let (whole, _whole_dir) = app(config(128_000, 16_384, 3_000), llm.clone());
    let (result, _) = ask(&whole, "whole", "큰 파일 넷 봐줘", vec![]).await;
    assert_eq!(result.unwrap().answer, "끝");
    let request = llm.requests()[1].clone();
    for id in ["a1", "a2", "a3", "a4"] {
        let tokens = delivered(&request, id);
        assert!((2_500..=3_000).contains(&tokens), "{id}: {tokens}");
        assert_eq!(tool_result(&request, id)["next_cursor"]["tool"], "file_read");
    }

    // In a 16K context four 6,000-token results cannot all stay: the
    // largest are cut until the response fits, and the question goes on.
    let llm = Scripted::new(vec![reads("b"), text("끝")]);
    let (small, _small_dir) = app(config(16_000, 2_000, 6_000), llm.clone());
    let (result, _) = ask(&small, "cut", "큰 파일 넷 봐줘", vec![]).await;
    assert_eq!(result.unwrap().answer, "끝");
    let request = llm.requests()[1].clone();
    let sizes: Vec<usize> = ["b1", "b2", "b3", "b4"].iter().map(|id| delivered(&request, id)).collect();
    assert!(sizes.iter().sum::<usize>() < 12_000, "{sizes:?}");
    assert!(sizes.iter().all(|size| *size <= 6_000), "{sizes:?}");
    for id in ["b1", "b2", "b3", "b4"] {
        assert_eq!(tool_result(&request, id)["status"], "ok", "{id}");
    }
}

/// The response's own tool calls stay in context with its results: a large
/// argument leaves less room for them. Needs no MariaDB.
#[tokio::test]
async fn an_overflowing_response_leaves_room_for_its_own_calls() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    let body: String = (1..=3000).map(|i| format!("line {i} {}\n", "word ".repeat(12))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    let mut config = llm_agent::config::Config::default();
    config.mariadb.port = 9;
    config.llm.base_url = "http://127.0.0.1:9/v1".into();
    config.llm.model = "gpt-4o".into();
    config.llm.context_tokens = 16_000;
    config.llm.output_tokens = 2_000;
    config.agent.result_tokens = Some(6_000);
    config.projects.push(llm_agent::config::Project {
        name: "app".into(),
        root: root.clone(),
        ..Default::default()
    });
    // About 3,000 tokens of search text ride in the assistant message.
    let long_query: String = (0..1500).map(|i| format!("term{i} ")).collect();
    let mut batch: Vec<_> = (1..=4).map(|i| call(&format!("r{i}"), "file_read", json!({"path":"big.txt","start_line":i * 500}))).collect();
    batch.push(call("q", "source_search", json!({"query":long_query})));
    let llm = Scripted::new(vec![calls(batch), text("끝")]);
    let (small, _small_dir) = app(config, llm.clone());
    let (result, _) = ask(&small, "args", "큰 파일 넷 봐줘", vec![]).await;
    assert_eq!(result.unwrap().answer, "끝");
}

/// A model whose provider counts `ratio` times the local estimate, as an
/// unknown tokenizer does.
struct Ratio {
    replies: std::sync::Mutex<std::collections::VecDeque<llm_agent::llm::Completion>>,
    ratio: f64,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for Ratio {
    async fn complete(
        &self,
        request: Value,
        config: &llm_agent::config::LlmConfig,
        _cancel: CancellationToken,
        _deltas: tokio::sync::mpsc::Sender<String>,
    ) -> anyhow::Result<llm_agent::llm::Completion> {
        let estimate = llm_agent::context::count(&request, &config.model);
        let mut reply = self.replies.lock().unwrap().pop_front().unwrap_or_else(|| text("(끝난 대본)"));
        reply.usage = Some(llm_agent::llm::Usage { input: (estimate as f64 * self.ratio) as usize, output: 50, cached: None });
        Ok(reply)
    }
}

/// The room for a response's results follows the provider's count of the
/// request that asked for them, so the next request still fits. Needs no
/// MariaDB.
#[tokio::test]
async fn a_provider_count_above_the_estimate_still_leaves_room_for_the_results() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    let body: String = (1..=20000).map(|i| format!("line {i} {}\n", "word ".repeat(12))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    for (ratio, context, output, result, reads) in [(1.1, 16_000, 2_000, 6_000, 4), (1.02, 230_000, 16_384, 25_000, 10)] {
        let mut config = llm_agent::config::Config::default();
        config.mariadb.port = 9;
        config.llm.base_url = "http://127.0.0.1:9/v1".into();
        config.llm.model = "unknown-tokenizer".into();
        config.llm.context_tokens = context;
        config.llm.output_tokens = output;
        config.agent.result_tokens = Some(result);
        config.projects.push(llm_agent::config::Project {
            name: "app".into(),
            root: root.clone(),
            ..Default::default()
        });
        let batch = calls((0..reads).map(|i| call(&format!("r{i}"), "file_read", json!({"path":"big.txt","start_line":1 + i * 2000}))).collect());
        let llm = std::sync::Arc::new(Ratio { replies: std::sync::Mutex::new(vec![batch, text("끝")].into()), ratio });
        let (ratio_app, _ratio_dir) = app(config, llm);
        let (result, _) = ask(&ratio_app, "ratio", "큰 파일 봐줘", vec![]).await;
        assert_eq!(result.map(|a| a.answer).map_err(|e| e.to_string()), Ok("끝".to_owned()), "ratio {ratio}, context {context}");
    }
}

/// A model whose provider count of each request is the local estimate times
/// the next ratio of a list (a tokenizer that differs by request).
struct Ratios {
    replies: std::sync::Mutex<std::collections::VecDeque<llm_agent::llm::Completion>>,
    ratios: std::sync::Mutex<std::collections::VecDeque<f64>>,
    seen: std::sync::Mutex<Vec<(usize, f64)>>,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for Ratios {
    async fn complete(
        &self,
        request: Value,
        config: &llm_agent::config::LlmConfig,
        _cancel: CancellationToken,
        _deltas: tokio::sync::mpsc::Sender<String>,
    ) -> anyhow::Result<llm_agent::llm::Completion> {
        let estimate = llm_agent::context::count(&request, &config.model);
        let ratio = self.ratios.lock().unwrap().pop_front().unwrap_or(1.0);
        self.seen.lock().unwrap().push((estimate, ratio));
        let mut reply = self.replies.lock().unwrap().pop_front().unwrap_or_else(|| text("끝"));
        reply.usage = Some(llm_agent::llm::Usage { input: (estimate as f64 * ratio) as usize, output: 50, cached: None });
        Ok(reply)
    }
}

/// Random contexts, provider ratios and responses of large reads, searches
/// and long arguments: every question is answered, none ends because the
/// conversation outgrew the context. FIT_FUZZ sets the number of questions.
/// Needs no MariaDB.
#[tokio::test]
async fn random_responses_never_outgrow_the_context() {
    let runs: usize = std::env::var("FIT_FUZZ").ok().and_then(|n| n.parse().ok()).unwrap_or(6);
    let mut seed: u64 = 0xa9e7;
    let mut next = |n: usize| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((seed >> 33) as usize) % n.max(1)
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(root.join("src")).unwrap();
    let body: String = (1..=20000).map(|i| format!("line {i} {}\n", "word \"q\" ".repeat(8))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    let wide: String = (1..=400).map(|i| format!("{i} {}\n", "가나다 ".repeat(700))).collect();
    std::fs::write(root.join("wide.txt"), &wide).unwrap();
    for i in 0..40 {
        std::fs::write(root.join(format!("src/m{i}.rs")), format!("fn f{i}() {{ let needle = {i}; }}\n").repeat(200)).unwrap();
    }
    for run in 0..runs {
        let context = [32_000, 64_000, 128_000, 230_000][next(4)];
        let mut config = llm_agent::config::Config::default();
        config.mariadb.port = 9;
        config.llm.base_url = "http://127.0.0.1:9/v1".into();
        config.llm.model = "unknown-tokenizer".into();
        config.llm.context_tokens = context;
        config.llm.output_tokens = [2_000, 4_096, 16_384][next(3)].min(context / 4);
        if next(2) == 0 {
            let half = config.input_budget() / 2;
            config.agent.result_tokens = Some(200 + next(half - 200));
        }
        config.projects.push(llm_agent::config::Project {
            name: "app".into(),
            root: root.clone(),
            ..Default::default()
        });
        let mut script = vec![];
        for batch in 0..1 + next(4) {
            let mut calls_in_batch = vec![];
            // A response's arguments are model output: within its limit.
            let mut terms_left = config.llm.output_tokens / 6;
            for i in 0..1 + next(12) {
                let id = format!("b{batch}c{i}");
                calls_in_batch.push(match next(5) {
                    0 => call(&id, "file_read", json!({"path":"big.txt","start_line":1 + next(19000)})),
                    1 => call(&id, "file_read", json!({"path":"wide.txt","start_line":1 + next(300),"max_lines":1 + next(200)})),
                    2 => call(&id, "source_search", json!({"query":"needle","before":next(5),"after":next(5),"limit":100})),
                    3 => call(&id, "file_list", json!({"path_glob":"**/*","mode":"paths","limit":1000})),
                    _ => {
                        let terms = next(terms_left + 1);
                        terms_left -= terms;
                        call(&id, "source_search", json!({"query":(0..terms.max(1)).map(|k| format!("t{k} ")).collect::<String>()}))
                    }
                });
            }
            script.push(calls(calls_in_batch));
        }
        script.push(text("끝"));
        let ratios = (0..script.len()).map(|_| 0.7 + next(61) as f64 / 100.0).collect();
        let shape: Vec<Vec<(String, usize)>> = script
            .iter()
            .map(|c| c.calls.iter().map(|k| (k.name.clone(), k.arguments.len())).collect())
            .collect();
        let llm = std::sync::Arc::new(Ratios { replies: std::sync::Mutex::new(script.into()), ratios: std::sync::Mutex::new(ratios), seen: Default::default() });
        let summary = format!("output {} result {:?} input {}", config.llm.output_tokens, config.agent.result_tokens, config.input_budget());
        let (fuzz_app, _fuzz_dir) = app(config, llm.clone());
        let (result, _) = ask(&fuzz_app, &format!("fuzz{run}"), "큰 자료 봐줘", vec![]).await;
        let seen = llm.seen.lock().unwrap().clone();
        assert_eq!(result.map(|a| a.answer).map_err(|e| e.to_string()), Ok("끝".to_owned()), "run {run}, context {context}, {summary}, requests {seen:?}, script {shape:?}");
    }
}

/// An answer cut at the output limit is continued without tools, and its
/// pieces stay one assistant message, replaced by the whole answer at the
/// end. Needs no MariaDB.
#[tokio::test]
async fn a_cut_answer_is_continued_without_tools_as_one_message() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.txt"), "a\n").unwrap();
    let mut config = llm_agent::config::Config::default();
    config.mariadb.port = 9;
    config.llm.base_url = "http://127.0.0.1:9/v1".into();
    config.llm.model = "gpt-4o".into();
    config.projects.push(llm_agent::config::Project {
        name: "app".into(),
        root: root.clone(),
        ..Default::default()
    });
    let cut = |piece: &str| {
        let mut completion = text(piece);
        completion.length_limited = true;
        completion
    };
    let llm = Scripted::new(vec![
        cut("첫 조각 "),
        cut("둘째 조각 "),
        calls(vec![call("x", "file_list", json!({}))]),
        text("끝."),
        text("다음 답"),
    ]);
    let (cut_app, _cut_dir) = app(config, llm.clone());
    let (result, events) = ask(&cut_app, "cut", "길게 설명해줘", vec![]).await;
    assert_eq!(result.unwrap().answer, "첫 조각 둘째 조각 끝.");
    assert!(ev(&events, "tool").is_empty(), "no tool runs while an answer is continued");
    let requests = llm.requests();
    for request in &requests[1..4] {
        // Withheld, not dropped: the same definitions keep the prompt's prefix.
        assert_eq!(request["tool_choice"], "none", "continuing requests let no tool run");
        assert_eq!(request["tools"], requests[0]["tools"]);
        let roles: Vec<&str> = request["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert!(!roles.windows(2).any(|pair| pair == ["assistant", "assistant"]), "{roles:?}");
    }
    // The next question sees the whole answer once, not its pieces.
    let (result, _) = ask(&cut_app, "cut", "다음 질문", vec![]).await;
    assert_eq!(result.unwrap().answer, "다음 답");
    let next = llm.requests().last().unwrap().clone();
    let replies: Vec<String> = messages(&next, "assistant").iter().map(|m| m["content"].as_str().unwrap_or("").to_owned()).collect();
    assert_eq!(replies, vec!["첫 조각 둘째 조각 끝.".to_owned()]);
}

// Context management review (2026-10-16): each failed before its fix.

fn no_db(model: &str) -> llm_agent::config::Config {
    let mut config = llm_agent::config::Config::default();
    config.mariadb.port = 9;
    config.llm.base_url = "http://127.0.0.1:9/v1".into();
    config.llm.model = model.into();
    config
}

/// A: a length-limited piece followed by empty responses ends with the
/// piece as the answer, but the partial bundle stays too.
#[tokio::test]
async fn a_cut_answer_followed_by_empty_replies_is_kept_once() {
    let mut cut = text("첫 부분입니다.");
    cut.length_limited = true;
    let llm = Scripted::new(vec![cut, text(""), text(""), text(""), text("두 번째 답")]);
    let (app, _dir) = app(no_db("gpt-4o"), llm.clone());
    let (r, _) = ask(&app, "a", "질문1", vec![]).await;
    assert_eq!(r.unwrap().answer, "첫 부분입니다.");
    let (r, _) = ask(&app, "a", "질문2", vec![]).await;
    r.unwrap();
    let request = llm.requests().last().unwrap().clone();
    assert_eq!(messages(&request, "assistant").len(), 1, "one answer for the first question");
}

/// B: an archive the newest result points to is dropped by the byte prune
/// because active bundles count toward history_bytes.
#[tokio::test]
async fn an_archive_an_active_result_points_to_stays_readable() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(root.join("src")).unwrap();
    let body: String = (1..=3000).map(|i| format!("line {i} {}\n", "word ".repeat(12))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    for i in 0..600 {
        std::fs::write(root.join(format!("src/module_with_a_long_name_{i:04}.rs")), "fn x() {}\n").unwrap();
    }
    let mut config = no_db("gpt-4o");
    config.agent.result_tokens = Some(3_000);
    config.agent.history_bytes = 64 * 1024;
    config.projects.push(llm_agent::config::Project { name: "app".into(), root: root.clone(), ..Default::default() });
    let mut batch: Vec<_> = (0..6).map(|i| call(&format!("r{i}"), "file_read", json!({"path":"big.txt","start_line":1 + i * 400}))).collect();
    batch.push(call("l", "file_list", json!({"path_glob":"src/**","mode":"paths","limit":500})));
    let llm = Scripted::new(vec![
        calls(batch),
        calls(vec![call("h", "history", json!({"action":"read","id":2}))]),
        text("끝"),
    ]);
    let (app, _dir) = app(config, llm.clone());
    let (r, _) = ask(&app, "b", "파일 봐줘", vec![]).await;
    assert_eq!(r.unwrap().answer, "끝");
    let requests = llm.requests();
    let listed = tool_result(&requests[1], "l");
    assert_eq!(listed["archive_id"], 2);
    let read = tool_result(&requests[2], "h");
    assert_eq!(read["status"], "ok", "the archive the active result names is readable");
}

/// A provider whose count per model is `ratio` times the local estimate and
/// which rejects a request that does not fit its context.
struct PerModel {
    replies: std::sync::Mutex<std::collections::VecDeque<llm_agent::llm::Completion>>,
    seen: std::sync::Mutex<Vec<(String, usize, usize)>>,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for PerModel {
    async fn complete(&self, request: Value, config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let estimate = llm_agent::context::count(&request, &config.model);
        let ratio = if config.model == "model-a" { 0.6 } else { 1.0 };
        let input = (estimate as f64 * ratio) as usize;
        self.seen.lock().unwrap().push((config.model.clone(), estimate, input));
        if input + config.output_tokens > config.context_tokens {
            anyhow::bail!("context_length_exceeded: {input} + {} > {}", config.output_tokens, config.context_tokens);
        }
        let mut reply = self.replies.lock().unwrap().pop_front().unwrap_or_else(|| text("끝"));
        reply.usage = Some(llm_agent::llm::Usage { input, output: 50, cached: None });
        Ok(reply)
    }
}

/// C: the calibration of one model is applied to the next one.
#[tokio::test]
async fn a_model_change_starts_its_calibration_afresh() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    let body: String = (1..=20000).map(|i| format!("line {i} {}\n", "word ".repeat(12))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    let mut config = no_db("model-a");
    config.llm.context_tokens = 32_000;
    config.llm.output_tokens = 2_000;
    config.agent.result_tokens = Some(4_000);
    config.projects.push(llm_agent::config::Project { name: "app".into(), root: root.clone(), ..Default::default() });
    let mut script: Vec<_> = (0..7).map(|i| calls(vec![call(&format!("r{i}"), "file_read", json!({"path":"big.txt","start_line":1 + i * 1000}))])).collect();
    script.push(text("첫 답"));
    let llm = std::sync::Arc::new(PerModel { replies: std::sync::Mutex::new(script.into()), seen: Default::default() });
    let (app, _dir) = app(config, llm.clone());
    let (r, _) = ask(&app, "c", "큰 파일 봐줘", vec![]).await;
    assert_eq!(r.unwrap().answer, "첫 답");
    // The administrator switches the model.
    let mut next = (*app.config()).clone();
    next.llm.model = "model-b".into();
    app.store_config(next).unwrap();
    let mut failed = 0;
    for question in ["다음 질문", "다시 질문", "세 번째"] {
        let (r, _) = ask(&app, "c", question, vec![]).await;
        failed += usize::from(r.is_err());
    }
    assert_eq!(failed, 0, "the conversation keeps working after the model change");
}

/// D: the history tool gives the model the stored messages, not what
/// `model_message` shows: absolute root, offsets, internal flags.
#[tokio::test]
async fn history_reads_show_what_the_model_was_shown() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/a.rs"), "fn alpha() {}\nfn beta() {}\n").unwrap();
    std::fs::write(root.join("big.txt"), "긴 줄입니다 ".repeat(3000)).unwrap();
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 16_000;
    config.llm.output_tokens = 2_000;
    config.agent.result_tokens = Some(3_000);
    config.projects.push(llm_agent::config::Project { name: "app".into(), root: root.clone(), ..Default::default() });
    let mut script = vec![calls(vec![call("s1", "file_read", json!({"path":"src/a.rs"}))])];
    for i in 0..4 {
        script.push(calls(vec![call(&format!("b{i}"), "file_read", json!({"path":"big.txt","start_line":1,"max_lines":1,"force_read":true}))]));
    }
    // ids: 1-2 restored turns, 3 question, 4 the first read.
    script.push(calls(vec![call("h", "history", json!({"action":"read","id":4})), call("h2", "history", json!({"action":"read","id":1}))]));
    script.push(text("끝"));
    let llm = Scripted::new(script);
    let (app, _dir) = app(config, llm.clone());
    let restored = vec![("user".to_owned(), "이전 질문".to_owned()), ("assistant".to_owned(), "이전 답".to_owned())];
    let (r, _) = ask(&app, "d", "a.rs 봐줘", restored).await;
    assert_eq!(r.unwrap().answer, "끝");
    let requests = llm.requests();
    let first = tool_result(&requests[1], "s1");
    assert_eq!(first["data"]["path"], "src/a.rs", "the first read showed a relative path");
    let read = tool_result(requests.last().unwrap(), "h");
    let text = read["data"]["text"].as_str().unwrap_or_default().to_owned();
    let read1 = tool_result(requests.last().unwrap(), "h2");
    let root_text = root.canonicalize().unwrap().display().to_string();
    assert!(!text.contains(&root_text), "the project root reaches the model through history read");
    assert!(!read1["data"]["text"].as_str().unwrap_or_default().contains("restored"), "internal flags reach the model");
}

/// With two projects the model is told to name one; a call that omits it
/// still runs when its path exists in only one project. Needs no MariaDB.
#[tokio::test]
async fn an_omitted_project_is_taken_from_a_path_found_in_one_project() {
    let dir = tempfile::tempdir().unwrap();
    for (project, file, text) in [
        ("app", "src/search.rs", "const MAX_DIST: f64 = 0.4;\n"),
        ("app", "README.md", "app\n"),
        ("batch", "jobs/run.sh", "echo run\n"),
        ("batch", "README.md", "batch\n"),
    ] {
        let path = dir.path().join(project).join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    let mut config = llm_agent::config::Config::default();
    config.mariadb.port = 9;
    config.llm.base_url = "http://127.0.0.1:9/v1".into();
    config.llm.model = "gpt-4o".into();
    for name in ["app", "batch"] {
        config.projects.push(llm_agent::config::Project {
            name: name.into(),
            root: dir.path().join(name),
            ..Default::default()
        });
    }
    let llm = Scripted::new(vec![
        calls(vec![
            call("r1", "file_read", json!({"path":"jobs/run.sh"})),
            call("r2", "file_read", json!({"path":"README.md"})),
            call("r3", "source_search", json!({"query":"MAX_DIST"})),
        ]),
        text("끝"),
    ]);
    let (app, _dir) = app(config, llm.clone());
    let (result, _) = ask(&app, "projects", "배치 실행 스크립트 봐줘", vec![]).await;
    assert_eq!(result.unwrap().answer, "끝");

    let requests = llm.requests();
    let read = requests[0]["tools"].as_array().unwrap().iter().find(|t| t["function"]["name"] == "file_read").unwrap();
    assert_eq!(read["function"]["parameters"]["required"][0], "project");
    assert_eq!(read["function"]["parameters"]["properties"]["project"]["enum"], json!(["app", "batch"]));

    let found = tool_result(&requests[1], "r1");
    assert_eq!(found["status"], "ok", "{found}");
    assert!(found["data"]["content"]["numbered_text"].as_str().unwrap().starts_with("1|echo run"), "{found}");
    assert!(found["data"]["adjusted_arguments"][0].as_str().unwrap().contains("batch was used"), "{found}");
    let both = tool_result(&requests[1], "r2");
    assert!(both["error"].as_str().unwrap().contains("exists in app, batch"), "{both}");
    let search = tool_result(&requests[1], "r3");
    assert!(search["error"].as_str().unwrap().starts_with("project_required"), "{search}");
}

// Context management review, second pass (2026-10-16): each failed before
// its fix. Needs no MariaDB.

/// The runtime state a recorded request ends with.
fn state_of(request: &Value) -> Value {
    let users = messages(request, "user");
    let text = users.last().unwrap()["content"].as_str().unwrap();
    serde_json::from_str(text.split_once('\n').unwrap().1).unwrap()
}

fn cut_text(piece: &str) -> llm_agent::llm::Completion {
    let mut completion = text(piece);
    completion.length_limited = true;
    completion
}

/// A response cut at the output limit inside its tool calls.
fn cut_calls() -> llm_agent::llm::Completion {
    let mut completion = cut_text("");
    completion.discarded_tool_calls = true;
    completion
}

/// E: an answer cut in the final round was asked for a final answer instead
/// of its continuation, so the answer repeated its start.
#[tokio::test]
async fn a_cut_answer_in_the_final_round_is_continued() {
    let mut config = no_db("gpt-4o");
    // Every request is within the final reserve.
    config.agent.run_seconds = 45;
    let llm = Scripted::new(vec![cut_text("첫 조각 "), calls(vec![call("x", "file_list", json!({}))]), text("이어진 끝.")]);
    let (app, _dir) = app(config, llm.clone());
    let (r, _) = ask(&app, "e", "길게 설명해줘", vec![]).await;
    assert_eq!(r.unwrap().answer, "첫 조각 이어진 끝.");
    let requests = llm.requests();
    let continued = state_of(&requests[1]);
    assert!(continued["run_guidance"]["instruction"].as_str().unwrap().contains("끊긴 곳에서 바로 이어 써라"), "{continued}");
    let withheld = state_of(&requests[2]);
    assert!(withheld["run_guidance"]["notice"].as_str().unwrap().contains("이어 쓰는 중"), "{withheld}");
}

/// F: a response cut inside tool calls while tools were withheld was told to
/// make the calls again, and was never counted as a withheld response.
#[tokio::test]
async fn cut_tool_calls_while_tools_are_withheld_count_as_withheld() {
    let llm = Scripted::new(vec![cut_text("첫 조각 "), cut_calls(), cut_calls(), cut_calls(), text("쓰이지 않는 답")]);
    let (cut_app, _cut_dir) = app(no_db("gpt-4o"), llm.clone());
    let (r, _) = ask(&cut_app, "f", "길게 설명해줘", vec![]).await;
    assert_eq!(r.unwrap().answer, "첫 조각 ");
    let notice = state_of(&llm.requests()[2])["run_guidance"]["notice"].clone();
    assert!(notice.as_str().unwrap().contains("이어 쓰는 중"), "{notice}");
    // In the final round they end the question as other withheld calls do.
    let mut config = no_db("gpt-4o");
    config.agent.run_seconds = 45;
    let llm = Scripted::new(vec![cut_calls(), cut_calls(), cut_calls(), text("쓰이지 않는 답")]);
    let (final_app, _final_dir) = app(config, llm.clone());
    let (r, _) = ask(&final_app, "f2", "질문", vec![]).await;
    let error = r.err().expect("withheld calls end the question").to_string();
    assert!(error.contains("도구 호출을 반복"), "{error}");
    let notice = state_of(&llm.requests()[1])["run_guidance"]["notice"].clone();
    assert!(notice.as_str().unwrap().contains("도구를 더 쓸 수 없다"), "{notice}");
}

/// G: an answer cut at the output limit whose continuation no longer fits
/// the context failed the question, and what was written was lost.
#[tokio::test]
async fn a_cut_answer_that_cannot_be_continued_stands_as_written() {
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 12_000;
    config.llm.output_tokens = 4_000;
    let piece = "가나다 ".repeat(3_900);
    let llm = Scripted::new(vec![cut_text(&piece), text("이어진 끝")]);
    let (app, _dir) = app(config, llm.clone());
    let (r, _) = ask(&app, "g", &"자료 ".repeat(1_500), vec![]).await;
    assert_eq!(r.unwrap().answer, piece);
    assert_eq!(llm.requests().len(), 1);
}

/// H: a conversation the store already held with no question in it (its
/// first run was cancelled while it waited) ignored the browser's history.
#[tokio::test]
async fn a_conversation_held_without_a_question_is_restored() {
    let llm = Scripted::new(vec![text("답")]);
    let (app, _dir) = app(no_db("gpt-4o"), llm.clone());
    let claim = app.sessions.open("h", std::time::Duration::from_secs(60), 10, CancellationToken::new());
    app.sessions.finish("h", claim.run);
    let history = vec![("user".to_owned(), "이전 질문".to_owned()), ("assistant".to_owned(), "이전 답".to_owned())];
    let (r, _) = ask(&app, "h", "이어서", history).await;
    r.unwrap();
    assert_eq!(messages(&llm.requests()[0], "user")[0]["content"], "이전 질문");
}

/// I: the request that evicted bundles did not offer the history tool, so
/// the model could not read back what had just left its context.
#[tokio::test]
async fn the_request_that_evicts_offers_the_history_tool() {
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 16_000;
    config.llm.output_tokens = 2_000;
    let llm = Scripted::new(vec![text("답")]);
    let (app, _dir) = app(config, llm.clone());
    let big = "자료 ".repeat(3_000);
    let history: Vec<(String, String)> = [("user", big.as_str()), ("assistant", &big), ("user", &big), ("assistant", &big), ("user", "짧은 질문"), ("assistant", "짧은 답")]
        .into_iter()
        .map(|(role, text)| (role.to_owned(), text.to_owned()))
        .collect();
    let (r, _) = ask(&app, "i", "이어서", history).await;
    r.unwrap();
    let request = &llm.requests()[0];
    assert_eq!(messages(request, "user")[0]["content"], "짧은 질문", "the large turns left");
    let tools: Vec<&str> = request["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap()).collect();
    assert!(tools.contains(&"history"), "{tools:?}");
}

/// A provider whose real context is `limit` tokens: a longer request is
/// refused as OpenAI-compatible servers refuse it.
struct Refusing {
    limit: usize,
    replies: std::sync::Mutex<std::collections::VecDeque<llm_agent::llm::Completion>>,
    refused: std::sync::atomic::AtomicUsize,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for Refusing {
    async fn complete(&self, request: Value, config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let input = llm_agent::context::count(&request, &config.model);
        if input + config.output_tokens > self.limit {
            self.refused.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            anyhow::bail!(
                "http_400: {}",
                json!({"error":{"message":format!("This model's maximum context length is {} tokens. However, your messages resulted in {input} tokens.", self.limit),"code":"context_length_exceeded"}})
            );
        }
        Ok(self.replies.lock().unwrap().pop_front().unwrap_or_else(|| text("끝")))
    }
}

/// J: a provider that refused a request as longer than its context (a model
/// served with less context than configured) failed the question, and as
/// nothing then left the context, every later question the same way.
#[tokio::test]
async fn a_request_the_provider_finds_too_long_runs_again_with_old_bundles_evicted() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    let body: String = (1..=8000).map(|i| format!("line {i} {}\n", "word ".repeat(12))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 64_000;
    config.llm.output_tokens = 2_000;
    config.agent.result_tokens = Some(6_000);
    config.projects.push(llm_agent::config::Project { name: "app".into(), root: root.clone(), ..Default::default() });
    let mut script: Vec<_> = (0..4).map(|i| calls(vec![call(&format!("r{i}"), "file_read", json!({"path":"big.txt","start_line":1 + i * 1000}))])).collect();
    script.push(text("첫 답"));
    script.push(text("둘째 답"));
    let llm = std::sync::Arc::new(Refusing { limit: 26_000, replies: std::sync::Mutex::new(script.into()), refused: Default::default() });
    let (app, _dir) = app(config, llm.clone());
    let (r, _) = ask(&app, "j", "큰 파일 봐줘", vec![]).await;
    assert_eq!(r.unwrap().answer, "첫 답");
    assert!(llm.refused.load(std::sync::atomic::Ordering::Relaxed) > 0, "the provider refused a request");
    let (r, _) = ask(&app, "j", "다음 질문", vec![]).await;
    assert_eq!(r.unwrap().answer, "둘째 답");
}

/// Streams the start of an answer, then the user stops it.
struct StoppedMidAnswer {
    stop: CancellationToken,
    requests: std::sync::Mutex<Vec<Value>>,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for StoppedMidAnswer {
    async fn complete(&self, request: Value, _config: &llm_agent::config::LlmConfig, cancel: CancellationToken, delta: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let first = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request);
            requests.len() == 1
        };
        if !first {
            return Ok(text("이어서 답합니다."));
        }
        // A whole opening line: before anything is looked up, the line is
        // held until it ends (the general-knowledge line guard).
        for part in ["배치 상태는 ", "다음 표와 같습니다.\n"] {
            let _ = delta.send(part.to_owned()).await;
        }
        // The user stops once it is on the screen (nothing sent after a stop
        // reaches the browser).
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        self.stop.cancel();
        cancel.cancelled().await;
        anyhow::bail!("cancelled")
    }
}

/// K: an answer the user stopped mid-way was dropped from the conversation,
/// while the browser keeps what it showed for the next question.
#[tokio::test]
async fn what_a_stopped_answer_showed_stays_in_the_conversation() {
    let stop = CancellationToken::new();
    let llm = std::sync::Arc::new(StoppedMidAnswer { stop: stop.clone(), requests: Default::default() });
    let (app, _dir) = app(no_db("gpt-4o"), llm.clone());
    let question = |message: &str| Question { conversation_id: "k".into(), message: message.into(), history: vec![] };
    let stopped = agent::answer(&app, question("배치 상태 알려줘"), Events::new(None), stop).await;
    assert!(stopped.is_err());
    let answered = agent::answer(&app, question("계속해줘"), Events::new(None), CancellationToken::new()).await;
    assert_eq!(answered.map(|a| a.answer).map_err(|e| e.to_string()), Ok("이어서 답합니다.".to_owned()));
    let next = llm.requests.lock().unwrap()[1].clone();
    let replies: Vec<Value> = messages(&next, "assistant").iter().map(|m| m["content"].clone()).collect();
    assert_eq!(replies, vec![json!("배치 상태는 다음 표와 같습니다.\n")]);
}

/// A model answering at random: tool calls (history ones too), answers cut
/// at the output limit, cut tool calls, empty replies and answers, against
/// a provider whose real context may be smaller than the configured one.
struct RandomModel {
    seed: std::sync::Mutex<u64>,
    real_limit: usize,
    ratio: f64,
    rounds: std::sync::Mutex<usize>,
    next_call: std::sync::Mutex<usize>,
    requests: std::sync::Mutex<Vec<(Value, bool)>>,
}
impl RandomModel {
    fn next(&self, n: usize) -> usize {
        let mut seed = self.seed.lock().unwrap();
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 33) as usize) % n.max(1)
    }
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for RandomModel {
    async fn complete(&self, request: Value, config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let input = (llm_agent::context::count(&request, &config.model) as f64 * self.ratio) as usize;
        let accepted = input + config.output_tokens <= self.real_limit;
        self.requests.lock().unwrap().push((request, accepted));
        if !accepted {
            anyhow::bail!("http_400: {}", json!({"error":{"message":format!("This model's maximum context length is {} tokens.", self.real_limit),"code":"context_length_exceeded"}}));
        }
        let rounds = {
            let mut rounds = self.rounds.lock().unwrap();
            *rounds += 1;
            *rounds
        };
        let mut out = text("");
        out.usage = Some(llm_agent::llm::Usage { input, output: 50, cached: None });
        match if rounds > 8 { 99 } else { self.next(100) } {
            0..=39 => {
                for _ in 0..1 + self.next(4) {
                    let id = {
                        let mut next = self.next_call.lock().unwrap();
                        *next += 1;
                        format!("c{next}")
                    };
                    out.calls.push(match self.next(5) {
                        0 => call(&id, "file_read", json!({"path":"big.txt","start_line":1 + self.next(7000)})),
                        1 => call(&id, "source_search", json!({"query":"needle","limit":100})),
                        2 => call(&id, "file_list", json!({"path_glob":"**/*","mode":"paths","limit":500})),
                        3 => {
                            let query = ["needle", "word", "\"q\""][self.next(3)];
                            call(&id, "history", json!({"action":"search","query":query}))
                        }
                        _ => call(&id, "history", json!({"action":"read","id":1 + self.next(40)})),
                    });
                }
            }
            40..=54 => {
                out.text = format!("조각{} {}", self.next(1000), "가나다 ".repeat(self.next(config.output_tokens.min(3000))));
                out.length_limited = true;
            }
            55..=64 => {
                out.length_limited = true;
                out.discarded_tool_calls = true;
            }
            65..=69 => {}
            _ => {
                out.text = format!("답{}", self.next(1000));
                *self.rounds.lock().unwrap() = 0;
            }
        }
        Ok(out)
    }
}

/// Random conversations of three questions keep every request in shape and
/// within the context, and end every question with an answer or a message
/// the user may see. CTX_FUZZ sets the number of conversations. Needs no
/// MariaDB.
#[tokio::test]
async fn random_conversations_keep_every_request_in_shape() {
    let runs: usize = std::env::var("CTX_FUZZ").ok().and_then(|n| n.parse().ok()).unwrap_or(12);
    let mut seed: u64 = 0x5eed;
    let mut next = |n: usize| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((seed >> 33) as usize) % n.max(1)
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(root.join("src")).unwrap();
    let body: String = (1..=8000).map(|i| format!("line {i} {}\n", "word \"q\" ".repeat(8))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    for i in 0..40 {
        std::fs::write(root.join(format!("src/m{i}.rs")), format!("fn f{i}() {{ let needle = {i}; }}\n").repeat(100)).unwrap();
    }
    for run in 0..runs {
        let mut config = no_db(["gpt-4o", "unknown-tokenizer"][next(2)]);
        let context = [24_000, 32_000, 64_000, 128_000][next(4)];
        config.llm.context_tokens = context;
        config.llm.output_tokens = [2_000, 4_000][next(2)];
        config.projects.push(llm_agent::config::Project { name: "app".into(), root: root.clone(), ..Default::default() });
        // Now and then a history small enough for prune to drop bundles.
        if next(2) == 0 {
            config.agent.history_bytes = 64 * 1024;
        }
        let real_limit = if next(3) == 0 { context * (60 + next(40)) / 100 } else { context * 2 };
        let ratio = if config.llm.model == "gpt-4o" { 1.0 } else { 0.8 + next(40) as f64 / 100.0 };
        let llm = std::sync::Arc::new(RandomModel {
            seed: std::sync::Mutex::new(next(1 << 30) as u64 + 1),
            real_limit,
            ratio,
            rounds: Default::default(),
            next_call: Default::default(),
            requests: Default::default(),
        });
        let (fuzz_app, _fuzz_dir) = app(config.clone(), llm.clone());
        let turns: Vec<(String, String)> = (0..next(7)).map(|i| (["user", "assistant"][i % 2].to_owned(), "이전 대화 ".repeat(next(3000)))).collect();
        for q in 0..3 {
            let before = llm.requests.lock().unwrap().len();
            let message = format!("질문 {q} {}", "자료 ".repeat(next(800)));
            let (result, _) = ask(&fuzz_app, &format!("shape{run}"), &message, turns.clone()).await;
            let requests = llm.requests.lock().unwrap().clone();
            for (i, (request, accepted)) in requests.iter().enumerate().skip(before) {
                if let Err(broken) = request_shape(request) {
                    panic!("run {run} question {q} request {i}: {broken}");
                }
                // What the provider counts, once a usage sample calibrated the estimate.
                let input = (llm_agent::context::count(request, &config.llm.model) as f64 * ratio) as usize;
                assert!(!accepted || i == 0 || input + config.llm.output_tokens <= context, "run {run} request {i}: {input} tokens past the context {context}");
            }
            if let Err(error) = result {
                assert!(error.downcast_ref::<agent::UserFacing>().is_some(), "run {run} question {q}: {error:#}");
            }
            let id = format!("shape{run}");
            let claim = fuzz_app.sessions.open(&id, std::time::Duration::from_secs(60), 10, CancellationToken::new());
            let kept = continuations_kept(&claim.conversation.lock().await.history);
            fuzz_app.sessions.finish(&id, claim.run);
            if let Err(lost) = kept {
                panic!("run {run} question {q}: {lost}");
            }
        }
    }
}

// Context management review, third pass (2026-10-16): each failed before its
// fix. Needs no MariaDB.

/// The preview the browser shows from the events it got: `answer_delta`
/// appends, `answer_reset` clears (frontend/src/App.jsx).
fn preview(events: &[Value]) -> String {
    let mut shown = String::new();
    for event in events {
        match event["type"].as_str() {
            Some("answer_delta") => shown.push_str(event["text"].as_str().unwrap()),
            Some("answer_reset") => shown.clear(),
            _ => {}
        }
    }
    shown
}

/// L: the piece of an answer cut at the output limit was taken back from the
/// preview when its continuation began, so the screen showed the answer from
/// mid-sentence on, and a stop kept only the last piece.
#[tokio::test]
async fn a_continued_answer_keeps_its_pieces_in_the_preview() {
    let mut calls_and_text = calls(vec![call("w", "file_list", json!({}))]);
    calls_and_text.text = "도구를 쓰겠다 ".into();
    let llm = Scripted::new(vec![cut_text("첫 조각 "), calls_and_text, text("이어진 끝.")]);
    let (app, _dir) = app(no_db("gpt-4o"), llm.clone());
    let (r, events) = ask(&app, "l", "길게 설명해줘", vec![]).await;
    assert_eq!(r.unwrap().answer, "첫 조각 이어진 끝.");
    // The withheld response's own text is taken back, the piece shown again.
    assert_eq!(preview(&events), "첫 조각 이어진 끝.", "{events:?}");
}

/// A model whose second request (continuing a cut answer) fails: it outlives
/// the question's time, or the provider refuses it.
struct FailingContinuation {
    calls: std::sync::atomic::AtomicUsize,
    slow: bool,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for FailingContinuation {
    async fn complete(&self, _request: Value, _config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        match self.calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed) {
            0 => Ok(cut_text("쓴 앞부분 ")),
            1 if self.slow => {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                Ok(text("늦은 끝"))
            }
            1 => anyhow::bail!("http_400: {}", json!({"error":{"message":"Invalid request"}})),
            _ => Ok(text("다음 답")),
        }
    }
}

/// M: an answer cut at the output limit whose continuation ran out of time
/// or failed at the provider ended the question with an error, though its
/// first piece was written (and stayed in the conversation as an answer the
/// user never got).
#[tokio::test]
async fn a_cut_answer_whose_continuation_fails_stands_as_written() {
    for slow in [true, false] {
        let mut config = no_db("gpt-4o");
        config.agent.run_seconds = 2;
        let llm = std::sync::Arc::new(FailingContinuation { calls: Default::default(), slow });
        let (app, _dir) = app(config, llm.clone());
        let (r, _) = ask(&app, "m", "길게 설명해줘", vec![]).await;
        assert_eq!(r.map(|a| a.answer).map_err(|e| e.to_string()), Ok("쓴 앞부분 ".to_owned()), "slow {slow}");
    }
}

/// N: a question too long by itself was told to start a new conversation,
/// where it fails the same way.
#[tokio::test]
async fn a_question_too_long_by_itself_is_told_so() {
    let question = "자료 ".repeat(6_000);
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 12_000;
    config.llm.output_tokens = 4_000;
    let (small, _small_dir) = app(config, Scripted::new(vec![text("답")]));
    let (r, _) = ask(&small, "n", &question, vec![]).await;
    let error = r.err().expect("too long").to_string();
    assert!(error.contains("질문이 너무 길어"), "{error}");
    // A provider serving less context than configured refuses it as well.
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 64_000;
    config.llm.output_tokens = 2_000;
    let llm = std::sync::Arc::new(Refusing { limit: 9_000, replies: Default::default(), refused: Default::default() });
    let (refusing, _refusing_dir) = app(config, llm.clone());
    let (r, _) = ask(&refusing, "n2", &question, vec![]).await;
    let error = r.err().expect("refused").to_string();
    assert!(error.contains("질문이 너무 길어"), "{error}");
    // Long turns before a short question leave the context instead.
    let (r, _) = ask(&refusing, "n3", "짧은 질문", vec![("user".into(), question.clone()), ("assistant".into(), question.clone())]).await;
    assert_eq!(r.unwrap().answer, "끝");
    // A context too small for the system prompt and tools fits no question.
    let mut config = no_db("unknown-tokenizer");
    config.llm.context_tokens = 6_000;
    config.llm.output_tokens = 500;
    let (tiny, _tiny_dir) = app(config, Scripted::new(vec![text("답")]));
    let (r, _) = ask(&tiny, "n4", "안녕", vec![]).await;
    let error = r.err().expect("nothing fits").to_string();
    assert!(error.contains("컨텍스트 설정이 너무 작아"), "{error}");
}

/// The browser's end of a stream the user stops: it reads events until the
/// stop, then closes the stream (web.rs cancels the run when it sees that),
/// so what is sent after the stop never reaches it.
#[derive(Default)]
struct Browser {
    stream: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<Value>>>,
    seen: std::sync::Mutex<Vec<Value>>,
}
impl Browser {
    fn events(&self) -> Events {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        *self.stream.lock().unwrap() = Some(rx);
        Events::new(Some(tx))
    }
    /// What arrived so far; the stream is closed from here on.
    fn close(&self) {
        if let Some(mut stream) = self.stream.lock().unwrap().take() {
            let mut seen = self.seen.lock().unwrap();
            while let Ok(event) = stream.try_recv() {
                seen.push(event);
            }
        }
    }
    fn seen(&self) -> Vec<Value> {
        self.close();
        self.seen.lock().unwrap().clone()
    }
}

/// A model answering at random until the user stops it mid-stream: cut
/// answer pieces, tool calls with text before them, cut tool calls, empty
/// replies.
struct StoppedAtRandom {
    seed: std::sync::Mutex<u64>,
    stop_at: usize,
    calls: std::sync::atomic::AtomicUsize,
    stop: CancellationToken,
    browser: std::sync::Arc<Browser>,
}
impl StoppedAtRandom {
    fn next(&self, n: usize) -> usize {
        let mut seed = self.seed.lock().unwrap();
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 33) as usize) % n.max(1)
    }
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for StoppedAtRandom {
    async fn complete(&self, _request: Value, _config: &llm_agent::config::LlmConfig, cancel: CancellationToken, delta: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let n = self.calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if n > self.stop_at {
            return Ok(text("다음 답"));
        }
        let mut out = text("");
        out.text = match self.next(6) {
            0 => format!("조각{n} "),
            1 | 2 => format!("도구 전 글{n} "),
            3 => " ".into(),
            // Held unseen before a search (the general-knowledge line).
            4 => format!("*등록된 지식에 없는 내용이라 조각{n} "),
            _ => String::new(),
        };
        if n == self.stop_at {
            // Part of the response streams, then the user stops.
            let shown: String = out.text.chars().take(self.next(out.text.chars().count() + 1)).collect();
            if !shown.is_empty() {
                let _ = delta.send(shown).await;
            }
            // The user stops once it is on the screen.
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            self.browser.close();
            self.stop.cancel();
            cancel.cancelled().await;
            anyhow::bail!("cancelled");
        }
        if !out.text.is_empty() {
            let _ = delta.send(out.text.clone()).await;
        }
        match self.next(4) {
            0 => out.length_limited = true,
            1 => out.calls.push(call(&format!("c{n}"), "nope", json!({}))),
            2 => {
                out.length_limited = true;
                out.discarded_tool_calls = true;
            }
            _ => out.text = if out.text.starts_with("조각") || out.text.starts_with('*') { out.text } else { String::new() },
        }
        if !out.length_limited && out.calls.is_empty() && !out.text.trim().is_empty() {
            // An answer piece not cut is the answer: keep the question going.
            out.length_limited = true;
        }
        Ok(out)
    }
}

/// O: what a stopped answer leaves in the conversation is what the browser
/// showed and keeps for the next question (fix 8 of the second pass held only
/// while no answer piece had been cut). STOP_FUZZ sets the number of stops.
#[tokio::test]
async fn a_stop_leaves_in_the_conversation_what_the_browser_showed() {
    let runs: usize = std::env::var("STOP_FUZZ").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
    let mut checked = 0;
    for run in 0..runs {
        let stop = CancellationToken::new();
        let browser = std::sync::Arc::new(Browser::default());
        let llm = std::sync::Arc::new(StoppedAtRandom {
            seed: std::sync::Mutex::new(run as u64 * 7919 + 1),
            stop_at: run % 6,
            calls: Default::default(),
            stop: stop.clone(),
            browser: browser.clone(),
        });
        let (app, _dir) = app(no_db("gpt-4o"), llm.clone());
        let question = Question { conversation_id: "o".into(), message: "질문".into(), history: vec![] };
        let stopped = agent::answer(&app, question, browser.events(), stop).await;
        let events = browser.seen();
        if stopped.is_ok() || llm.calls.load(std::sync::atomic::Ordering::Relaxed) <= llm.stop_at {
            continue; // answered or failed before the stop
        }
        checked += 1;
        let shown = preview(&events);
        let (r, _) = ask(&app, "o", "다음", vec![]).await;
        assert_eq!(r.unwrap().answer, "다음 답");
        // The conversation now ends: what the stop left, the next question, its answer.
        let claim = app.sessions.open("o", std::time::Duration::from_secs(60), 10, CancellationToken::new());
        let active = claim.conversation.lock().await.history.active();
        let before = &active[active.len() - 3];
        if shown.trim().is_empty() {
            assert!(before["role"] != "assistant" || before["tool_calls"].is_array(), "run {run}: nothing was shown, yet {before} stayed; events {events:?}");
        } else {
            assert_eq!(before["content"].as_str(), Some(shown.as_str()), "run {run}: events {events:?}");
        }
    }
    assert!(checked > runs / 4, "only {checked} runs reached their stop");
}

// Follow-ups to the third pass (2026-10-16): the provider's prefix cache and
// the question's time. Each failed before its fix. Needs no MariaDB.

/// One scripted response: text streamed before waiting (or none), how long
/// the response takes, and the response.
type Step = (&'static str, u64, llm_agent::llm::Completion);

/// A model that takes its time, recording every request.
struct Timed {
    steps: std::sync::Mutex<std::collections::VecDeque<Step>>,
    requests: std::sync::Mutex<Vec<Value>>,
}
impl Timed {
    fn new(steps: Vec<Step>) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self { steps: std::sync::Mutex::new(steps.into()), requests: Default::default() })
    }
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for Timed {
    async fn complete(&self, request: Value, _config: &llm_agent::config::LlmConfig, _c: CancellationToken, delta: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        self.requests.lock().unwrap().push(request);
        let (first, ms, reply) = self.steps.lock().unwrap().pop_front().unwrap_or(("", 0, text("(script exhausted)")));
        if !first.is_empty() {
            let _ = delta.send(first.to_owned()).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        Ok(reply)
    }
}

/// P: the final answer's request (and a continuation's) dropped the tool
/// definitions, which open the prompt, so nothing of the provider's prefix
/// cache was left for it.
#[tokio::test]
async fn the_final_request_keeps_the_tools_and_withholds_them() {
    let mut config = no_db("gpt-4o");
    config.agent.run_seconds = 47;
    // The first request is stopped at the reserve, two seconds in.
    let llm = Timed::new(vec![("", 10_000, text("늦은 답")), ("", 0, text("마지막 답"))]);
    let (app, _dir) = app(config, llm.clone());
    let (r, _) = ask(&app, "p", "질문", vec![]).await;
    assert_eq!(r.unwrap().answer, "마지막 답");
    let requests = llm.requests.lock().unwrap().clone();
    assert!(requests[0].get("tool_choice").is_none());
    assert_eq!(requests[1]["tools"], requests[0]["tools"], "the same definitions");
    assert_eq!(requests[1]["tool_choice"], "none");
    let state = state_of(&requests[1]);
    assert!(state["run_guidance"]["instruction"].as_str().unwrap().contains("도구를 더 쓸 수 없다"), "{state}");
    assert!(state.get("projects").is_none());
}

/// Q: a request that had not begun its answer when the final reserve came
/// ran on into it, so the question could end with no final answer; one
/// writing its answer goes on.
#[tokio::test]
async fn work_before_the_final_reserve_stops_at_it() {
    let mut config = no_db("gpt-4o");
    config.agent.run_seconds = 47;
    let started = std::time::Instant::now();
    let llm = Timed::new(vec![("", 10_000, text("늦은 답")), ("", 0, text("마지막 답"))]);
    let (silent, _silent_dir) = app(config.clone(), llm.clone());
    let (r, _) = ask(&silent, "q", "질문", vec![]).await;
    assert_eq!(r.unwrap().answer, "마지막 답");
    assert!(started.elapsed() < std::time::Duration::from_secs(8), "{:?}", started.elapsed());
    let notice = state_of(&llm.requests.lock().unwrap()[1])["run_guidance"]["notice"].clone();
    assert!(notice.as_str().unwrap().contains("남은 시간이 모자라"), "{notice}");
    // An answer being written when the reserve comes is not stopped.
    let llm = Timed::new(vec![("이미 쓰는 ", 3_000, text("이미 쓰는 답"))]);
    let (writing, _writing_dir) = app(config.clone(), llm.clone());
    let (r, _) = ask(&writing, "q2", "질문", vec![]).await;
    assert_eq!(r.unwrap().answer, "이미 쓰는 답");
    assert_eq!(llm.requests.lock().unwrap().len(), 1);
    // Tool calls stop at the reserve too, and the final request says so.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
    config.projects.push(llm_agent::config::Project { name: "app".into(), root: dir.path().into(), ..Default::default() });
    let mut late_calls = calls(vec![call("t1", "file_list", json!({}))]);
    late_calls.text = "찾아보겠다 ".into();
    let llm = Timed::new(vec![("찾아보겠다 ", 3_000, late_calls), ("", 0, text("확인하지 못했다"))]);
    let (tools, _tools_dir) = app(config, llm.clone());
    let (r, _) = ask(&tools, "q3", "질문", vec![]).await;
    assert_eq!(r.unwrap().answer, "확인하지 못했다");
    let requests = llm.requests.lock().unwrap().clone();
    assert_eq!(tool_result(&requests[1], "t1")["status"], "cancelled");
    let notice = state_of(&requests[1])["run_guidance"]["notice"].clone();
    assert!(notice.as_str().unwrap().contains("도구 실행 일부를 멈췄다"), "{notice}");
}

/// R: a model request that outlived the question's time ended with the
/// generic server error instead of the time-over message.
#[tokio::test]
async fn a_request_past_the_questions_time_says_the_time_ran_out() {
    let mut config = no_db("gpt-4o");
    config.agent.run_seconds = 2;
    let llm = Timed::new(vec![("", 5_000, text("늦은 답"))]);
    let (app, _dir) = app(config, llm.clone());
    let (r, _) = ask(&app, "r", "질문", vec![]).await;
    let error = r.err().expect("time ran out");
    assert!(error.downcast_ref::<agent::UserFacing>().is_some(), "{error:#}");
    assert!(error.to_string().contains("답변 시간이 다 되어"), "{error}");
}

// Context management review, fourth pass (2026-10-16): each failed before its
// fix. Needs no MariaDB.

/// A provider that leaves withheld tools out of the request (as the client
/// does for one that refuses or ignores tool_choice "none") and reports the
/// size of what it was sent.
struct DropsWithheldTools {
    replies: std::sync::Mutex<std::collections::VecDeque<llm_agent::llm::Completion>>,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for DropsWithheldTools {
    async fn complete(&self, request: Value, config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let mut sent = request.clone();
        let dropped = sent["tool_choice"] == "none";
        if dropped {
            let fields = sent.as_object_mut().unwrap();
            fields.remove("tools");
            fields.remove("tool_choice");
        }
        let input = llm_agent::context::count(&sent, &config.model);
        let mut reply = self.replies.lock().unwrap().pop_front().unwrap_or_else(|| text("끝"));
        reply.usage = Some(llm_agent::llm::Usage { input, output: 50, cached: None });
        reply.tools_dropped = dropped;
        Ok(reply)
    }
}

/// S: a request whose withheld tools the provider was sent without was
/// calibrated against the estimate with them: the provider seemed to count
/// less than the estimate by the size of the tool definitions.
#[tokio::test]
async fn a_request_sent_without_its_withheld_tools_is_calibrated_as_sent() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.txt"), "a\n").unwrap();
    let mut config = no_db("unknown-tokenizer");
    config.projects.push(llm_agent::config::Project { name: "app".into(), root: dir.path().into(), ..Default::default() });
    let replies = vec![cut_text(&"첫 조각 ".repeat(200)), text("이어진 끝.")];
    let llm = std::sync::Arc::new(DropsWithheldTools { replies: std::sync::Mutex::new(replies.into()) });
    let (app, _dir) = app(config, llm);
    let (r, _) = ask(&app, "s", "길게 설명해줘", vec![]).await;
    assert!(r.unwrap().answer.ends_with("이어진 끝."));
    let claim = app.sessions.open("s", std::time::Duration::from_secs(60), 10, CancellationToken::new());
    let ratios: Vec<f64> = claim.conversation.lock().await.token_ratios.iter().copied().collect();
    assert_eq!(ratios.len(), 2, "{ratios:?}");
    assert!(ratios.iter().all(|r| (r - 1.0).abs() < 0.01), "the provider counted what it was sent: {ratios:?}");
}

/// T: a continuation that had shown text when it failed (its time ran out)
/// stands as written, that text included, but the preview took the text
/// back first: answer_reset for text the answer keeps.
#[tokio::test]
async fn a_failed_continuation_keeps_in_the_preview_what_the_answer_keeps() {
    let mut config = no_db("gpt-4o");
    config.agent.run_seconds = 2;
    let llm = Timed::new(vec![("쓴 앞부분 ", 0, cut_text("쓴 앞부분 ")), ("이어 쓰던 ", 5_000, text("늦은 끝"))]);
    let (app, _dir) = app(config, llm.clone());
    let (r, events) = ask(&app, "t", "길게 설명해줘", vec![]).await;
    let answer = r.map(|a| a.answer).map_err(|e| e.to_string());
    assert_eq!(answer, Ok("쓴 앞부분 이어 쓰던 ".to_owned()));
    assert_eq!(preview(&events), "쓴 앞부분 이어 쓰던 ", "{events:?}");
    assert!(ev(&events, "answer_reset").is_empty(), "{events:?}");
}

// The general-knowledge line before any search (2026-10-16): the model took a
// registered subject for general knowledge and said it was not registered
// without searching. Needs no MariaDB.

const GENERAL_LINE: &str = "*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*\n일론 머스크는 기업가입니다.";

/// U: the line before any search is stopped unseen and the model asked to
/// search; a follow-up on the same subject keeps the line without searching.
#[tokio::test]
async fn the_general_knowledge_line_before_any_search_asks_for_a_search() {
    let llm = Scripted::new(vec![
        text(GENERAL_LINE),
        calls(vec![call("s1", "search", json!({"query":"일론 머스크"}))]),
        text(GENERAL_LINE),
        text("*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*\n쉽게 말하면 사업가입니다."),
    ]);
    let (app, _dir) = app(no_db("gpt-4o"), llm.clone());
    let (r, events) = ask(&app, "u", "일론 머스크가 누구야?", vec![]).await;
    let answer = r.unwrap();
    assert_eq!(answer.answer, GENERAL_LINE);
    let requests = llm.requests();
    assert_eq!(requests.len(), 3);
    let notice = state_of(&requests[1])["run_guidance"]["notice"].clone();
    assert!(notice.as_str().unwrap().contains("먼저 search로 찾아라"), "{notice}");
    // The refused line was never shown, nor kept in the conversation.
    assert!(ev(&events, "answer_reset").is_empty(), "{events:?}");
    assert_eq!(preview(&events), GENERAL_LINE);
    assert!(messages(&requests[1], "assistant").is_empty());
    assert_eq!(answer.log["searchFirst"], true);
    assert_eq!(answer.log["search"]["searches"], 1);
    let (r, _) = ask(&app, "u", "더 쉽게 설명해줘", vec![]).await;
    assert!(r.unwrap().answer.contains("사업가"));
    assert_eq!(llm.requests().len(), 4, "the follow-up was not asked to search");
}

/// V: the line is refused once per question, found after a title and in
/// other words, and left alone where no search can follow (the final
/// request) or no line is said.
#[tokio::test]
async fn the_search_first_guard_asks_once_and_spares_other_answers() {
    // After a title and in other words it is held unseen too: asked once,
    // and the second time it stands.
    let late = "### 답변\n\n등록된 자료에서 찾을 수 없어 일반 지식으로 답합니다. 쿠버네티스는 컨테이너 오케스트레이션입니다.";
    let llm = Scripted::new(vec![text(late), text(late)]);
    let (late_app, _late_dir) = app(no_db("gpt-4o"), llm.clone());
    let (r, events) = ask(&late_app, "v", "쿠버네티스가 뭐야?", vec![]).await;
    assert_eq!(r.unwrap().answer, late);
    assert_eq!(llm.requests().len(), 2);
    assert!(ev(&events, "answer_reset").is_empty(), "{events:?}");
    assert_eq!(preview(&events), late);
    // Ordinary answers, held for their first line only, stream whole.
    for (n, ordinary) in ["**요약**\n배치는 정상입니다.", "등록된 쿼리로 확인한 결과 정상입니다.", "안녕하세요!"].into_iter().enumerate() {
        let llm = Scripted::new(vec![text(ordinary)]);
        let (ordinary_app, _ordinary_dir) = app(no_db("gpt-4o"), llm.clone());
        let (r, events) = ask(&ordinary_app, &format!("v{n}"), "질문", vec![]).await;
        assert_eq!(r.unwrap().answer, ordinary);
        assert_eq!((llm.requests().len(), preview(&events)), (1, ordinary.to_owned()));
        assert!(ev(&events, "answer_reset").is_empty(), "{events:?}");
    }
    // In the final request no search can follow: the line stands.
    let mut config = no_db("gpt-4o");
    config.agent.run_seconds = 45;
    let llm = Scripted::new(vec![text(GENERAL_LINE)]);
    let (final_app, _final_dir) = app(config, llm.clone());
    let (r, events) = ask(&final_app, "v-final", "일론 머스크가 누구야?", vec![]).await;
    let answer = r.unwrap();
    assert_eq!((answer.answer.as_str(), llm.requests().len()), (GENERAL_LINE, 1));
    assert_eq!(preview(&events), GENERAL_LINE);
    assert!(answer.log.get("searchFirst").is_none());
}

/// W: the rest of a refused line is not generated: the request stops as soon
/// as its held start is the line, with nothing shown.
#[tokio::test]
async fn a_refused_line_stops_its_request_at_its_start() {
    let llm = Timed::new(vec![("*등록된 지식에 없는 내용이라 ", 10_000, text(GENERAL_LINE)), ("찾아보니 기업가입니다.", 0, text("찾아보니 기업가입니다."))]);
    let (app, _dir) = app(no_db("gpt-4o"), llm.clone());
    let started = std::time::Instant::now();
    let (r, events) = ask(&app, "w", "일론 머스크가 누구야?", vec![]).await;
    assert_eq!(r.unwrap().answer, "찾아보니 기업가입니다.");
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
    assert_eq!(preview(&events), "찾아보니 기업가입니다.");
    assert!(ev(&events, "answer_reset").is_empty(), "{events:?}");
}

/// 2026-10-18: an answer describing this project quoted the line from the
/// README's examples near its end. Judged on the whole answer, it was taken
/// back after it had streamed in full and written again — and a second time
/// the model wrote only empty replies, ending the question in an error. Only
/// the opening line says the line: such an answer stands as it streamed.
#[tokio::test]
async fn the_line_quoted_after_the_opening_is_no_claim() {
    let quoted = "llm_agent는 사내 지식과 DB를 함께 보는 에이전트입니다.\n\n| 질문 | 동작 |\n|---|---|\n| 쿠버네티스가 뭐야 | 검색 후 일반 지식으로 답변 (\"*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*\" 표시) |";
    let llm = Scripted::new(vec![text(quoted)]);
    let (app, _dir) = app(no_db("gpt-4o"), llm.clone());
    let (r, events) = ask(&app, "quoted", "llm_agent 프로젝트에 대해 설명해줘.", vec![]).await;
    let answer = r.unwrap();
    assert_eq!((answer.answer.as_str(), llm.requests().len()), (quoted, 1));
    assert!(ev(&events, "answer_reset").is_empty(), "{events:?}");
    assert_eq!(preview(&events), quoted);
    // Streamed from its first line on, not held to the end.
    let first = ev(&events, "answer_delta")[0]["text"].as_str().unwrap().to_owned();
    assert!(first.starts_with("llm_agent는") && first.len() < quoted.len(), "{first:?}");
    assert!(answer.log.get("searchFirst").is_none());
}

/// 2026-10-18: a question that read a registered project's files (or used an
/// MCP tool) was taken for one that looked nothing up, as only `search`
/// counted. A tool that answered counts; a call refused before it ran does
/// not.
#[tokio::test]
async fn a_tool_that_answered_counts_as_looking() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("README.md"), "# app\n").unwrap();
    let mut config = no_db("gpt-4o");
    config.projects.push(llm_agent::config::Project {
        name: "app".into(),
        description: "검색 서버".into(),
        root: dir.path().to_path_buf(),
        ..Default::default()
    });
    let llm = Scripted::new(vec![calls(vec![call("l1", "file_list", json!({}))]), text(GENERAL_LINE)]);
    let (listed, _listed_dir) = app(config, llm.clone());
    let (r, _) = ask(&listed, "listed", "일론 머스크가 누구야?", vec![]).await;
    let answer = r.unwrap();
    assert_eq!((answer.answer.as_str(), llm.requests().len()), (GENERAL_LINE, 2));
    assert_eq!(answer.trace[0]["status"], "ok", "{:?}", answer.trace);
    assert!(answer.log.get("searchFirst").is_none());
    let llm = Scripted::new(vec![calls(vec![call("n1", "nope", json!({}))]), text(GENERAL_LINE), text("찾아보니 기업가입니다.")]);
    let (refused, _refused_dir) = app(no_db("gpt-4o"), llm.clone());
    let (r, _) = ask(&refused, "refused", "일론 머스크가 누구야?", vec![]).await;
    let answer = r.unwrap();
    assert_eq!((answer.answer.as_str(), llm.requests().len()), ("찾아보니 기업가입니다.", 3));
    assert_eq!(answer.log["searchFirst"], true);
}

/// A model whose first answer opens with `start` and is stopped there by the
/// user; then it answers from `replies`.
struct StoppedAtStart {
    start: &'static str,
    stop: CancellationToken,
    browser: std::sync::Arc<Browser>,
    replies: std::sync::Arc<Scripted>,
    stopped: std::sync::atomic::AtomicBool,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for StoppedAtStart {
    async fn complete(&self, request: Value, config: &llm_agent::config::LlmConfig, cancel: CancellationToken, delta: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        if self.stopped.swap(true, std::sync::atomic::Ordering::Relaxed) {
            return self.replies.complete(request, config, cancel, delta).await;
        }
        let _ = delta.send(self.start.to_owned()).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        self.browser.close();
        self.stop.cancel();
        cancel.cancelled().await;
        anyhow::bail!("cancelled")
    }
}

/// Context management review, ninth pass: a stop while the start of an answer
/// was held (it could still be the general-knowledge line) sent that start
/// after the stop, to a browser that had closed the stream, and kept it in
/// the conversation: the next question's context held a reply the user never
/// saw, and when it was the start of the line, the guard took it for the
/// previous answer saying the line and let the next line stand unsearched.
#[tokio::test]
async fn a_stop_keeps_nothing_the_browser_was_not_shown() {
    for (n, start) in ["**", "*등록된 지식에 없는 내"].into_iter().enumerate() {
        let stop = CancellationToken::new();
        let browser = std::sync::Arc::new(Browser::default());
        let replies = Scripted::new(vec![text(GENERAL_LINE), text("찾아보니 기업가입니다.")]);
        let llm = std::sync::Arc::new(StoppedAtStart { start, stop: stop.clone(), browser: browser.clone(), replies: replies.clone(), stopped: Default::default() });
        let (app, _dir) = app(no_db("gpt-4o"), llm);
        let conversation = format!("held{n}");
        let question = Question { conversation_id: conversation.clone(), message: "일론 머스크가 누구야?".into(), history: vec![] };
        assert!(agent::answer(&app, question, browser.events(), stop).await.is_err());
        assert_eq!(preview(&browser.seen()), "", "{start:?} was held, not shown");
        let (r, _) = ask(&app, &conversation, "일론 머스크가 누구야?", vec![]).await;
        assert_eq!(r.unwrap().answer, "찾아보니 기업가입니다.", "{start:?}: the line is still refused before a search");
        let first = &replies.requests()[0];
        assert!(messages(first, "assistant").is_empty(), "{start:?}: the conversation kept {:?}", messages(first, "assistant"));
    }
}

// Context management review, fifth pass (2026-10-16): each failed before its
// fix. Needs no MariaDB.

/// X: the retries for blank replies and for calls while tools are withheld
/// counted over the whole question: after two blank replies (or a withheld
/// call) earlier, a cut answer's continuation got none and the answer ended
/// at the cut.
#[tokio::test]
async fn a_cut_answer_gets_its_own_retries() {
    let llm = Scripted::new(vec![text(""), text(""), cut_text("첫 조각 "), text(""), text("끝.")]);
    let (blank, _blank_dir) = app(no_db("gpt-4o"), llm.clone());
    let (r, _) = ask(&blank, "x1", "질문", vec![]).await;
    assert_eq!(r.unwrap().answer, "첫 조각 끝.");
    let listing = |id: &str| calls(vec![call(id, "file_list", json!({}))]);
    let llm = Scripted::new(vec![cut_text("첫 조각 "), listing("w1"), cut_text("둘째 조각 "), listing("w2"), listing("w3"), text("끝.")]);
    let (withheld, _withheld_dir) = app(no_db("gpt-4o"), llm.clone());
    let (r, _) = ask(&withheld, "x2", "질문", vec![]).await;
    assert_eq!(r.unwrap().answer, "첫 조각 둘째 조각 끝.");
}

/// A model that calls `first`, then every continuation (`next_cursor`) its
/// results name, exactly as given, then answers.
struct Following {
    first: Vec<llm_agent::llm::ToolCall>,
    requests: std::sync::Mutex<Vec<Value>>,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for Following {
    async fn complete(&self, request: Value, _config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let round = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request.clone());
            requests.len()
        };
        Ok(match round {
            1 => calls(self.first.clone()),
            2 => calls(
                messages(&request, "tool")
                    .iter()
                    .filter_map(|m| serde_json::from_str::<Value>(m["content"].as_str()?).ok())
                    .filter(|result| result["next_cursor"]["tool"].is_string())
                    .enumerate()
                    .map(|(i, result)| {
                        let mut args = result["next_cursor"].clone();
                        let name = args["tool"].as_str().unwrap().to_owned();
                        args.as_object_mut().unwrap().remove("tool");
                        call(&format!("next{i}"), &name, args)
                    })
                    .collect(),
            ),
            _ => text("답"),
        })
    }
}

/// Y: a cut page of code_outline, symbol_search or symbol_relations repeats
/// its call's arguments as next_cursor, but without the project (it is taken
/// off before the call runs): copied as given where several projects are,
/// the continuation was refused with project_required.
#[tokio::test]
async fn a_cut_page_continues_in_its_project() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = no_db("gpt-4o");
    for name in ["app", "lib"] {
        let root = dir.path().join(name);
        std::fs::create_dir_all(root.join("src")).unwrap();
        let code: String = (0..200).map(|f| format!("pub fn {name}_handler_{f}(x: i32) -> i32 {{\n    x + {f}\n}}\n")).collect();
        std::fs::write(root.join("src/m.rs"), code).unwrap();
        config.projects.push(llm_agent::config::Project { name: name.into(), root, ..Default::default() });
    }
    let llm = std::sync::Arc::new(Following {
        first: vec![
            call("o", "code_outline", json!({"project":"lib","path":"src/m.rs","limit":20})),
            call("s", "symbol_search", json!({"project":"lib","query":"handler","limit":20})),
        ],
        requests: Default::default(),
    });
    let (app, _dir) = app(config, llm.clone());
    let (r, _) = ask(&app, "y", "핸들러 목록", vec![]).await;
    assert_eq!(r.unwrap().answer, "답");
    let last = llm.requests.lock().unwrap().last().unwrap().clone();
    for id in ["next0", "next1"] {
        let result = tool_result(&last, id);
        assert_eq!(result["status"], "ok", "{result}");
        assert!(result.to_string().contains("lib_handler_") && !result.to_string().contains("app_handler_"), "{result}");
    }
}

/// Z: a question whose own results do not fit was told the conversation was
/// too long and to ask again in a new conversation, where the same question
/// fails the same way (earlier questions have all left the context by then).
#[tokio::test]
async fn too_much_material_for_one_question_is_not_sent_to_a_new_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    for i in 0..80 {
        let body: String = (1..=400).map(|l| format!("file {i} line {l} {}\n", "word ".repeat(10))).collect();
        std::fs::write(root.join(format!("f{i}.txt")), body).unwrap();
    }
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 24_000;
    config.llm.output_tokens = 2_000;
    config.projects.push(llm_agent::config::Project { name: "app".into(), root, ..Default::default() });
    // Calls whose results cannot fit beside them are not run but asked for
    // again smaller (thirteenth MCP and context pass); a model that keeps
    // making them ends the question so.
    let every_file = || calls((0..80).map(|i| call(&format!("r{i}"), "file_read", json!({"path":format!("f{i}.txt")}))).collect());
    let llm = Scripted::new(vec![every_file(), every_file(), every_file(), text("답")]);
    let (app, _dir) = app(config, llm.clone());
    let (r, _) = ask(&app, "z", "모든 파일을 요약해줘", vec![]).await;
    let error = r.err().expect("too much material").to_string();
    assert!(error.contains("질문을 나누거나") && !error.contains("새 대화"), "{error}");
    let requests = llm.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests[1].to_string().contains("호출 수를 줄여"), "the model is told why");
    assert!(requests.iter().all(|r| messages(r, "tool").is_empty()), "none of them ran");
}

// Context management review, sixth pass (2026-10-16): each failed before its
// fix. Needs no MariaDB.

/// AA: a provider serving less context than configured refused even a short
/// first question (the system prompt and tools alone did not fit), and the
/// question was told it was too long: shortening it never helps.
#[tokio::test]
async fn a_short_question_the_provider_refuses_points_to_the_settings() {
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 64_000;
    config.llm.output_tokens = 2_000;
    let llm = std::sync::Arc::new(Refusing { limit: 3_000, replies: Default::default(), refused: Default::default() });
    let (app, _dir) = app(config, llm.clone());
    let (r, _) = ask(&app, "aa", "안녕하세요", vec![]).await;
    let error = r.err().expect("refused").to_string();
    assert!(error.contains("설정") && !error.contains("질문이 너무 길어"), "{error}");
}

/// AB: with the knowledge and query tools, random batches (many documents at
/// once, so a response's results are cut together), eviction, a small
/// history and a provider serving less context than configured: every
/// request keeps its shape and fits, a document's text is exactly the
/// chunks it names with the right continuation, cut query rows say what is
/// unseen, the chunk bookkeeping never reaches the model, and every
/// continuation followed (a document's next_cursor, a history next_cursor, a
/// search item's offset, result_read's next_offset) reads. DB_FUZZ sets the
/// number of conversations (DB_FUZZ_STATS prints what was exercised). Needs
/// MariaDB.
/// A model that reads at random with the knowledge and query tools, then
/// follows every continuation its latest results name, then answers.
struct DbFollower {
    seed: std::sync::Mutex<u64>,
    docs: Vec<String>,
    ratio: f64,
    real_limit: usize,
    round: std::sync::Mutex<usize>,
    next_id: std::sync::Mutex<usize>,
    requests: std::sync::Mutex<Vec<(Value, bool)>>,
    /// Calls made by following a continuation: id → what was followed.
    followed: std::sync::Mutex<std::collections::BTreeMap<String, String>>,
}
impl DbFollower {
    fn next(&self, n: usize) -> usize {
        let mut seed = self.seed.lock().unwrap();
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 33) as usize) % n.max(1)
    }
    fn id(&self) -> String {
        let mut n = self.next_id.lock().unwrap();
        *n += 1;
        format!("d{n}")
    }
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for DbFollower {
    async fn complete(&self, request: Value, config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let input = (llm_agent::context::count(&request, &config.model) as f64 * self.ratio) as usize;
        let accepted = input + config.output_tokens <= self.real_limit;
        self.requests.lock().unwrap().push((request.clone(), accepted));
        if !accepted {
            anyhow::bail!("http_400: {}", json!({"error":{"message":format!("This model's maximum context length is {} tokens.", self.real_limit),"code":"context_length_exceeded"}}));
        }
        let round = {
            let mut round = self.round.lock().unwrap();
            *round += 1;
            *round
        };
        let mut out = text("");
        out.usage = Some(llm_agent::llm::Usage { input, output: 50, cached: None });
        let withheld = request["tool_choice"] == "none";
        if withheld || round > 6 {
            out.text = "답".into();
            *self.round.lock().unwrap() = 0;
            return Ok(out);
        }
        if round == 1 {
            for _ in 0..1 + self.next(24) {
                let id = self.id();
                let doc = &self.docs[self.next(self.docs.len())];
                out.calls.push(match self.next(10) {
                    0..=4 => {
                        let mut args = json!({"id":doc});
                        if self.next(3) == 0 {
                            args["start_chunk"] = json!(1 + self.next(30));
                        }
                        if self.next(4) == 0 {
                            args["max_chunks"] = json!(1 + self.next(20));
                        }
                        call(&id, "knowledge_read", args)
                    }
                    5 => call(&id, "query_run", {
                        let customer = ["C-1001", "C-1002", "C-1003"][self.next(3)];
                        json!({"query_name":"order_status_by_customer","params":{"customer_id":customer},"preview_rows":1 + self.next(3)})
                    }),
                    6 => call(&id, "result_read", json!({"step":1 + self.next(4),"offset":self.next(3),"limit":1 + self.next(2)})),
                    7 => call(&id, "method_read", json!({"ids":["m1","m2","m3","m4"]})),
                    _ => call(&id, "history", {
                        let query = ["끝", "문단", "배치"][self.next(3)];
                        json!({"action":"search","query":query})
                    }),
                });
            }
            return Ok(out);
        }
        // Follow what the newest results say goes on.
        let messages = request["messages"].as_array().unwrap();
        let last_assistant = messages.iter().rposition(|m| m["role"] == "assistant" && m["tool_calls"].as_array().is_some_and(|c| !c.is_empty()));
        let Some(at) = last_assistant else {
            out.text = "답".into();
            return Ok(out);
        };
        let calls_made = messages[at]["tool_calls"].as_array().unwrap().clone();
        for message in &messages[at + 1..] {
            if message["role"] != "tool" {
                continue;
            }
            let Ok(result) = serde_json::from_str::<Value>(message["content"].as_str().unwrap()) else { continue };
            let name = calls_made.iter().find(|c| c["id"] == message["tool_call_id"]).map(|c| c["function"]["name"].as_str().unwrap().to_owned()).unwrap_or_default();
            let id = self.id();
            let follow = if result["next_cursor"]["tool"] == "history" {
                let mut args = result["next_cursor"].clone();
                args.as_object_mut().unwrap().remove("tool");
                Some((call(&id, "history", args), "history next_cursor"))
            } else if name == "knowledge_read" && result["data"]["next_cursor"].is_string() {
                Some((call(&id, "knowledge_read", json!({"cursor":result["data"]["next_cursor"]})), "knowledge next_cursor"))
            } else if name == "result_read" && result["data"]["next_offset"].is_u64() {
                Some((call(&id, "result_read", json!({"step":result["data"]["step"],"offset":result["data"]["next_offset"],"limit":2})), "result_read next_offset"))
            } else if name == "history" && result["data"]["items"].as_array().is_some_and(|i| !i.is_empty()) {
                let item = &result["data"]["items"][0];
                item["offset"].as_u64().map(|offset| (call(&id, "history", json!({"action":"read","id":item["id"],"offset":offset})), "history search offset"))
            } else {
                None
            };
            if let Some((c, what)) = follow {
                self.followed.lock().unwrap().insert(id.clone(), what.to_owned());
                out.calls.push(c);
            }
        }
        if out.calls.is_empty() {
            out.text = "답".into();
            *self.round.lock().unwrap() = 0;
        }
        Ok(out)
    }
}

#[tokio::test]
async fn random_knowledge_and_query_reads_keep_their_shape_and_continuations() {
    let Some(db) = TestDb::create("fuzz6") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let runs: usize = std::env::var("DB_FUZZ").ok().and_then(|n| n.parse().ok()).unwrap_or(10);
    let mut seed: u64 = 0xdb6;
    let mut next = |n: usize| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((seed >> 33) as usize) % n.max(1)
    };
    let mut contents = std::collections::BTreeMap::new();
    for d in 0..12 {
        let paragraphs = [2, 5, 20, 40, 60][d % 5];
        let body: String = (0..paragraphs).map(|p| format!("문서{d} 문단{p}: {} 끝{d}-{p}.\n", "점검 절차와 \"따옴표\" 설명 ".repeat(5 + (p % 7)))).collect();
        db.sql_in(&format!("INSERT INTO knowledge (title, content) VALUES ('퍼저 문서 {d}', '{}')", body.replace('\'', "''")));
        let seq = db.scalar(&format!("SELECT seq FROM knowledge WHERE title = '퍼저 문서 {d}'"));
        contents.insert(format!("k{seq}"), body);
    }
    let docs: Vec<String> = contents.keys().cloned().collect();
    let parts: std::collections::BTreeMap<String, Vec<String>> = contents.iter().map(|(k, v)| (k.clone(), llm_agent::chunk::split_content(v))).collect();
    let mut stats: std::collections::BTreeMap<String, usize> = Default::default();
    for run in 0..runs {
        let mut config = db.config();
        config.llm.model = ["gpt-4o", "unknown-tokenizer"][next(2)].into();
        let context = [24_000, 32_000, 64_000][next(3)];
        config.llm.context_tokens = context;
        config.llm.output_tokens = [2_000, 4_000][next(2)];
        if next(2) == 0 {
            config.agent.history_bytes = 64 * 1024;
        }
        if next(3) == 0 {
            config.agent.result_tokens = Some(200 + next(3000));
        }
        let ratio = if config.llm.model == "gpt-4o" { 1.0 } else { 0.8 + next(40) as f64 / 100.0 };
        let real_limit = if next(3) == 0 { context * (60 + next(40)) / 100 } else { context * 2 };
        let llm = std::sync::Arc::new(DbFollower {
            seed: std::sync::Mutex::new(next(1 << 30) as u64 + 1),
            docs: docs.clone(),
            ratio,
            real_limit,
            round: Default::default(),
            next_id: Default::default(),
            requests: Default::default(),
            followed: Default::default(),
        });
        let (fuzz_app, _fuzz_dir) = app(config.clone(), llm.clone());
        for q in 0..3 {
            let before = llm.requests.lock().unwrap().len();
            let (result, _) = ask(&fuzz_app, &format!("db{run}"), &format!("질문 {q}"), vec![]).await;
            if let Err(error) = &result {
                assert!(error.downcast_ref::<agent::UserFacing>().is_some(), "run {run} question {q}: {error:#}");
            }
            let requests = llm.requests.lock().unwrap().clone();
            let followed = llm.followed.lock().unwrap().clone();
            for (i, (request, accepted)) in requests.iter().enumerate().skip(before) {
                if let Err(broken) = request_shape(request) {
                    panic!("run {run} question {q} request {i}: {broken}");
                }
                let raw = request.to_string();
                assert!(!raw.contains("chunk_ends"), "run {run} request {i}: chunk bookkeeping reached the model");
                let input = (llm_agent::context::count(request, &config.llm.model) as f64 * ratio) as usize;
                assert!(!accepted || i == 0 || input + config.llm.output_tokens <= context, "run {run} request {i}: {input} past {context}");
                let messages = request["messages"].as_array().unwrap();
                for (at, message) in messages.iter().enumerate().filter(|(_, m)| m["role"] == "tool") {
                    let call_id = message["tool_call_id"].as_str().unwrap();
                    let call = messages[..at].iter().rev().filter_map(|m| m["tool_calls"].as_array()).flatten().find(|c| c["id"] == call_id).unwrap();
                    let name = call["function"]["name"].as_str().unwrap();
                    let result: Value = serde_json::from_str(message["content"].as_str().unwrap()).unwrap();
                    if let Some(what) = followed.get(call_id) {
                        *stats.entry(format!("followed {what} {}", result["status"])).or_default() += 1;
                    }
                    if name == "knowledge_read" && result["truncated"] == true {
                        *stats.entry(format!("knowledge cut {}", if result["data"]["not_delivered"].is_string() { "to nothing" } else { "to whole chunks" })).or_default() += 1;
                    }
                    if result["archive_id"].is_u64() {
                        *stats.entry(format!("archived {name}")).or_default() += 1;
                    }
                    if let Some(what) = followed.get(call_id) {
                        assert_eq!(result["status"], "ok", "run {run} request {i}: following {what} failed: {result}");
                    }
                    if name == "knowledge_read" && result["status"] == "ok" {
                        let data = &result["data"];
                        let doc = data["id"].as_str().unwrap();
                        let total = parts[doc].len();
                        let text = data["text"].as_str().unwrap();
                        if text.is_empty() {
                            assert!(data["next_cursor"].is_string() && data["not_delivered"].is_string(), "run {run} request {i}: {result}");
                            continue;
                        }
                        let chunks = data["chunks"].as_str().unwrap();
                        let (a, b) = chunks.split_once('-').map_or((chunks, chunks), |(a, b)| (a, b));
                        let (a, b): (usize, usize) = (a.parse().unwrap(), b.parse().unwrap());
                        let joined = llm_agent::chunk::join_chunks((a..=b).map(|n| (n as i64, parts[doc][n - 1].as_str())));
                        let mark = llm_agent::text::TRUNC_MARK;
                        assert!(text == joined || (a == b && text.ends_with(mark) && joined.starts_with(text.strip_suffix(mark).unwrap())), "run {run} request {i}: {doc} {chunks} text is not those chunks: {result}");
                        if b < total {
                            assert_eq!(data["next_cursor"], format!("{doc}:{}", b + 1), "run {run} request {i}: {result}");
                        } else {
                            assert_eq!(data["complete_to_end"], true, "run {run} request {i}: {result}");
                        }
                    }
                    if name == "query_run" && result["status"] == "ok" && result["truncated"] == true && result["data"]["rows"].is_array() {
                        *stats.entry("query rows cut".into()).or_default() += 1;
                        let shown = result["data"]["rows"].as_array().unwrap().len() as u64;
                        assert_eq!(result["data"]["omitted_rows"], result["data"]["row_count"].as_u64().unwrap() - shown, "run {run}: {result}");
                        assert!(result["data"].get("rows_omitted").is_none(), "run {run}: two counts of unseen rows: {result}");
                    }
                }
            }
            if let Err(error) = &result {
                let refused = llm.requests.lock().unwrap().iter().skip(before).any(|(_, accepted)| !accepted);
                *stats.entry(format!("error {} (provider refused: {refused})", error.to_string().chars().take(20).collect::<String>())).or_default() += 1;
            }
        }
    }
    if std::env::var("DB_FUZZ_STATS").is_ok() {
        eprintln!("stats: {stats:#?}");
    }
}

// Context management review, seventh pass (2026-10-16): each failed before
// its fix. Needs no MariaDB.

/// Reads one range of a large file a round until the request nears the
/// high-water share of the input budget, then writes an answer cut at the
/// output limit, sized so its continuation lands between the high-water
/// share and the whole budget: it fits without anything leaving.
struct FillsThenCuts {
    high: usize,
    budget: usize,
    reads: std::sync::Mutex<usize>,
    requests: std::sync::Mutex<Vec<Value>>,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for FillsThenCuts {
    async fn complete(&self, request: Value, config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let size = llm_agent::context::count(&request, &config.model);
        self.requests.lock().unwrap().push(request.clone());
        if request["tool_choice"] == "none" {
            return Ok(text("끝."));
        }
        let target = (self.high + self.budget) / 2;
        if size + config.output_tokens < target {
            let mut reads = self.reads.lock().unwrap();
            *reads += 1;
            return Ok(calls(vec![call(&format!("r{reads}"), "file_read", json!({"path":"big.txt","start_line":1 + 2000 * (*reads - 1)}))]));
        }
        let piece_tokens = target.saturating_sub(size);
        assert!(piece_tokens > 200 && piece_tokens < config.output_tokens, "setup: {size} tokens, a piece of {piece_tokens}");
        let piece = " word".repeat(piece_tokens);
        Ok(cut_text(&piece))
    }
}

/// S: a request that cannot use tools (an answer's continuation, the final
/// answer) evicted old bundles at the high-water share although it fit the
/// context, so the answer went on without the results it was written from,
/// which that request could not read back with the history tool.
#[tokio::test]
async fn a_request_that_cannot_use_tools_keeps_what_fits() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    let body: String = (1..=20_000).map(|i| format!("line {i} {}\n", "word ".repeat(12))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 24_000;
    config.llm.output_tokens = 4_000;
    config.projects.push(llm_agent::config::Project { name: "app".into(), root, ..Default::default() });
    let budget = config.input_budget();
    let high = (budget as f64 * config.agent.high_water) as usize;
    let llm = std::sync::Arc::new(FillsThenCuts { high, budget, reads: Default::default(), requests: Default::default() });
    let (fill_app, _dir) = app(config.clone(), llm.clone());
    let (r, _) = ask(&fill_app, "s", "파일을 길게 설명해줘", vec![]).await;
    assert!(r.unwrap().answer.ends_with("끝."));
    let requests = llm.requests.lock().unwrap().clone();
    let continuation = requests.last().unwrap();
    assert_eq!(continuation["tool_choice"], "none");
    let reads = *llm.reads.lock().unwrap();
    assert_eq!(messages(continuation, "tool").len(), reads, "the results the answer is written from stay");
    let size = llm_agent::context::count(continuation, &config.llm.model);
    assert!(size >= high && size <= budget, "setup: the continuation is {size}, between {high} and {budget}");

    // The final answer (every request is within the final reserve) keeps
    // the earlier conversation that fits as well.
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 16_000;
    config.llm.output_tokens = 2_000;
    config.agent.run_seconds = 45;
    let budget = config.input_budget();
    let high = (budget as f64 * config.agent.high_water) as usize;
    let probe = Scripted::new(vec![text("답")]);
    let (probe_app, _probe_dir) = app(config.clone(), probe.clone());
    ask(&probe_app, "probe", "이어서", vec![]).await.0.unwrap();
    let frame = llm_agent::context::count(&probe.requests()[0], &config.llm.model);
    let turn = |tokens: usize| " 자료".repeat(tokens / llm_agent::context::tokens(" 자료", "gpt-4o"));
    let each = ((high + budget) / 2 - frame) / 4;
    let history: Vec<(String, String)> = (0..4).map(|i| (["user", "assistant"][i % 2].to_owned(), turn(each))).collect();
    let llm = Scripted::new(vec![text("답")]);
    let (final_app, _final_dir) = app(config.clone(), llm.clone());
    ask(&final_app, "s2", "이어서", history).await.0.unwrap();
    let request = &llm.requests()[0];
    assert_eq!(request["tool_choice"], "none");
    assert_eq!(messages(request, "assistant").len(), 2, "the earlier turns stay");
    let size = llm_agent::context::count(request, &config.llm.model);
    assert!(size >= high && size <= budget, "setup: the final request is {size}, between {high} and {budget}");
}

// Context management review, eighth pass (2026-10-16): each failed before
// its fix. Needs no MariaDB.

/// Answers the first question with a marker, then searches the history for
/// it beside a read of a large file, a round, so the requests grow until one
/// evicts the bundles the searches found.
struct SearchesWhileFilling {
    reads: std::sync::Mutex<usize>,
    requests: std::sync::Mutex<Vec<Value>>,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for SearchesWhileFilling {
    async fn complete(&self, request: Value, _config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        self.requests.lock().unwrap().push(request.clone());
        if state_of(&request)["current_question"] == "첫 질문" {
            // A cut search leaves an archive, so the history tool is offered.
            if messages(&request, "tool").is_empty() {
                return Ok(calls(vec![call("s0", "source_search", json!({"query":"needle","limit":100}))]));
            }
            return Ok(text("MARKER-Q1 답: needle은 여러 파일에 있다."));
        }
        let mut reads = self.reads.lock().unwrap();
        if *reads >= 8 {
            return Ok(text("끝."));
        }
        *reads += 1;
        Ok(calls(vec![
            call(&format!("h{reads}"), "history", json!({"action":"search","query":"marker-q1"})),
            call(&format!("f{reads}"), "file_read", json!({"path":"big.txt","start_line":1 + 400 * *reads,"max_lines":400})),
        ]))
    }
}

/// U: a history search reported whether each bundle it found was in the
/// active context as it was when the search ran, but the request that first
/// delivered the search could evict those bundles: the model was told an
/// earlier answer was still in its context in the request that had just
/// taken it out.
#[tokio::test]
async fn a_history_search_says_what_the_request_delivering_it_holds() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(root.join("src")).unwrap();
    let body: String = (1..=6000).map(|i| format!("line {i} {}\n", "word \"q\" 가나다 ".repeat(6))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    for i in 0..40 {
        std::fs::write(root.join(format!("src/m{i}.rs")), format!("fn f{i}() {{ let needle = {i}; }}\n").repeat(60)).unwrap();
    }
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 24_000;
    config.llm.output_tokens = 2_000;
    config.projects.push(llm_agent::config::Project { name: "app".into(), root, ..Default::default() });
    let llm = std::sync::Arc::new(SearchesWhileFilling { reads: Default::default(), requests: Default::default() });
    let (search_app, _dir) = app(config, llm.clone());
    ask(&search_app, "u", "첫 질문", vec![]).await.0.unwrap();
    let first = llm.requests.lock().unwrap().len();
    assert_eq!(ask(&search_app, "u", "다음 질문", vec![]).await.0.unwrap().answer, "끝.");
    let requests = llm.requests.lock().unwrap().clone();
    let mut evicted_seen = false;
    for (i, request) in requests.iter().enumerate().skip(first + 1) {
        // The search the previous response made, delivered here first.
        let call = messages(request, "assistant").last().unwrap()["tool_calls"][0]["id"].as_str().unwrap().to_owned();
        let found = tool_result(request, &call);
        let items = found["data"]["items"].as_array().unwrap();
        let answer = items.iter().find(|item| item["excerpt"].as_str().unwrap().contains("MARKER-Q1")).unwrap_or_else(|| panic!("request {i}: {found}"));
        let held = messages(request, "assistant").iter().any(|m| m["content"].as_str().is_some_and(|c| c.contains("MARKER-Q1")));
        evicted_seen |= !held;
        assert_eq!(answer["active"], held, "request {i}: the answer's bundle is {}in this request: {answer}", if held { "" } else { "not " });
    }
    assert!(evicted_seen, "setup: a request delivering a search evicted the answer");
}

// Context management review, tenth pass (2026-10-16): failed before its fix.
// Needs no MariaDB.

/// A thinking model that spends the whole output limit reasoning: the
/// response ends at the limit with no text and no call.
fn reasoned_out() -> llm_agent::llm::Completion {
    let mut completion = cut_text("");
    completion.reasoning_chars = 40_000;
    completion
}

/// Z: a response cut at the output limit before any text was taken for a
/// blank reply: the model was told its reply was empty, nothing about the
/// limit its reasoning had used up, and the user to try again later, which
/// fails the same way.
#[tokio::test]
async fn a_reply_cut_before_any_text_is_told_from_a_blank_one() {
    let llm = Scripted::new(vec![reasoned_out(), reasoned_out(), reasoned_out()]);
    let (spent, _spent_dir) = app(no_db("gpt-4o"), llm.clone());
    let error = ask(&spent, "z1", "질문", vec![]).await.0.err().unwrap();
    let shown = error.downcast_ref::<agent::UserFacing>().expect("a message for the user").to_string();
    assert!(shown.contains("출력 한도") && !shown.contains("잠시 후"), "{shown}");
    for request in &llm.requests()[1..] {
        let notice = state_of(request)["run_guidance"]["notice"].as_str().unwrap().to_owned();
        assert!(notice.contains("출력 한도") && notice.contains("도구를 부르거나"), "{notice}");
    }
    // While a cut answer is continued, it is asked to go on, and stands.
    let llm = Scripted::new(vec![cut_text("첫 조각 "), reasoned_out(), text("끝.")]);
    let (continued, _continued_dir) = app(no_db("gpt-4o"), llm.clone());
    assert_eq!(ask(&continued, "z2", "질문", vec![]).await.0.unwrap().answer, "첫 조각 끝.");
    let notice = state_of(&llm.requests()[2])["run_guidance"]["notice"].as_str().unwrap().to_owned();
    assert!(notice.contains("출력 한도") && notice.contains("이어 써라"), "{notice}");
    // A blank reply stays a blank reply.
    let llm = Scripted::new(vec![text(""), text(""), text("")]);
    let (blank, _blank_dir) = app(no_db("gpt-4o"), llm.clone());
    let shown = ask(&blank, "z3", "질문", vec![]).await.0.err().unwrap().to_string();
    assert!(shown.contains("빈 응답"), "{shown}");
    let notice = state_of(&llm.requests()[1])["run_guidance"]["notice"].as_str().unwrap().to_owned();
    assert!(notice.contains("비어 있었다"), "{notice}");
}

// Context management review, eleventh pass (2026-10-16): failed before its
// fix. Needs no MariaDB.

/// An OpenAI-compatible server whose first stream drops while it writes the
/// answer; the requests after it are answered whole.
async fn drops_its_first_stream() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}/v1", listener.local_addr().unwrap().port());
    let served = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = served.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let count = count.clone();
            tokio::spawn(async move {
                let mut bytes = vec![];
                let mut buffer = [0u8; 65536];
                loop {
                    let n = socket.read(&mut buffer).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                    let Some(split) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&bytes[..split]).to_ascii_lowercase();
                    let length = head.lines().find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                    if bytes.len() - split - 4 >= length {
                        break;
                    }
                }
                let event = |text: &str, finish: Value| format!("data: {}\n\n", json!({"choices":[{"delta":{"content":text},"finish_reason":finish}]}));
                let mut reply = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n".to_owned();
                if count.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
                    // The connection drops partway through the answer.
                    reply.push_str(&event("쓰던 답 ", Value::Null));
                } else {
                    reply.push_str(&event("다시 쓴 답", Value::Null));
                    reply.push_str(&event("", json!("stop")));
                    reply.push_str("data: [DONE]\n\n");
                }
                let _ = socket.write_all(reply.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (url, served)
}

/// AA: a stream that dropped while the answer was being written ended the
/// question with "처리 중 오류가 발생했습니다": the client cannot retry a
/// stream whose text has gone out, and the answer loop asked again only when
/// none had. It can take the text back from the screen and ask again.
#[tokio::test]
async fn a_stream_cut_while_it_writes_is_asked_again() {
    let (url, served) = drops_its_first_stream().await;
    let mut config = no_db("stream-cut-test");
    config.llm.base_url = url;
    config.llm.disable_proxy = true;
    let (cut_app, _dir) = app(config, std::sync::Arc::new(llm_agent::llm::OpenAiClient));
    let (result, events) = ask(&cut_app, "aa", "질문", vec![]).await;
    assert_eq!(result.map(|a| a.answer).map_err(|e| e.to_string()), Ok("다시 쓴 답".to_owned()));
    assert_eq!(served.load(std::sync::atomic::Ordering::Relaxed), 2);
    assert_eq!(preview(&events), "다시 쓴 답", "the cut text was taken back: {events:?}");
    let claim = cut_app.sessions.open("aa", std::time::Duration::from_secs(60), 10, CancellationToken::new());
    let kept: Vec<Value> = claim.conversation.lock().await.history.active();
    assert_eq!(kept.iter().filter(|m| m["role"] == "assistant").map(|m| m["content"].clone()).collect::<Vec<_>>(), [json!("다시 쓴 답")]);
}

/// A model that writes a sentence, then sends tool calls the client cannot
/// use, `broken` times, then answers.
struct WritesThenBreaksItsCalls {
    broken: usize,
    requests: std::sync::Mutex<Vec<Value>>,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for WritesThenBreaksItsCalls {
    async fn complete(&self, request: Value, _config: &llm_agent::config::LlmConfig, _c: CancellationToken, delta: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let n = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request);
            requests.len() - 1
        };
        if n < self.broken {
            let _ = delta.send("찾아보겠습니다. ".into()).await;
            anyhow::bail!("invalid_tool_arguments: search arguments are not one complete JSON object (EOF while parsing an object at line 1 column 12); use double-quoted property names and close every string, array and object");
        }
        let answer = "고친 답";
        let _ = delta.send(answer.into()).await;
        Ok(text(answer))
    }
}

/// AB: tool calls the client could not use after the response had written
/// a sentence ended the question with "처리 중 오류가 발생했습니다": the
/// client asks again only while none of the text has gone out.
#[tokio::test]
async fn unusable_calls_after_a_sentence_are_asked_for_again() {
    let llm = std::sync::Arc::new(WritesThenBreaksItsCalls { broken: 1, requests: Default::default() });
    let (fixed, _dir) = app(no_db("gpt-4o"), llm.clone());
    let (result, events) = ask(&fixed, "ab1", "질문", vec![]).await;
    assert_eq!(result.map(|a| a.answer).map_err(|e| e.to_string()), Ok("고친 답".to_owned()));
    assert_eq!(preview(&events), "고친 답", "the sentence was taken back: {events:?}");
    let notice = state_of(&llm.requests.lock().unwrap()[1])["run_guidance"]["notice"].as_str().unwrap().to_owned();
    assert!(notice.contains("실행되지 않았다") && notice.contains("not one complete JSON object"), "{notice}");
    // Again and again: the question ends with a message for the user.
    let llm = std::sync::Arc::new(WritesThenBreaksItsCalls { broken: 9, requests: Default::default() });
    let (broken, _broken_dir) = app(no_db("gpt-4o"), llm.clone());
    let error = ask(&broken, "ab2", "질문", vec![]).await.0.err().unwrap();
    assert!(error.downcast_ref::<agent::UserFacing>().is_some_and(|e| e.0.contains("도구 호출")), "{error}");
    assert_eq!(llm.requests.lock().unwrap().len(), 3, "two more requests");
}

// Context management review, thirteenth pass (2026-10-17): each failed
// before its fix. Needs no MariaDB.

/// A provider serving the configured context that counts `factor` times the
/// estimate (a tokenizer and chat template unlike the fallback's): a longer
/// request is refused with the count, as OpenAI-compatible servers word it.
/// Each request is kept with its estimate and whether it was answered.
struct Overcounting {
    factor: f64,
    requests: std::sync::Mutex<Vec<(Value, usize, bool)>>,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for Overcounting {
    async fn complete(&self, request: Value, config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let estimate = llm_agent::context::count(&request, &config.model);
        let counted = (estimate as f64 * self.factor) as usize;
        let accepted = counted + config.output_tokens <= config.context_tokens;
        self.requests.lock().unwrap().push((request, estimate, accepted));
        if !accepted {
            anyhow::bail!(
                "http_400: {}",
                json!({"error":{"message":format!("This model's maximum context length is {} tokens. However, your messages resulted in {counted} tokens.", config.context_tokens),"code":"context_length_exceeded"}})
            );
        }
        let mut answer = text("답");
        answer.usage = Some(llm_agent::llm::Usage { input: counted, output: 10, cached: None });
        Ok(answer)
    }
}

/// AC: a server that counts a new conversation's first request past the
/// configured context (no usage has calibrated the estimate yet) refused a
/// question too long for it, and the user was told the server serves less
/// context than configured — it serves just that. Its refusal says what it
/// counted: calibrated, the question is told it is too long.
#[tokio::test]
async fn a_refusal_that_counts_the_request_calibrates_it() {
    let mut config = no_db("unknown-tokenizer");
    config.llm.context_tokens = 16_000;
    config.llm.output_tokens = 2_000;
    let llm = std::sync::Arc::new(Overcounting { factor: 1.4, requests: Default::default() });
    let (app, _dir) = app(config.clone(), llm.clone());
    let (r, _) = ask(&app, "ac", &format!("이 내용을 정리해줘 {}", "자료 ".repeat(1_200)), vec![]).await;
    let error = r.err().expect("too long for this server").to_string();
    let (_, estimate, accepted) = llm.requests.lock().unwrap()[0].clone();
    assert!(!accepted && estimate + config.llm.output_tokens + 512 <= config.llm.context_tokens, "sent uncalibrated, then refused: {estimate}");
    assert!(error.contains("질문이 너무 길어"), "{error}");
    // A short question is answered once calibrated, in the same conversation.
    let (r, _) = ask(&app, "ac", "짧게 물어볼게", vec![]).await;
    assert_eq!(r.map(|a| a.answer).map_err(|e| e.to_string()), Ok("답".to_owned()));
}

/// AD: the same server refused a restored conversation's first request, and
/// every restored turn left the context at once: what had to leave was
/// unknown without a count. Calibrated by the refusal, only the oldest turns
/// leave and the latest exchange stays for the follow-up question.
#[tokio::test]
async fn a_counted_refusal_evicts_only_what_the_count_requires() {
    let mut config = no_db("unknown-tokenizer");
    config.llm.context_tokens = 32_000;
    config.llm.output_tokens = 2_000;
    config.agent.high_water = 0.95;
    config.agent.low_water = 0.9;
    let llm = std::sync::Arc::new(Overcounting { factor: 1.4, requests: Default::default() });
    let (app, _dir) = app(config, llm.clone());
    let turns: Vec<(String, String)> = (0..6)
        .map(|i| (["user", "assistant"][i % 2].to_owned(), format!("턴{i} {}", "이전 대화 내용 ".repeat(420))))
        .collect();
    let (r, _) = ask(&app, "ad", "그럼 마지막 건은?", turns).await;
    assert_eq!(r.map(|a| a.answer).map_err(|e| e.to_string()), Ok("답".to_owned()));
    let requests = llm.requests.lock().unwrap().clone();
    assert!(!requests[0].2, "the first request was refused: {}", requests[0].1);
    let (answered, _, _) = requests.iter().find(|(_, _, accepted)| *accepted).unwrap();
    let kept: Vec<String> = answered["messages"].as_array().unwrap().iter().filter_map(|m| m["content"].as_str()).filter_map(|t| t.strip_prefix("턴").map(|t| t[..1].to_owned())).collect();
    assert!(kept.ends_with(&["4".to_owned(), "5".to_owned()]), "the latest exchange stays: {kept:?}");
}

// Context management review, fifteenth pass (2026-10-17): failed before its
// fix. Needs no MariaDB.

/// A server serving less context than configured that cuts what does not fit
/// instead of refusing it (Ollama truncates to its loaded context and says
/// nothing): it answers every request and counts at most `cap` tokens.
/// `ratio` is its count per estimated token (a tokenizer more frugal than
/// the estimate's); every other request hits its prompt cache, whose tokens
/// the count includes as OpenAI's usage does.
struct Cutting {
    cap: usize,
    ratio: f64,
    replies: std::sync::Mutex<std::collections::VecDeque<llm_agent::llm::Completion>>,
    seen: std::sync::Mutex<Vec<(usize, usize)>>,
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for Cutting {
    async fn complete(&self, request: Value, config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let estimate = llm_agent::context::count(&request, &config.model);
        let counted = ((estimate as f64 * self.ratio) as usize).min(self.cap);
        let mut seen = self.seen.lock().unwrap();
        let cached = seen.len().is_multiple_of(2).then_some(counted * 9 / 10);
        seen.push((estimate, counted));
        let mut reply = self.replies.lock().unwrap().pop_front().unwrap_or_else(|| text("끝"));
        reply.usage = Some(llm_agent::llm::Usage { input: counted, output: 10, cached });
        Ok(reply)
    }
}

/// AE: a server that cuts requests to a smaller context than configured
/// answered from what was left — the question and the system prompt gone —
/// and the user got that answer with no sign of the cut (a real Ollama with
/// its default 4,096 tokens answered with fragments of the runtime state).
/// A request that grew while the count did not is told to the settings.
#[tokio::test]
async fn a_server_that_cuts_requests_is_told_to_the_settings() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    let body: String = (1..=4000).map(|i| format!("line {i} {}\n", "word ".repeat(10))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    let mut config = no_db("gpt-4o");
    config.llm.context_tokens = 32_000;
    config.llm.output_tokens = 2_000;
    config.projects.push(llm_agent::config::Project { name: "app".into(), root, ..Default::default() });
    let script = || {
        vec![
            calls(vec![call("r1", "file_read", json!({"path":"big.txt","start_line":1,"max_lines":400}))]),
            calls(vec![call("r2", "file_read", json!({"path":"big.txt","start_line":1000,"max_lines":400}))]),
            text("끝"),
        ]
    };
    // Uncut, a frugal count with a cache hit before a miss is no cut: the
    // count includes the cached tokens.
    for (cap, ratio, cut) in [(usize::MAX, 1.0, false), (usize::MAX, 0.45, false), (4_096, 1.0, true)] {
        let llm = std::sync::Arc::new(Cutting { cap, ratio, replies: std::sync::Mutex::new(script().into()), seen: Default::default() });
        let (app, _d) = app(config.clone(), llm.clone());
        let (r, _) = ask(&app, "ae", "big.txt 두 곳을 읽고 비교해줘", vec![]).await;
        let seen = llm.seen.lock().unwrap().clone();
        if cut {
            let error = r.err().expect("told, not answered").to_string();
            assert!(error.contains("일부를 버린") && error.contains("컨텍스트"), "{error}");
            assert_eq!(seen.len(), 2, "told at the first request that grew uncounted: {seen:?}");
        } else {
            assert_eq!(r.map(|a| a.answer).map_err(|e| e.to_string()), Ok("끝".to_owned()), "{seen:?}");
        }
    }
}

// Backend review (leaks, panics, deadlocks), fourth pass (2026-10-18):
// failed before its fix. Needs no MariaDB.

/// A provider (or a proxy before it) whose refusal for size states a count
/// past any context: the messages and functions counts added up, and the
/// output added to that, overflowed — a panic in a debug build.
struct CountsPastAnyContext;
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for CountsPastAnyContext {
    async fn complete(&self, _r: Value, _c: &llm_agent::config::LlmConfig, _t: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        anyhow::bail!(
            "http_400: {}",
            json!({"error":{"message":"This model's maximum context length is 128000 tokens. However, you requested 18446744073709551615 tokens (18446744073709551615 in the messages, 300 in the functions, and 2000 in the completion).","code":"context_length_exceeded"}})
        )
    }
}

#[tokio::test]
async fn a_refusal_counting_past_any_context_ends_the_question_plainly() {
    let (app, _dir) = app(no_db("unknown-tokenizer"), std::sync::Arc::new(CountsPastAnyContext));
    let error = ask(&app, "review4", "질문", vec![]).await.0.err().expect("refused");
    assert!(error.downcast_ref::<agent::UserFacing>().is_some(), "{error}");
}
