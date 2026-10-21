//! Title matches beside the vector search, on a throwaway MariaDB database:
//! the ranking of several words, whole and partial words, escaping, and the
//! search tool with and without the embedding server.

mod support;

use llm_agent::{
    agent::{self, Events, Question},
    db::Db,
    search::{self, KNOWLEDGE_TITLES, METHOD_TITLES, QUERY_TEXTS, TitleSource},
};
use serde_json::{Value, json};
use support::*;
use tokio_util::sync::CancellationToken;

const TITLES: &str = "INSERT INTO knowledge (title, content) VALUES
  ('DocCraftAgent UserManual', '문서 작성 에이전트 사용 설명서. 템플릿을 고르고 초안을 만든다.'),
  ('term34 설치 가이드', '설치 순서'),
  ('term342 설치 가이드', '다른 설치 순서'),
  ('고객주문 현황', '붙여 쓴 제목'),
  ('고객 주문 현황 보고', '띄어 쓴 제목'),
  ('프로시저로 주문 조회하기', '조사가 붙은 제목'),
  ('저장프로시저 목록', '앞에 붙은 제목'),
  ('100% 달성 보고서', '퍼센트'),
  ('1000 달성 보고서', '숫자'),
  ('C++ (VM) 가이드', '기호'),
  ('vLLM', '대소문자');";

async fn titles(db: &Db, config: &llm_agent::config::Config, source: &TitleSource, text: &str, near: &[(i64, f64)]) -> (Vec<String>, usize) {
    let found = search::title_matches(db, &config.mariadb, source, text, near, 5).await.unwrap();
    let label = if std::ptr::eq(source, &QUERY_TEXTS) { "query_name" } else { "title" };
    (found.rows.iter().map(|r| r[label].as_str().unwrap().to_owned()).collect(), found.total)
}

#[tokio::test]
async fn several_words_rank_by_how_rare_and_whole_they_are() {
    let Some(test_db) = TestDb::create("titles") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in(TITLES);
    let config = test_db.config();
    let db = Db::default();
    let seq = |title: &str| test_db.scalar(&format!("SELECT seq FROM knowledge WHERE title = '{title}'")).parse::<i64>().unwrap();

    // A rare word outweighs common ones: titles holding only 설치 leave.
    assert_eq!(titles(&db, &config, &KNOWLEDGE_TITLES, "DocCraftAgent 설치", &[]).await, (vec!["DocCraftAgent UserManual".into()], 1));
    // Tied scores go to the nearer vector result, then the shorter title.
    let both = "DocCraftAgent 설치 방법";
    assert_eq!(
        titles(&db, &config, &KNOWLEDGE_TITLES, both, &[]).await.0,
        ["배치 재시작 방법", "DocCraftAgent UserManual"]
    );
    let near = [(seq("DocCraftAgent UserManual"), 0.29), (seq("배치 재시작 방법"), 0.65)];
    assert_eq!(
        titles(&db, &config, &KNOWLEDGE_TITLES, both, &near).await,
        (vec!["DocCraftAgent UserManual".into(), "배치 재시작 방법".into()], 2)
    );

    // A word inside a longer word counts half, and half the best leaves.
    assert_eq!(titles(&db, &config, &KNOWLEDGE_TITLES, "term34", &[]).await, (vec!["term34 설치 가이드".into()], 1));
    assert_eq!(
        titles(&db, &config, &KNOWLEDGE_TITLES, "주문", &[]).await,
        (vec!["고객 주문 현황 보고".into(), "프로시저로 주문 조회하기".into()], 2)
    );
    // A Korean particle may follow a whole word; a letter before it may not.
    assert_eq!(titles(&db, &config, &KNOWLEDGE_TITLES, "프로시저", &[]).await, (vec!["프로시저로 주문 조회하기".into()], 1));
    // Without a whole match the parts are all there is.
    assert_eq!(titles(&db, &config, &KNOWLEDGE_TITLES, "term3", &[]).await.1, 2);

    // LIKE and REGEXP syntax in a word is a character; case does not count.
    assert_eq!(titles(&db, &config, &KNOWLEDGE_TITLES, "100%", &[]).await, (vec!["100% 달성 보고서".into()], 1));
    assert_eq!(titles(&db, &config, &KNOWLEDGE_TITLES, "C++ (VM)", &[]).await, (vec!["C++ (VM) 가이드".into()], 1));
    let found = search::title_matches(&db, &config.mariadb, &KNOWLEDGE_TITLES, "vllm", &[], 5).await.unwrap();
    assert_eq!(found.rows[0]["title"], "vLLM");
    assert_eq!(found.rows[0]["_matched"], json!(["vllm"]));
    for helper in ["_s0", "_w0", "_exact", "_phrase", "_near", "_len", "_score"] {
        assert!(!found.rows[0].contains_key(helper), "{helper}");
    }
    // Nothing to look for, nothing found.
    assert_eq!(titles(&db, &config, &KNOWLEDGE_TITLES, "가 나", &[]).await, (vec![], 0));
    assert_eq!(titles(&db, &config, &KNOWLEDGE_TITLES, "없는낱말", &[]).await, (vec![], 0));

    // Methods by title.
    assert_eq!(
        titles(&db, &config, &METHOD_TITLES, "고객 주문 상태", &[]).await,
        (vec!["고객 주문 상태 확인".into(), "함수로 고객 주문 합계 조회".into(), "프로시저로 고객 주문 목록 조회".into()], 3)
    );

    // Queries by name and description: Korean words find the description,
    // English ones the name; a value in the search (홍길동) is no match and
    // no obstacle, and one common word alone leaves.
    for (text, expected) in [
        ("배송 상태", "order_status_by_customer"),
        ("홍길동 주문 상태", "order_status_by_customer"),
        ("order status", "order_status_by_customer"),
        ("고객 등급", "find_customer_id"),
        // A part of a name as written (tool review, 2026-10-21, third pass).
        ("batch_job", "batch_job_status"),
        ("customer_order 합계", "get_customer_order_total_fn"),
    ] {
        assert_eq!(titles(&db, &config, &QUERY_TEXTS, text, &[]).await, (vec![expected.into()], 1), "{text}");
    }
}

async fn ask(app: &std::sync::Arc<llm_agent::app::App>, message: &str) -> (anyhow::Result<agent::Answer>, Vec<Value>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let result = agent::answer(
        app,
        Question {
            conversation_id: "titles".into(),
            message: message.into(),
            history: vec![],
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

/// Without an embedding server the titles are still searched: a target
/// with title matches answers with them, one without stays unavailable.
#[tokio::test]
async fn titles_are_found_without_the_embedding_server() {
    let Some(test_db) = TestDb::create("titles_noembed") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in(TITLES);
    let mut config = test_db.config();
    config.embedding.url = String::new();
    let doc = test_db.scalar("SELECT seq FROM knowledge WHERE title = 'DocCraftAgent UserManual'");
    let llm = Scripted::new(vec![
        calls(vec![
            call("s1", "search", json!({"query":"DocCraftAgent"})),
            call("s2", "search", json!({"query":"배송 상태","targets":["query"]})),
        ]),
        calls(vec![call("r1", "knowledge_read", json!({"id":format!("k{doc}")}))]),
        text("문서 작성 에이전트 설명서입니다."),
    ]);
    let (app, _dir) = app(config, llm.clone());
    let (result, events) = ask(&app, "DocCraftAgent가 뭐야?").await;
    result.unwrap();
    let requests = llm.requests();

    let found = tool_result(&requests[1], "s1")["data"]["results"].clone();
    let knowledge = &found["knowledge"];
    assert_eq!(knowledge["status"], "ok", "{found}");
    // Not chunked yet (no sync ran): its chunk count comes from the content.
    assert_eq!(knowledge["items"][0]["id"], format!("k{doc}"));
    assert_eq!(knowledge["items"][0]["chunk_of"], 1);
    assert_eq!(knowledge["items"][0]["title_match"], true);
    assert_eq!(knowledge["items"][0]["matched_words"], json!(["DocCraftAgent"]));
    assert!(knowledge["items"][0]["excerpt"].as_str().unwrap().starts_with("문서 작성 에이전트"));
    assert!(knowledge["note"].as_str().unwrap().starts_with("제목에 낱말이 든 항목만 찾았다"), "{knowledge}");
    assert_eq!(knowledge["title_matches"], 1);
    assert_eq!(found["qa_method"]["status"], "search_unavailable", "no title match is not 'nothing registered'");
    let queries = &tool_result(&requests[1], "s2")["data"]["results"]["query"];
    assert_eq!(queries["items"][0]["name"], "order_status_by_customer", "{queries}");
    assert_eq!(queries["items"][0]["title_match"], true);
    assert!(queries["note"].as_str().unwrap().starts_with("이름이 정확히 맞거나 이름·설명에 낱말이 든 쿼리만"), "{queries}");

    let done = ev(&events, "search_done");
    let first = done.iter().find(|e| e["text"] == "DocCraftAgent").unwrap();
    assert_eq!(first["hits"]["knowledge"], 1, "{done:?}");
    assert!(first["hits"]["qaMethods"].is_null() && first["failed"] == json!(["qa_method", "query"]), "{done:?}");
    // The document a title match found is readable.
    let read = tool_result(&requests[2], "r1");
    assert!(read["data"]["text"].as_str().unwrap().contains("템플릿을 고르고"), "{read}");
}

/// With the vector search, title matches take part of the first page: the
/// vector result they repeat is shown once, with its distance, and the
/// next page holds no title matches.
#[tokio::test]
async fn title_matches_share_the_first_page_with_vector_results() {
    let Some(test_db) = TestDb::create("titles_vector") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in(TITLES);
    let config = test_db.config();
    if !embedding_available(&config).await {
        return skip("no embedding server");
    }
    let many = (0..30).map(|i| format!("('SPACE 운영 문서 {i}', '설비 운영 절차 {i}')")).collect::<Vec<_>>().join(", ");
    test_db.sql_in(&format!("INSERT INTO knowledge (title, content) VALUES {many};"));
    let llm = Scripted::new(vec![
        calls(vec![
            call("s1", "search", json!({"query":"DocCraftAgent","targets":["knowledge"],"limit":3})),
            call("s2", "search", json!({"query":"SPACE","targets":["knowledge"],"limit":10})),
        ]),
        calls(vec![call("s3", "search", json!({"query":"SPACE","targets":["knowledge"],"limit":10,"offset":1}))]),
        text("끝"),
    ]);
    let (app, _dir) = app(config, llm.clone());
    let config = app.config();
    app.sync.run(&app.db, &config, &app.shutdown).await.unwrap();
    let (result, _) = ask(&app, "DocCraftAgent와 SPACE 문서").await;
    result.unwrap();
    let requests = llm.requests();

    let one = &tool_result(&requests[1], "s1")["data"]["results"]["knowledge"];
    let items = one["items"].as_array().unwrap();
    assert!(items.len() <= 3, "{one}");
    assert_eq!(items[0]["title"], "DocCraftAgent UserManual", "{one}");
    assert_eq!(items[0]["title_match"], true);
    assert!(items[0]["distance"].is_number(), "found both ways, it keeps its distance: {one}");
    let ids: Vec<&str> = items.iter().map(|i| i["id"].as_str().unwrap()).collect();
    assert_eq!(ids.iter().filter(|id| **id == ids[0]).count(), 1, "shown once: {one}");

    // 30 titles hold SPACE: five are shown, all are counted, the rest of
    // the page is vector results (most of these titles are past the
    // distance threshold: the title match is what shows them).
    let common = &tool_result(&requests[1], "s2")["data"]["results"]["knowledge"];
    let items = common["items"].as_array().unwrap();
    assert!(items.len() <= 10, "{common}");
    assert_eq!(items.iter().filter(|i| i["title_match"] == true).count(), 5, "{common}");
    assert!(items[5..].iter().all(|i| i["distance"].is_number() && i.get("title_match").is_none()), "{common}");
    assert_eq!(common["title_matches"], 30);
    assert!(common["note"].as_str().unwrap().contains("30건 중 5건"), "{common}");
    let next = &tool_result(&requests[2], "s3")["data"]["results"]["knowledge"];
    let next_items = next["items"].as_array().unwrap();
    assert!(!next_items.is_empty() && next_items.iter().all(|i| i.get("title_match").is_none()), "{next}");
    assert!(next.get("title_matches").is_none(), "{next}");
}
