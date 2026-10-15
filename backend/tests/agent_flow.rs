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
