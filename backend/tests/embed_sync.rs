//! The embedding sync on a throwaway MariaDB database: its lock, and the
//! connections it takes.

mod support;

use llm_agent::{
    db::{self, Db},
    embed_sync::{EmbedSync, Skipped},
};
use std::time::{Duration, Instant};
use support::*;
use tokio_util::sync::CancellationToken;

/// The sync's lock held the pool's only connection while the sync waited
/// for another: with `pool_size` 1 every sync failed after twice the DB
/// timeout, every other use of the DB waiting meanwhile. The lock still
/// keeps a second sync (another process) away.
#[tokio::test]
async fn a_pool_of_one_connection_syncs_under_the_lock() {
    let Some(test_db) = TestDb::create("sync_pool") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let mut config = test_db.config();
    config.mariadb.pool_size = 1;
    config.mariadb.timeout_ms = 3_000;
    // Documents are chunked and vectors cleaned up without the server.
    config.embedding.url = String::new();
    test_db.sql_in("INSERT INTO knowledge (title, content) VALUES ('한 연결 동기화', '연결 하나로도 나뉜다.');");
    let db = Db::default();
    let started = Instant::now();
    let summary = EmbedSync::default().run(&db, &config, &CancellationToken::new()).await.expect("the sync runs");
    assert!(started.elapsed() < Duration::from_millis(config.mariadb.timeout_ms), "waited {:?}", started.elapsed());
    assert_eq!((&summary.skipped, summary.chunks_failed), (&Skipped::Unconfigured, 0));
    assert!(summary.chunks > 0, "{summary}");
    let free = db.query(&config.mariadb, "SELECT IS_FREE_LOCK('space_voc_embed_sync') AS free", vec![]).await.unwrap();
    assert_eq!(db::int(&free[0], "free"), 1, "the lock is released");

    // Held elsewhere, the lock skips the sync.
    let mut other = db.lock_conn(&config.mariadb).await.unwrap();
    db::plain_on(&config.mariadb, &mut other, "DO GET_LOCK('space_voc_embed_sync', 0)").await.unwrap();
    let summary = EmbedSync::default().run(&db, &config, &CancellationToken::new()).await.unwrap();
    assert_eq!(summary.skipped, Skipped::Busy);
}
