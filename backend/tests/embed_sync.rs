//! The embedding sync on a throwaway MariaDB database: its lock, and the
//! connections it takes.

mod support;

use llm_agent::{
    db::{self, Db},
    embed_sync::{EmbedSync, Skipped},
};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use support::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
    db.close_conn(&config.mariadb, other).await;
}

/// Connections a proxy took, and for each the client closed, whether its
/// last packet was COM_QUIT (a goodbye, not a cut).
type Goodbyes = Arc<Mutex<(usize, Vec<bool>)>>;

/// A proxy to the test server that notes how its connections end.
async fn goodbye_watcher(host: &str, port: u16) -> (u16, Goodbyes) {
    const COM_QUIT: [u8; 5] = [1, 0, 0, 0, 1];
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = listener.local_addr().unwrap().port();
    let ended: Goodbyes = Arc::default();
    let (noted, upstream) = (ended.clone(), format!("{host}:{port}"));
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            noted.lock().unwrap().0 += 1;
            let (noted, upstream) = (noted.clone(), upstream.clone());
            tokio::spawn(async move {
                let server = tokio::net::TcpStream::connect(upstream).await.unwrap();
                let (mut client_in, mut client_out) = client.into_split();
                let (mut server_in, mut server_out) = server.into_split();
                tokio::spawn(async move { tokio::io::copy(&mut server_in, &mut client_out).await });
                let mut last: Vec<u8> = vec![];
                let mut buffer = [0u8; 65536];
                let quit = loop {
                    match client_in.read(&mut buffer).await {
                        Ok(0) => break last.ends_with(&COM_QUIT),
                        Ok(n) => {
                            last.extend_from_slice(&buffer[..n]);
                            last.drain(..last.len().saturating_sub(COM_QUIT.len()));
                            if server_out.write_all(&buffer[..n]).await.is_err() {
                                break false;
                            }
                        }
                        Err(_) => break false,
                    }
                };
                noted.lock().unwrap().1.push(quit);
            });
        }
    });
    (local, ended)
}

/// The lock's connection, outside the pool, was dropped: mysql_async marks
/// such a connection closed before it says goodbye, so it was cut, and the
/// server counted and logged an aborted connection at every sync — once a
/// minute by default, into a log nothing trims.
#[tokio::test]
async fn the_locks_connection_says_goodbye() {
    let Some(test_db) = TestDb::create("sync_quit") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let mut config = test_db.config();
    config.embedding.url = String::new();
    let (port, ended) = goodbye_watcher(&config.mariadb.host, config.mariadb.port).await;
    let direct = config.mariadb.clone();
    config.mariadb.host = "127.0.0.1".into();
    config.mariadb.port = port;
    let db = Db::default();
    let summary = EmbedSync::default().run(&db, &config, &CancellationToken::new()).await.expect("the sync runs");
    assert_eq!(summary.skipped, Skipped::Unconfigured);
    // A sync the lock held elsewhere skips closes its connection too.
    let mut other = db.lock_conn(&direct).await.unwrap();
    db::plain_on(&direct, &mut other, "DO GET_LOCK('space_voc_embed_sync', 0)").await.unwrap();
    let summary = EmbedSync::default().run(&db, &config, &CancellationToken::new()).await.unwrap();
    assert_eq!(summary.skipped, Skipped::Busy);
    db.close_conn(&direct, other).await;
    db.close().await;
    // Each connection ended: the two locks' and the pool's.
    let open = || {
        let goodbyes = ended.lock().unwrap();
        goodbyes.1.len() < goodbyes.0
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while open() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (taken, ended) = ended.lock().unwrap().clone();
    assert!(taken >= 3 && ended.len() == taken && ended.iter().all(|quit| *quit), "{taken} connections, closed with a goodbye: {ended:?}");
}
