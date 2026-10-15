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
    // context, refuses the identical run and returns the referenced rows.
    llm.push(vec![
        calls(vec![call("c4", "query_run", json!({"query_name":"batch_job_status","params":{"job_id":"BATCH001"}}))]),
        calls(vec![call("c5", "result_read", json!({"step":1,"cols":["status"]}))]),
        text("앞서 본 결과 그대로입니다.\n\n```chart\ntype: bar\ntitle: 상태\ndata: step 1\n```"),
    ]);
    let (result, _) = ask(&app, "conv-1", "다시 보여줘", vec![]).await;
    let answer = result.unwrap();
    let requests = llm.requests();
    let first_of_followup = &requests[4];
    assert!(
        first_of_followup["messages"].as_array().unwrap().iter().any(|m| m["tool_call_id"] == "c3"),
        "earlier tool results stay in context"
    );
    let repeated = tool_result(&requests[5], "c4");
    assert_eq!(repeated["recovery"]["code"], "repeated_call", "{repeated}");
    // The refusal is a loop guard, not a failed query: no error step (the
    // chat_log failed-question query counts steps[].error).
    assert!(answer.trace.iter().all(|s| s.get("error").is_none()), "{:?}", answer.trace);
    assert_eq!(answer.log["search"]["searches"], 0);
    let read = tool_result(&requests[6], "c5");
    assert_eq!(read["data"]["columns"], json!(["STATUS"]));
    assert_eq!(answer.refs[0]["step"], 1);
    assert_eq!(answer.refs[0]["rows"][0]["STATUS"], "FAILED");
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

#[tokio::test]
async fn calls_past_the_tool_call_setting_wait_for_the_next_response() {
    let Some(db) = TestDb::create("calls") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let mut config = db.config();
    config.agent.max_tool_calls = Some(2);
    let llm = Scripted::new(vec![
        calls(vec![
            call("d1", "query_describe", json!({"names":["batch_job_status"]})),
            call("d2", "query_describe", json!({"names":["find_customer_id"]})),
            call("d3", "query_describe", json!({"names":["today_date"]})),
        ]),
        calls(vec![call("d4", "query_describe", json!({"names":["today_date"]}))]),
        text("끝"),
    ]);
    let (app, _dir) = app(config, llm.clone());
    let (result, events) = ask(&app, "calls", "쿼리 셋 설명해줘", vec![]).await;
    let answer = result.unwrap();
    assert_eq!(answer.answer, "끝");
    let requests = llm.requests();
    let state = messages(&requests[0], "user").last().unwrap()["content"].as_str().unwrap().to_owned();
    assert!(state.contains("\"max_tool_calls\":2"), "{state}");
    // The third call is answered (every call needs a result) but not run.
    assert_eq!(tool_result(&requests[1], "d1")["status"], "ok");
    assert_eq!(tool_result(&requests[1], "d2")["status"], "ok");
    let skipped = tool_result(&requests[1], "d3");
    assert_eq!(skipped["recovery"]["code"], "tool_call_limit", "{skipped}");
    assert_eq!(tool_result(&requests[2], "d4")["status"], "ok", "resent in the next response, it runs");
    // No progress line or trace step for the call that never started.
    assert_eq!(ev(&events, "tool").len(), 3);
    assert_eq!(ev(&events, "tool_done").len(), 3);
    assert_eq!(answer.trace.iter().filter(|s| s["tool"] == "query_describe").count(), 3);
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
    config.agent.batch_tokens = Some(3_000);
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
