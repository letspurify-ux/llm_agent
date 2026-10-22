//! A search reads at most `search::MAX_CANDIDATES` candidates, on a
//! throwaway MariaDB database with the embedding server: a page past them
//! says it was cut there, a page at the true end does not. Apart from
//! `search_paging`, whose pages its many index writes would shake.

mod support;

use llm_agent::search;
use serde_json::json;
use support::*;
use tokio_util::sync::CancellationToken;

/// Asks one question of the scripted model.
async fn ask(app: &std::sync::Arc<llm_agent::app::App>, message: &str) -> anyhow::Result<llm_agent::agent::Answer> {
    let question = llm_agent::agent::Question { conversation_id: "cap".into(), message: message.into(), history: vec![] };
    llm_agent::agent::answer(app, question, llm_agent::agent::Events::new(None), CancellationToken::new()).await
}

/// Runs the embedding sync to the end: a sync that finds another (a
/// backend on the same server) holding the server's sync lock skips.
async fn synced(app: &std::sync::Arc<llm_agent::app::App>) {
    let config = app.config();
    while app.sync.run(&app.db, &config, &app.shutdown).await.unwrap().skipped == llm_agent::embed_sync::Skipped::Busy {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// One search reads at most `MAX_CANDIDATES` rows: a page past them says it
/// was cut there, a page at the true end does not.
#[tokio::test]
async fn a_page_past_the_candidates_one_search_reads_says_so() {
    let Some(test_db) = TestDb::create("paging_cap") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let mut config = test_db.config();
    if !embedding_available(&config).await {
        return skip("no embedding server");
    }
    config.embedding.max_distance = 2.0;
    let count = search::MAX_CANDIDATES + 5;
    let values = (0..count).map(|i| format!("('주차 규칙 {i}', '주차장 이용 규칙 {i}번 항목이다.')")).collect::<Vec<_>>().join(", ");
    test_db.sql_in(&format!("INSERT INTO qa_method (title, method) VALUES {values};"));
    test_db.sql_in(&format!("INSERT INTO knowledge (title, content) VALUES {values};"));
    let far = json!({"query":"주차장 이용 규칙","limit":10,"offset":search::MAX_CANDIDATES});
    let with = |targets: &str| {
        let mut args = far.clone();
        args["targets"] = json!([targets]);
        args
    };
    let llm = Scripted::new(vec![
        calls(vec![call("s1", "search", with("qa_method")), call("s2", "search", with("knowledge"))]),
        text("끝"),
        calls(vec![call("s3", "search", with("qa_method"))]),
        text("끝"),
    ]);
    let (app, _dir) = app(config, llm.clone());
    let config = app.config();
    synced(&app).await;
    let vector = app.embeddings.embed(&config.embedding, "주차장 이용 규칙", &CancellationToken::new()).await.unwrap();
    let first = search::rows(&app.db, &config, "qa_method", &vector, 0, 10).await.unwrap();
    assert!(first.items.len() == 10 && first.more && !first.capped);
    let past = search::rows(&app.db, &config, "qa_method", &vector, search::MAX_CANDIDATES, 10).await.unwrap();
    assert!(past.items.is_empty() && !past.more && past.capped, "rows past the candidates read are not the end of the table");
    let first = search::knowledge(&app.db, &config, &vector, 0, 10).await.unwrap();
    assert!(first.items.len() == 10 && first.more && !first.capped);
    let past = search::knowledge(&app.db, &config, &vector, search::MAX_CANDIDATES, 10).await.unwrap();
    assert!(!past.more && past.capped, "documents past the candidates read are not the last ones");
    // The search tool says the page ended at the candidates it read.
    ask(&app, "주차 규칙 더").await.unwrap();
    let requests = llm.requests();
    let cut = format!("의미 검색은 가까운 후보 {}건까지만 읽어", search::MAX_CANDIDATES);
    for (id, target) in [("s1", "qa_method"), ("s2", "knowledge")] {
        let page = &tool_result(&requests[1], id)["data"]["results"][target];
        assert!(page["next_offset"].is_null() && page["note"].as_str().unwrap().starts_with(&cut), "{page}");
    }
    // A table read whole ends without the note.
    test_db.sql_in("DELETE FROM qa_method WHERE seq > 3;");
    synced(&app).await;
    let end = search::rows(&app.db, &config, "qa_method", &vector, search::MAX_CANDIDATES, 10).await.unwrap();
    assert!(end.items.is_empty() && !end.more && !end.capped);
    ask(&app, "주차 규칙 끝").await.unwrap();
    let page = &tool_result(&llm.requests()[3], "s3")["data"]["results"]["qa_method"];
    assert_eq!(page["note"], format!("offset {}부터는 결과가 없다. 이 검색의 결과는 그 앞쪽이 전부다.", search::MAX_CANDIDATES), "{page}");
}
