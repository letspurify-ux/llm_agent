//! The management DB's pool on a throwaway MariaDB database.

mod support;

use llm_agent::db::{self, Db};
use std::collections::BTreeSet;
use support::*;
use tokio_util::sync::CancellationToken;

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

/// Resource review, eleventh pass: a settings change made a new pool and
/// disconnected the one before at once, failing every connection still
/// being taken from it ("Pool was disconnected"): the tool calls and chat
/// log of questions under way, an admin save. A question goes on with the
/// settings it started with, so it made the old pool again and ended the
/// new one in turn. Queries under both settings at once all run, and every
/// connection closes with the pools.
#[tokio::test]
async fn queries_under_settings_changed_meanwhile_all_run() {
    let Some(test_db) = TestDb::create("pool_change") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    // Small pools, so connections are waited for as under load.
    let mut before = test_db.config().mariadb;
    before.pool_size = 1;
    let mut after = before.clone();
    after.pool_size = 2;
    let db = std::sync::Arc::new(Db::default());
    let runs: Vec<_> = (0..32)
        .map(|i| {
            let (db, cfg) = (db.clone(), if i % 2 == 0 { before.clone() } else { after.clone() });
            tokio::spawn(async move {
                let mut failed = vec![];
                for _ in 0..20 {
                    if let Err(e) = db.query(&cfg, "SELECT 1 AS one", vec![]).await {
                        failed.push(e.to_string());
                    }
                }
                failed
            })
        })
        .collect();
    let mut failed = vec![];
    for run in runs {
        failed.extend(run.await.unwrap());
    }
    assert!(failed.is_empty(), "{} of 640 queries failed, as {:?}", failed.len(), failed.first());
    db.close().await;
    let probe = Db::default();
    let mut open = -1;
    for _ in 0..40 {
        let rows = probe
            .query(&before, "SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE DB = DATABASE() AND ID <> CONNECTION_ID()", vec![])
            .await
            .unwrap();
        open = db::int(&rows[0], "n");
        if open == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(open, 0, "connections left open after the pools closed");
    probe.close().await;
}

/// Resource review, twelfth pass: a statement given up on (past the DB time
/// limit, or dropped with a stopped question) had its connection closed,
/// but the server ran it on to its end, holding a thread, a connection and
/// CPU — still running 16 s after a 1 s limit. It ends at the limit there
/// too.
#[tokio::test]
async fn statements_given_up_on_end_at_the_limit_on_the_server() {
    let Some(test_db) = TestDb::create("given_up") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let mut config = test_db.config();
    config.mariadb.timeout_ms = 1000;
    let cfg = &config.mariadb;
    let db = Db::default();
    // Work the server cannot cut short: a digest of every number up to 1e11.
    let endless = |tag: &str| format!("SELECT COUNT(*) AS n FROM seq_1_to_100000000000 WHERE MD5(seq) = '{tag}'");
    let running = |tag: &str| {
        test_db.scalar(&format!(
            "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE INFO LIKE '%{tag}%' AND ID <> CONNECTION_ID()"
        ))
    };
    let error = db.query(cfg, &endless("past_the_limit"), vec![]).await.unwrap_err();
    assert!(error.to_string().starts_with("database_timeout"), "{error}");
    let dropped = tokio::time::timeout(std::time::Duration::from_millis(300), db.query(cfg, &endless("dropped_meanwhile"), vec![])).await;
    assert!(dropped.is_err());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let (past, dropped) = (running("past_the_limit"), running("dropped_meanwhile"));
        if (past.as_str(), dropped.as_str()) == ("0", "0") {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "still running on the server: {past} past the limit, {dropped} dropped");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(db.query(cfg, "SELECT 1 AS one", vec![]).await.unwrap()[0]["one"], 1);
    db.close().await;
}

/// Resource review, thirteenth pass: a caller that stopped waiting (a
/// stopped question) cut its statement mid-way or its connection mid-login.
/// The server ran the statement on anyway, the pool opened a new connection
/// for the next query, and the server logged an aborted connection — 191
/// for 223 stopped questions. The statement now finishes and its connection
/// goes back to the pool; one given up before it had a connection runs
/// nothing.
#[tokio::test]
async fn a_caller_that_stops_waiting_leaves_its_connection_in_the_pool() {
    let Some(test_db) = TestDb::create("stopped_caller") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let mut config = test_db.config();
    config.mariadb.pool_size = 1;
    let cfg = &config.mariadb;
    let db = Db::default();
    let id = |rows: Vec<db::Row>| db::int(&rows[0], "id");
    let first = id(db.query(cfg, "SELECT CONNECTION_ID() AS id", vec![]).await.unwrap());
    let ms = std::time::Duration::from_millis;
    // Dropped mid-statement, holding the pool's one connection.
    let sleeping = tokio::time::timeout(ms(300), db.query(cfg, "SELECT SLEEP(1) AS s", vec![]));
    let (sleeping, waiting) = tokio::join!(sleeping, async {
        // Dropped while it waits for that connection.
        tokio::time::sleep(ms(100)).await;
        tokio::time::timeout(ms(100), db.exec(cfg, "INSERT INTO chat_log (question, trace) VALUES ('given up', '{}')", vec![])).await
    });
    assert!(sleeping.is_err() && waiting.is_err());
    let next = id(db.query(cfg, "SELECT CONNECTION_ID() AS id", vec![]).await.unwrap());
    assert_eq!(next, first, "the connection went back to the pool");
    assert_eq!(test_db.scalar("SELECT COUNT(*) FROM chat_log WHERE question = 'given up'"), "0");
    db.close().await;
}

/// The retention cleanup deletes a backlog a batch at a time, each well
/// within the DB time limit (a statement past it is stopped and rolled
/// back), and keeps the rows within the retention. Shutdown, which waits
/// for it, ends it after the batch under way.
#[tokio::test]
async fn the_chat_log_cleanup_clears_a_backlog_in_batches() {
    let Some(test_db) = TestDb::create("cleanup") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in(
        "INSERT INTO chat_log (question, trace, created_at) SELECT CONCAT('old ', seq), '{\"v\":5}', NOW() - INTERVAL 10 DAY FROM seq_1_to_2500;
         INSERT INTO chat_log (question, trace) SELECT CONCAT('new ', seq), '{\"v\":5}' FROM seq_1_to_3;",
    );
    let config = test_db.config();
    let db = Db::default();
    let stopped = CancellationToken::new();
    stopped.cancel();
    assert_eq!(db::cleanup_chat_logs(&db, &config.mariadb, 3, &stopped).await.unwrap(), 1000);
    let go_on = CancellationToken::new();
    assert_eq!(db::cleanup_chat_logs(&db, &config.mariadb, 3, &go_on).await.unwrap(), 1500);
    assert_eq!(test_db.scalar("SELECT GROUP_CONCAT(question ORDER BY seq) FROM chat_log"), "new 1,new 2,new 3");
    assert_eq!(db::cleanup_chat_logs(&db, &config.mariadb, 3, &go_on).await.unwrap(), 0);
    db.close().await;
}
