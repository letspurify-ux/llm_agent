//! Knowledge search pages on a throwaway MariaDB database with the
//! embedding server: a long document whose chunks fill the whole candidate
//! list does not hide the documents after it.

mod support;

use llm_agent::search;
use std::collections::BTreeSet;
use support::*;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn pages_reach_every_document_past_a_long_one() {
    let Some(test_db) = TestDb::create("paging") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let mut config = test_db.config();
    if !embedding_available(&config).await {
        return skip("no embedding server");
    }
    // Every document stays, whatever its distance: the pages alone decide
    // what is seen.
    config.embedding.max_distance = 2.0;
    let long: String = (0..30)
        .map(|i| {
            format!(
                "The Boring Company tunnel project part {i}. The Boring Company digs tunnels under cities so cars ride on electric skates. \
                 Its Prufrock machine bores the tunnel {i} while the crew lines it with concrete segments, and the Loop stations connect to the tunnel network. "
            )
            .repeat(3)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    test_db.sql_in(&format!("INSERT INTO knowledge (title, content) VALUES ('The Boring Company', '{long}');"));
    let short = ["점심 메뉴 안내", "주차장 이용 규칙", "회의실 예약 방법", "휴가 신청 절차", "사내 와이파이 접속", "택배 수령 위치", "출입증 재발급", "복사기 사용법"];
    let values = short.iter().map(|t| format!("('{t}', '{t}에 관한 짧은 안내문이다.')")).collect::<Vec<_>>().join(", ");
    test_db.sql_in(&format!("INSERT INTO knowledge (title, content) VALUES {values};"));
    let (app, _dir) = app(config, Scripted::new(vec![]));
    let config = app.config();
    app.sync.run(&app.db, &config, &app.shutdown).await.unwrap();
    let chunks: i64 = test_db.scalar("SELECT MAX(chunk_of) FROM knowledge_chunk").parse().unwrap();
    assert!(chunks > 20, "the long document fills a first candidate list: {chunks} chunks");
    let all: usize = test_db.scalar("SELECT COUNT(*) FROM knowledge").parse().unwrap();

    let vector = app.embeddings.embed(&config.embedding, "Boring Company tunnel", &CancellationToken::new()).await.unwrap();
    for limit in [1, 3, 5] {
        let (mut offset, mut seen, mut last) = (0, BTreeSet::new(), f64::MIN);
        loop {
            let page = search::knowledge(&app.db, &config, &vector, offset, limit).await.unwrap();
            assert!(!page.items.is_empty(), "limit {limit}: an empty page at offset {offset} after {seen:?}");
            for doc in &page.items {
                assert!(seen.insert(doc.doc_seq), "limit {limit}: k{} twice", doc.doc_seq);
                assert!(doc.distance >= last, "limit {limit}: pages go nearest first");
                last = doc.distance;
            }
            if offset == 0 {
                assert_eq!(page.items[0].title, "The Boring Company");
            }
            if !page.more {
                break;
            }
            // As search's next_offset.
            offset += limit;
        }
        assert_eq!(seen.len(), all, "limit {limit}: every document is reached once");
    }
    // A page past the end is empty and says so.
    let past = search::knowledge(&app.db, &config, &vector, all, 5).await.unwrap();
    assert!(past.items.is_empty() && !past.more && !past.capped, "every document was read: the list truly ends");
}
