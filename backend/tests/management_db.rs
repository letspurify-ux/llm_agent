//! The management DB's pool on a throwaway MariaDB database.

mod support;

use llm_agent::db::{self, Db};
use std::collections::BTreeSet;
use support::*;

/// Resource review, sixth pass: the pool kept no idle connection (its lower
/// bound, 0, and no idle time), so every query opened, logged in to and
/// closed a connection of its own — about four round trips more per query
/// (82 ms instead of 33 ms a query over a 10 ms link), and a closed socket
/// in TIME_WAIT each time. A connection taken again must be as a new one:
/// what a query left in its session (a search's session variable, an admin
/// write's lock, a user variable, the character set) is gone.
#[tokio::test]
async fn queries_take_the_pools_connections_again_as_new() {
    let Some(test_db) = TestDb::create("pool_reuse") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let config = test_db.config();
    let cfg = &config.mariadb;
    let db = Db::default();
    const STATE: &str = "SELECT CONNECTION_ID() AS id, @@collation_connection AS collation, @@character_set_results AS results,
        @@group_concat_max_len AS gc, @left AS left_behind, IS_FREE_LOCK('pool_reuse') AS free";
    let state = |row: &db::Row| {
        ["collation", "results", "gc", "left_behind", "free"].map(|key| db::text(row, key)).join(" ")
    };
    let fresh = db.query(cfg, STATE, vec![]).await.unwrap().remove(0);
    let mut used = db.conn(cfg).await.unwrap();
    let id = db::int(&db::query_on(cfg, &mut used, "SELECT CONNECTION_ID() AS id", vec![]).await.unwrap()[0], "id");
    for statement in [
        "SET SESSION group_concat_max_len = 7",
        "DO GET_LOCK('pool_reuse', 0)",
        "SET @left = 1",
        "SET NAMES latin1",
    ] {
        db::plain_on(cfg, &mut used, statement).await.unwrap();
    }
    drop(used);
    let mut ids = BTreeSet::new();
    for _ in 0..20 {
        let row = db.query(cfg, STATE, vec![]).await.unwrap().remove(0);
        assert_eq!(state(&row), state(&fresh), "a connection taken again keeps nothing of its last use");
        ids.insert(db::int(&row, "id"));
    }
    assert!(ids.contains(&id) && ids.len() <= 3, "20 queries took connections {ids:?} (the used one: {id})");
    // Connections the server closed meanwhile (a restart, its idle limit)
    // are not given out.
    for id in &ids {
        test_db.sql(&format!("KILL {id}"));
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let row = db.query(cfg, STATE, vec![]).await.expect("a new connection").remove(0);
    assert!(!ids.contains(&db::int(&row, "id")));
    db.close().await;
}
