//! Vector candidates out of date or orphaned, on a throwaway MariaDB
//! database: passed over for the nearest valid rows, by the index while it
//! finds them, by every vector when it does not.

mod support;

use llm_agent::{db::Db, search};
use support::*;

/// A unit vector at `angle` from the first axis, toward the second.
fn at(angle: f64) -> Vec<f32> {
    let mut v = vec![0f32; 1024];
    v[0] = angle.cos() as f32;
    v[1] = angle.sin() as f32;
    v
}

fn text(v: &[f32]) -> String {
    serde_json::to_string(v).unwrap()
}

/// `count` methods, the i-th at angle i/100 from the first axis; those in
/// `stale` keep a vector of an earlier text, and `orphans` more vectors
/// nearer than all of them have no method at all. Their seqs, nearest first.
fn methods(test_db: &TestDb, model: &str, count: usize, stale: usize, orphans: usize) -> Vec<i64> {
    let mut seqs = vec![];
    for i in 0..count {
        test_db.sql_in(&format!("INSERT INTO qa_method (title, method) VALUES ('거리 {i}', '절차 {i}')"));
        let seq: i64 = test_db.scalar(&format!("SELECT seq FROM qa_method WHERE title = '거리 {i}'")).parse().unwrap();
        let hash = if i < stale {
            "'0123456789abcdef0123456789abcdef'".to_owned()
        } else {
            format!("MD5(CONCAT_WS(CHAR(10), '{model}', '거리 {i}', '절차 {i}'))")
        };
        test_db.sql_in(&format!(
            "INSERT INTO vec_qa_method (seq, embed_hash, embedding) VALUES ({seq}, {hash}, VEC_FromText('{}'))",
            text(&at(0.1 + i as f64 / 100.0))
        ));
        seqs.push(seq);
    }
    for o in 0..orphans {
        test_db.sql_in(&format!(
            "INSERT INTO vec_qa_method (seq, embed_hash, embedding) VALUES ({}, '0123456789abcdef0123456789abcdef', VEC_FromText('{}'))",
            900_000 + o,
            text(&at(0.01 + o as f64 / 1000.0))
        ));
    }
    seqs
}

/// Backend review, 2026-10-23: one candidate out of date sent every search
/// to read every vector without the index (7 s on 20,000 rows, measured),
/// for every search near a document edited before the next sync, or near a
/// row the embedding server keeps refusing. The index is asked again first.
#[tokio::test]
async fn out_of_date_candidates_are_passed_over_for_the_nearest_valid_rows() {
    let Some(test_db) = TestDb::create("search_stale") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let config = test_db.config();
    let model = config.embedding.model.clone();
    let seqs = methods(&test_db, &model, 40, 6, 2);
    let db = Db::default();
    let scans = || search::VECTOR_SCANS.load(std::sync::atomic::Ordering::Relaxed);
    let found = search::vector_rows(&db, &config, "qa_method", &at(0.0), 5).await.unwrap();
    assert_eq!(scans(), 0, "the index found them");
    let got: Vec<i64> = found.iter().map(|r| llm_agent::db::int(r, "seq")).collect();
    assert_eq!(got, seqs[6..11]);
    for row in &found {
        for helper in ["_stale", "_invalid", "_candidate"] {
            assert!(!row.contains_key(helper), "{helper} in {row:?}");
        }
        assert!(row.contains_key("_dist") && row.contains_key("method"));
    }

    // More of them than the index is asked past: every vector is read.
    let many = TestDb::create("search_stale_many").unwrap();
    let config = many.config();
    let seqs = methods(&many, &model, 40, 25, 0);
    let found = search::vector_rows(&db, &config, "qa_method", &at(0.0), 3).await.unwrap();
    let got: Vec<i64> = found.iter().map(|r| llm_agent::db::int(r, "seq")).collect();
    assert_eq!(got, seqs[25..28]);
    assert_eq!(scans(), 1);
    db.close().await;
}
