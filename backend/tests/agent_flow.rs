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
        for part in ["배치 상태는 ", "다음 표와 같습니다."] {
            let _ = delta.send(part.to_owned()).await;
        }
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
    assert_eq!(replies, vec![json!("배치 상태는 다음 표와 같습니다.")]);
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

/// The shape every request must keep: the context opens with a user
/// message, no reply follows a reply, every tool call has its result right
/// after it, one answer per question, no internal flags.
fn request_shape(request: &Value) -> Result<(), String> {
    let messages = request["messages"].as_array().unwrap();
    if messages[0]["role"] != "system" || messages[1]["role"] != "user" || messages.last().unwrap()["role"] != "user" {
        return Err("not system, user …, state".into());
    }
    let mut pending: Vec<&str> = vec![];
    let mut answers = 0;
    let mut previous = "";
    for message in &messages[1..] {
        let role = message["role"].as_str().unwrap();
        if role == "assistant" && previous == "assistant" {
            return Err("a reply after a reply".into());
        }
        if role != "tool" && !pending.is_empty() {
            return Err(format!("no result for {pending:?}"));
        }
        if message.get("partial").is_some() || message.get("restored").is_some() {
            return Err("internal flag".into());
        }
        match role {
            "assistant" => match message["tool_calls"].as_array() {
                Some(calls) if !calls.is_empty() => pending = calls.iter().map(|c| c["id"].as_str().unwrap()).collect(),
                _ => answers += 1,
            },
            "tool" => {
                let id = message["tool_call_id"].as_str().unwrap();
                let at = pending.iter().position(|p| *p == id).ok_or(format!("result without its call {id}"))?;
                pending.remove(at);
            }
            _ => answers = 0,
        }
        if answers > 1 {
            return Err("two answers to one question".into());
        }
        previous = role;
    }
    Ok(())
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

/// What a result in the context goes on in is still held: the archive of a
/// cut result, the bundle a cut history read reads.
fn continuations_kept(history: &llm_agent::session::SessionHistory) -> Result<(), String> {
    for bundle in history.bundles.iter().filter(|b| b.active) {
        for message in bundle.messages.iter().filter(|m| m["role"] == "tool") {
            let Ok(result) = serde_json::from_str::<Value>(message["content"].as_str().unwrap_or("")) else {
                continue;
            };
            let mut ids: Vec<u64> = result["archive_id"].as_u64().into_iter().collect();
            if result["next_cursor"]["tool"] == "history" {
                ids.extend(result["next_cursor"]["id"].as_u64());
            }
            if result["data"]["truncated"] == true && result["next_cursor"]["tool"] != "history" && message["tool_call_id"].as_str().is_some() {
                // A cut history read without a continuation the prune can see.
                let call = bundle.messages[0]["tool_calls"].as_array().and_then(|calls| calls.iter().find(|c| c["id"] == message["tool_call_id"]));
                if call.is_some_and(|c| c["function"]["name"] == "history") {
                    return Err(format!("bundle {}: a cut history read names no next_cursor", bundle.id));
                }
            }
            for id in ids {
                if history.read(id).is_err() {
                    return Err(format!("bundle {}: {id}, which a result in the context goes on in, was dropped", bundle.id));
                }
            }
        }
    }
    Ok(())
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

/// A model answering at random until the user stops it mid-stream: cut
/// answer pieces, tool calls with text before them, cut tool calls, empty
/// replies.
struct StoppedAtRandom {
    seed: std::sync::Mutex<u64>,
    stop_at: usize,
    calls: std::sync::atomic::AtomicUsize,
    stop: CancellationToken,
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
        let llm = std::sync::Arc::new(StoppedAtRandom {
            seed: std::sync::Mutex::new(run as u64 * 7919 + 1),
            stop_at: run % 6,
            calls: Default::default(),
            stop: stop.clone(),
        });
        let (app, _dir) = app(no_db("gpt-4o"), llm.clone());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let question = Question { conversation_id: "o".into(), message: "질문".into(), history: vec![] };
        let stopped = agent::answer(&app, question, Events::new(Some(tx)), stop).await;
        let mut events = vec![];
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
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

/// V: the line is refused once per question, found in the whole answer when
/// it did not open it, and left alone where no search can follow (the final
/// request) or no line is said.
#[tokio::test]
async fn the_search_first_guard_asks_once_and_spares_other_answers() {
    // After a heading it streams before it is found: taken back, asked once,
    // and the second time it stands.
    let late = "### 답변\n\n등록된 자료에서 찾을 수 없어 일반 지식으로 답합니다. 쿠버네티스는 컨테이너 오케스트레이션입니다.";
    let llm = Scripted::new(vec![text(late), text(late)]);
    let (late_app, _late_dir) = app(no_db("gpt-4o"), llm.clone());
    let (r, events) = ask(&late_app, "v", "쿠버네티스가 뭐야?", vec![]).await;
    assert_eq!(r.unwrap().answer, late);
    assert_eq!(llm.requests().len(), 2);
    assert_eq!(ev(&events, "answer_reset").len(), 1);
    assert_eq!(preview(&events), late);
    // Ordinary answers, held for their first characters only, stream whole.
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
    let every_file = calls((0..80).map(|i| call(&format!("r{i}"), "file_read", json!({"path":format!("f{i}.txt")}))).collect());
    let (app, _dir) = app(config, Scripted::new(vec![every_file, text("답")]));
    let (r, _) = ask(&app, "z", "모든 파일을 요약해줘", vec![]).await;
    let error = r.err().expect("too much material").to_string();
    assert!(error.contains("질문을 나누거나") && !error.contains("새 대화"), "{error}");
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
                    if name == "query_run" && result["status"] == "ok" && result["data"]["rows_omitted"].is_u64() {
                        let shown = result["data"]["rows"].as_array().unwrap().len() as u64;
                        assert_eq!(result["data"]["omitted_rows"], result["data"]["row_count"].as_u64().unwrap() - shown, "run {run}: {result}");
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
