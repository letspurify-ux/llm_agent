//! The HTTP contract the unchanged frontend relies on: the admin API of the
//! former Node server (with projects and settings added) and /api/chat.

mod support;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use http_body_util::BodyExt;
use llm_agent::{config::Secret, web};
use serde_json::{Value, json};
use support::*;
use tower::ServiceExt;

struct Client {
    router: axum::Router,
    token: Option<String>,
}

struct Reply {
    status: StatusCode,
    etag: Option<String>,
    content_type: String,
    body: Value,
    text: String,
}

impl Client {
    async fn send(&self, method: &str, path: &str, body: Option<Value>, revision: Option<&str>, admin: bool) -> Reply {
        let mut request = Request::builder().method(method).uri(path);
        if admin {
            request = request.header("x-admin-request", "1");
            if let Some(token) = &self.token {
                request = request.header("x-admin-token", token);
            }
        }
        if let Some(revision) = revision {
            request = request.header(header::IF_MATCH, format!("\"{revision}\""));
        }
        let request = match body {
            Some(body) => request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let etag = response
            .headers()
            .get(header::ETAG)
            .map(|v| v.to_str().unwrap().trim_matches('"').to_owned());
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .map(|v| v.to_str().unwrap().to_owned())
            .unwrap_or_default();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        Reply { status, etag, content_type, body, text }
    }
    async fn admin(&self, method: &str, path: &str, body: Option<Value>, revision: Option<&str>) -> Reply {
        self.send(method, &format!("/api/admin/{path}"), body, revision, true).await
    }
}

#[tokio::test]
async fn admin_records_keep_the_former_contract() {
    let Some(db) = TestDb::create("admin") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let mut config = db.config();
    config.admin_token = Some(Secret("secret".into()));
    let (app, _dir) = app(config, Scripted::new(vec![]));
    let anonymous = Client { router: web::router(app.clone()), token: None };
    let client = Client { router: web::router(app.clone()), token: Some("secret".into()) };

    let r = anonymous.send("GET", "/api/admin/knowledge", None, None, false).await;
    assert_eq!((r.status, r.body["error"].as_str()), (StatusCode::FORBIDDEN, Some("관리자 화면에서 다시 시도해주세요.")));
    assert_eq!(anonymous.admin("GET", "knowledge", None, None).await.status, StatusCode::UNAUTHORIZED);

    let list = client.admin("GET", "knowledge?page=1", None, None).await;
    assert_eq!(list.status, StatusCode::OK);
    assert_eq!(list.body["pageSize"], 20);
    assert_eq!(list.body["total"], 2);
    assert_eq!(client.admin("GET", "knowledge?page=0", None, None).await.status, StatusCode::BAD_REQUEST);
    assert_eq!(client.admin("GET", "unknown", None, None).await.status, StatusCode::NOT_FOUND);

    // Create, read, update with the revision, refuse stale and missing ones.
    let created = client
        .admin("POST", "knowledge", Some(json!({"title":" 새 지식 ","content":"본문 "})), None)
        .await;
    assert_eq!(created.status, StatusCode::CREATED);
    assert_eq!(created.body["title"], "새 지식");
    assert_eq!(created.body["content"], "본문 ");
    let seq = created.body["seq"].as_i64().unwrap();
    let revision = created.etag.clone().unwrap();
    assert_eq!(created.body["revision"], revision.as_str());
    let duplicate = client.admin("POST", "knowledge", Some(json!({"title":"새 지식","content":"x"})), None).await;
    assert_eq!((duplicate.status, duplicate.body["error"].as_str()), (StatusCode::CONFLICT, Some("같은 이름의 항목이 이미 있습니다.")));
    let missing = client.admin("PUT", &format!("knowledge/{seq}"), Some(json!({"title":"a","content":"b"})), None).await;
    assert_eq!(missing.status, StatusCode::PRECONDITION_REQUIRED);
    let updated = client
        .admin("PUT", &format!("knowledge/{seq}"), Some(json!({"title":"고친 지식","content":"b"})), Some(&revision))
        .await;
    assert_eq!(updated.status, StatusCode::OK);
    let stale = client
        .admin("PUT", &format!("knowledge/{seq}"), Some(json!({"title":"다시","content":"b"})), Some(&revision))
        .await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    let deleted = client.admin("DELETE", &format!("knowledge/{seq}"), None, updated.etag.as_deref()).await;
    assert_eq!(deleted.status, StatusCode::NO_CONTENT);
    assert_eq!(client.admin("GET", &format!("knowledge/{seq}"), None, None).await.status, StatusCode::NOT_FOUND);

    // Target DBs: the password stays when left empty and is never returned.
    let databases = client.admin("GET", "database-options", None, None).await;
    let order_db = databases.body["items"][0]["seq"].as_i64().unwrap();
    let record = client.admin("GET", &format!("databases/{order_db}"), None, None).await;
    assert!(record.body.get("db_password").is_none());
    assert_eq!(record.body["has_password"], 1);
    let renamed = client
        .admin(
            "PUT",
            &format!("databases/{order_db}"),
            Some(json!({"db_name":"RENAMED","db_type":"oracle","connection_info":"h:1/s","db_user":"u","db_password":""})),
            record.etag.as_deref(),
        )
        .await;
    assert_eq!(renamed.status, StatusCode::CONFLICT, "a DB used by queries cannot be renamed: {}", renamed.text);
    let kept = client
        .admin(
            "PUT",
            &format!("databases/{order_db}"),
            Some(json!({"db_name":"ORDER_DB","db_type":"oracle","connection_info":"h:1/s","db_user":"u","db_password":""})),
            record.etag.as_deref(),
        )
        .await;
    assert_eq!(kept.status, StatusCode::OK, "{}", kept.text);
    assert_eq!(db.scalar("SELECT db_password FROM target_db WHERE db_name = 'ORDER_DB'"), "ENV:ORDER_DB_PASSWORD");

    // Queries: the target list is canonicalized; unknown targets and
    // methods that name the query block a change.
    let query = client
        .admin(
            "POST",
            "queries",
            Some(json!({"query_name":"new_query","query_sql":"SELECT 1 FROM dual WHERE a = :x","target_db_name":" order_db ;order_db"})),
            None,
        )
        .await;
    assert_eq!(query.status, StatusCode::CREATED, "{}", query.text);
    assert_eq!(query.body["target_db_name"], "ORDER_DB");
    assert_eq!(query.body["query_type"], "QUERY");
    let unknown = client
        .admin("POST", "queries", Some(json!({"query_name":"q2","query_sql":"SELECT 1 FROM dual","target_db_name":"NOPE"})), None)
        .await;
    assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
    let write = client
        .admin("POST", "queries", Some(json!({"query_name":"q3","query_sql":"DELETE FROM t","target_db_name":"ORDER_DB"})), None)
        .await;
    assert_eq!(write.body["error"], "조회(SELECT) 쿼리만 실행할 수 있습니다.");
    let referenced = db.scalar("SELECT seq FROM query_registry WHERE query_name = 'batch_job_status'");
    let record = client.admin("GET", &format!("queries/{referenced}"), None, None).await;
    let refused = client.admin("DELETE", &format!("queries/{referenced}"), None, record.etag.as_deref()).await;
    assert_eq!(refused.status, StatusCode::CONFLICT);
    assert!(refused.body["error"].as_str().unwrap().contains("배치 작업 상태 확인"));
    let search = client.admin("GET", "queries?q=batch", None, None).await;
    assert_eq!(search.body["total"].as_i64(), Some(search.body["items"].as_array().unwrap().len() as i64));
    assert!(search.body["items"].as_array().unwrap().iter().all(|i| i["name"].as_str().unwrap().contains("batch")));
    assert_eq!(search.body["items"][0]["query_type"], "QUERY");
}

#[tokio::test]
async fn projects_settings_and_folders_are_editable() {
    let Some(db) = TestDb::create("settings") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let (app, dir) = app(db.config(), Scripted::new(vec![]));
    let client = Client { router: web::router(app.clone()), token: None };
    let root = dir.path().join("proj");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("README.md"), "# 프로젝트").unwrap();

    let missing = client
        .admin("POST", "projects", Some(json!({"name":"앱","root":root.join("nope"),"docs":""})), None)
        .await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    let created = client
        .admin(
            "POST",
            "projects",
            Some(json!({"name":"앱","description":"주문 앱","root":root,"docs":"README.md\n","include":"","exclude":"**/*.log"})),
            None,
        )
        .await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text);
    assert_eq!(created.body["seq"], 1);
    assert_eq!(created.body["docs"], "README.md");
    let list = client.admin("GET", "projects", None, None).await;
    assert_eq!(list.body["items"][0]["summary"], "주문 앱");
    assert_eq!(app.config().projects[0].exclude, vec!["**/*.log"]);
    let saved = std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
    assert!(saved.contains("[[projects]]"));
    let duplicate = client.admin("POST", "projects", Some(json!({"name":"앱","root":root})), None).await;
    assert_eq!(duplicate.status, StatusCode::CONFLICT);
    let removed = client.admin("DELETE", "projects/1", None, created.etag.as_deref()).await;
    assert_eq!(removed.status, StatusCode::NO_CONTENT);
    assert!(app.config().projects.is_empty());

    // Settings: secrets are write-only; the revision guards concurrent edits.
    let settings = client.admin("GET", "settings", None, None).await;
    assert_eq!(settings.body["secrets"]["llm_api_key"], false);
    assert!(settings.body["config"].get("projects").is_none());
    let revision = settings.etag.clone().unwrap();
    let saved = client
        .admin(
            "PUT",
            "settings",
            Some(json!({"config":{"agent":{"max_rounds":12,"max_tool_calls":8}},"secrets":{"llm_api_key":"sk-new"}})),
            Some(&revision),
        )
        .await;
    assert_eq!(saved.status, StatusCode::OK, "{}", saved.text);
    assert_eq!(saved.body["config"]["agent"]["max_rounds"], 12);
    assert_eq!(saved.body["config"]["agent"]["max_tool_calls"], 8);
    assert_eq!(app.config().tool_call_limit(), 8);
    assert_eq!(saved.body["secrets"]["llm_api_key"], true);
    assert!(!saved.text.contains("sk-new"));
    assert_eq!(app.config().llm.api_key.as_ref().unwrap().0, "sk-new");
    let stale = client.admin("PUT", "settings", Some(json!({"config":{}})), Some(&revision)).await;
    assert_eq!(stale.status, StatusCode::CONFLICT);
    let invalid = client
        .admin("PUT", "settings", Some(json!({"config":{"agent":{"low_water":0.95}}})), saved.etag.as_deref())
        .await;
    assert_eq!(invalid.status, StatusCode::BAD_REQUEST);
    // More calls than one response can carry.
    let too_many = client
        .admin("PUT", "settings", Some(json!({"config":{"agent":{"max_tool_calls":llm_agent::llm::MAX_TOOL_CALLS + 1}}})), saved.etag.as_deref())
        .await;
    assert_eq!(too_many.status, StatusCode::BAD_REQUEST);
    assert!(too_many.body["error"].as_str().unwrap().contains("도구 호출 수"), "{}", too_many.text);
    let checked = client.admin("POST", "settings/check", Some(json!({"target":"mariadb"})), None).await;
    assert_eq!(checked.body["ok"], true, "{}", checked.text);

    let folders = client
        .admin("GET", &format!("directories?path={}", root.display()), None, None)
        .await;
    assert_eq!(folders.body["directories"][0]["name"], "src");
}

#[tokio::test]
async fn chat_streams_ndjson_and_logs_each_outcome() {
    let Some(db) = TestDb::create("chat") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let llm = Scripted::new(vec![
        calls(vec![call("c1", "query_run", json!({"query_name":"find_customer_id","params":{"customer_name":"홍길동"}}))]),
        text("홍길동 고객의 ID는 C-1001입니다."),
    ]);
    let (app, _dir) = app(db.config(), llm);
    let client = Client { router: web::router(app.clone()), token: None };

    let r = client.send("POST", "/api/chat", Some(json!({"message":"  "})), None, false).await;
    assert_eq!((r.status, r.body["error"].as_str()), (StatusCode::BAD_REQUEST, Some("message가 필요합니다.")));
    let long = "가".repeat(2001);
    let r = client.send("POST", "/api/chat", Some(json!({"message":long})), None, false).await;
    assert_eq!(r.body["error"], "질문이 너무 깁니다 (최대 2,000자).");
    let request = Request::builder()
        .method("POST")
        .uri("/api/chat")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{not json"))
        .unwrap();
    let response = client.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let request = Request::builder()
        .method("POST")
        .uri("/api/chat")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/x-ndjson")
        .body(Body::from(json!({"conversation_id":"web-1","message":"홍길동 고객 ID?","history":[]}).to_string()))
        .unwrap();
    let response = client.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/x-ndjson; charset=utf-8");
    assert_eq!(response.headers()["x-accel-buffering"], "no");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let events: Vec<Value> = String::from_utf8_lossy(&bytes)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let done = events.last().unwrap();
    assert_eq!(done["type"], "done");
    assert_eq!(done["answer"], "홍길동 고객의 ID는 C-1001입니다.");
    assert_eq!(done["trace"][0]["rows"][0]["CUSTOMER_ID"], "C-1001");
    assert_eq!(ev(&events, "run_query_done")[0]["rowCount"], 1);

    // Without the NDJSON Accept header: one JSON body.
    let plain = client
        .send("POST", "/api/chat", Some(json!({"message":"질문"})), None, false)
        .await;
    assert_eq!(plain.status, StatusCode::OK);
    assert!(plain.content_type.starts_with("application/json"));
    assert!(plain.body["answer"].is_string());

    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    assert_eq!(db.scalar("SELECT COUNT(*) FROM chat_log WHERE JSON_VALUE(trace, '$.outcome') = 'answered'"), "2");
    assert_eq!(db.scalar("SELECT COUNT(*) FROM chat_log WHERE JSON_VALUE(trace, '$.outcome') = 'rejected'"), "3");
    assert_eq!(db.scalar("SELECT JSON_VALUE(trace, '$.v') FROM chat_log ORDER BY seq DESC LIMIT 1"), "5");
}

async fn eventually(mut check: impl FnMut() -> bool) -> bool {
    for _ in 0..100 {
        if check() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    false
}

/// A run lets go of its conversation however its request ends, and a
/// conversation nothing can continue is not kept. Runs without MariaDB (the
/// chat log is checked when one is configured).
#[tokio::test]
async fn conversations_are_released_when_requests_end() {
    let db = TestDb::create("release");
    let config = db.as_ref().map(TestDb::config).unwrap_or_else(|| {
        let mut config = llm_agent::config::Config::default();
        config.mariadb.port = 9;
        config.mariadb.user = "nobody".into();
        config.llm.base_url = "http://127.0.0.1:9/v1".into();
        config.llm.model = "gpt-4o".into();
        config
    });
    let llm = Scripted::new(vec![]);
    llm.hang.store(true, std::sync::atomic::Ordering::Relaxed);
    let (app, _dir) = app(config, llm.clone());
    let router = web::router(app.clone());
    let chat = |body: Value, stream: bool| {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/chat")
            .header(header::CONTENT_TYPE, "application/json");
        if stream {
            request = request.header(header::ACCEPT, "application/x-ndjson");
        }
        request.body(Body::from(body.to_string())).unwrap()
    };
    let idle = std::time::Duration::ZERO;

    // The client goes away while the model is answering: the plain request's
    // handler is dropped, the stream's body is dropped.
    let pending = tokio::spawn(router.clone().oneshot(chat(json!({"conversation_id":"plain","message":"질문"}), false)));
    assert!(eventually(|| llm.requests().len() == 1).await);
    pending.abort();
    let response = router.clone().oneshot(chat(json!({"conversation_id":"stream","message":"질문"}), true)).await.unwrap();
    assert!(eventually(|| llm.requests().len() == 2).await);
    drop(response);
    assert!(
        eventually(|| {
            app.sessions.sweep(idle);
            app.sessions.len() == 0
        })
        .await,
        "a run whose client left still holds its conversation"
    );

    // A request without conversation_id leaves nothing behind; one with an
    // id is kept for its next question.
    llm.hang.store(false, std::sync::atomic::Ordering::Relaxed);
    llm.push(vec![text("답 하나"), text("답 둘")]);
    let once = router.clone().oneshot(chat(json!({"message":"질문"}), false)).await.unwrap();
    assert_eq!(once.status(), StatusCode::OK);
    assert_eq!(app.sessions.len(), 0);
    let kept = router.clone().oneshot(chat(json!({"conversation_id":"kept","message":"질문"}), false)).await.unwrap();
    assert_eq!(kept.status(), StatusCode::OK);
    assert_eq!(app.sessions.len(), 1);

    if let Some(db) = db {
        assert!(
            eventually(|| db.scalar("SELECT COUNT(*) FROM chat_log WHERE JSON_VALUE(trace, '$.outcome') = 'cancelled'") == "2").await,
            "both dropped requests are logged as cancelled"
        );
    }
}

/// A model client that panics mid-run.
struct Panicking;
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for Panicking {
    async fn complete(
        &self,
        _request: Value,
        _config: &llm_agent::config::LlmConfig,
        _cancel: tokio_util::sync::CancellationToken,
        _delta: tokio::sync::mpsc::Sender<String>,
    ) -> anyhow::Result<llm_agent::llm::Completion> {
        panic!("model client bug");
    }
}

/// A run that panics still answers its request with an error: the stream
/// ends with an error event rather than just stopping, and the question is
/// logged. Its conversation is released.
#[tokio::test]
async fn a_run_that_panics_ends_with_an_error() {
    let db = TestDb::create("panic");
    let config = db.as_ref().map(TestDb::config).unwrap_or_else(|| {
        let mut config = llm_agent::config::Config::default();
        config.mariadb.port = 9;
        config.mariadb.user = "nobody".into();
        config.llm.base_url = "http://127.0.0.1:9/v1".into();
        config.llm.model = "gpt-4o".into();
        config
    });
    let (app, _dir) = app(config, std::sync::Arc::new(Panicking));
    let client = Client { router: web::router(app.clone()), token: None };
    let request = Request::builder()
        .method("POST")
        .uri("/api/chat")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/x-ndjson")
        .body(Body::from(json!({"conversation_id":"p1","message":"질문"}).to_string()))
        .unwrap();
    let response = client.router.clone().oneshot(request).await.unwrap();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let events: Vec<Value> = String::from_utf8_lossy(&bytes)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(events.last().map(|e| e["type"].clone()), Some(json!("error")), "{events:?}");
    let plain = client.send("POST", "/api/chat", Some(json!({"message":"질문"})), None, false).await;
    assert_eq!(plain.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(plain.body["error"], "처리 중 오류가 발생했습니다.");
    app.sessions.sweep(std::time::Duration::ZERO);
    assert_eq!(app.sessions.len(), 0);
    if let Some(db) = db {
        assert!(
            eventually(|| db.scalar("SELECT COUNT(*) FROM chat_log WHERE JSON_VALUE(trace, '$.outcome') = 'error'") == "2").await,
            "both panicked runs are logged"
        );
    }
}

/// One binary serves the screen too: `/` and the built files from the
/// embedded frontend/dist, while unknown API paths stay JSON 404s.
#[tokio::test]
async fn the_binary_serves_the_built_screen() {
    let mut config = llm_agent::config::Config::default();
    config.mariadb.port = 9;
    let (app, _dir) = app(config, Scripted::new(vec![]));
    let get = |method: &str, path: &str| {
        let router = web::router(app.clone());
        let request = Request::builder().method(method).uri(path).body(Body::empty()).unwrap();
        async move { router.oneshot(request).await.unwrap() }
    };
    let index = get("GET", "/").await;
    if index.status() == StatusCode::SERVICE_UNAVAILABLE {
        return skip("frontend/dist was not built when this binary was compiled");
    }
    assert_eq!(index.status(), StatusCode::OK);
    assert_eq!(index.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
    assert_eq!(index.headers()[header::CACHE_CONTROL], "no-cache");
    let html = String::from_utf8(index.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    let script = html.split("src=\"").nth(1).and_then(|rest| rest.split('"').next()).expect("index.html loads a script");
    let asset = get("GET", script).await;
    assert_eq!(asset.status(), StatusCode::OK, "{script}");
    assert_eq!(asset.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
    assert!(asset.headers()[header::CACHE_CONTROL].to_str().unwrap().contains("immutable"));

    assert_eq!(get("GET", "/assets/missing.js").await.status(), StatusCode::NOT_FOUND);
    assert_eq!(get("POST", "/").await.status(), StatusCode::NOT_FOUND);
    let api = get("GET", "/api/missing").await;
    assert_eq!(api.status(), StatusCode::NOT_FOUND);
    assert!(api.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with("application/json"));
}

/// Shutdown does not wait on a client that sent part of a request (one that
/// went away mid-upload): before, the process stayed up until that
/// connection closed, and a second Ctrl+C did nothing.
#[tokio::test]
async fn shutdown_does_not_wait_for_a_half_sent_request() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut config = llm_agent::config::Config::default();
    config.mariadb.port = 9;
    let (app, _dir) = app(config, Scripted::new(vec![]));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let signal = tokio_util::sync::CancellationToken::new();
    let trigger = signal.clone();
    let server = tokio::spawn(web::serve(listener, app, async move { trigger.cancelled().await }));

    let mut served = tokio::net::TcpStream::connect(address).await.unwrap();
    served.write_all(b"GET /api/health HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
    let mut reply = [0u8; 256];
    let n = served.read(&mut reply).await.unwrap();
    assert!(String::from_utf8_lossy(&reply[..n]).starts_with("HTTP/1.1 200"));
    let mut half_head = tokio::net::TcpStream::connect(address).await.unwrap();
    half_head.write_all(b"GET /api/health HTTP/1.1\r\nHost: x\r\n").await.unwrap();
    let mut half_body = tokio::net::TcpStream::connect(address).await.unwrap();
    half_body
        .write_all(b"POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"message\":")
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let started = std::time::Instant::now();
    signal.cancel();
    let stopped = tokio::time::timeout(web::SHUTDOWN_GRACE + std::time::Duration::from_secs(3), server).await;
    assert!(matches!(stopped, Ok(Ok(Ok(())))), "the server is still waiting on open connections");
    assert!(started.elapsed() >= web::SHUTDOWN_GRACE, "in-flight requests get the grace period");
    drop((half_head, half_body));
}

/// A connection check runs on the draft settings without saving them, so
/// they are checked first: a pool size far past the limit used to reach the
/// pool and panic allocating it (a little smaller and the allocation failure
/// aborted the whole process).
#[tokio::test]
async fn connection_checks_refuse_settings_out_of_range() {
    let mut config = llm_agent::config::Config::default();
    config.mariadb.port = 9;
    let (app, _dir) = app(config, Scripted::new(vec![]));
    let client = Client { router: web::router(app.clone()), token: None };
    for (target, section) in [
        ("mariadb", json!({"mariadb":{"pool_size":1u64 << 60}})),
        ("embedding", json!({"embedding":{"url":"http://127.0.0.1:9/v1","ef_search":0}})),
    ] {
        let r = client.admin("POST", "settings/check", Some(json!({"target":target,"config":section})), None).await;
        assert_eq!(r.status, StatusCode::OK, "{target}: {}", r.text);
        assert_eq!(r.body["ok"], false, "{target}: {}", r.text);
    }
    let r = client.admin("POST", "settings/check", Some(json!({"target":"mariadb","config":{"mariadb":{"pool_size":1u64 << 60}}})), None).await;
    assert!(r.body["message"].as_str().unwrap().contains("풀 크기"), "{}", r.text);
}
