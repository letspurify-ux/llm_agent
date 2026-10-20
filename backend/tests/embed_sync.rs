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

/// The sync's lock is one per server, not per database: the tests that sync
/// take turns, or one finds the lock held by another and skips.
static SYNCING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The sync's lock held the pool's only connection while the sync waited
/// for another: with `pool_size` 1 every sync failed after twice the DB
/// timeout, every other use of the DB waiting meanwhile. The lock still
/// keeps a second sync (another process) away.
#[tokio::test]
async fn a_pool_of_one_connection_syncs_under_the_lock() {
    let _turn = SYNCING.lock().await;
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
    let _turn = SYNCING.lock().await;
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

/// A proxy to the test server that notes the most bytes the server sent
/// between two of a client's writes: the largest answer to one statement.
async fn answer_watcher(host: &str, port: u16) -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = listener.local_addr().unwrap().port();
    let largest = Arc::new(AtomicUsize::new(0));
    let (noted, upstream) = (largest.clone(), format!("{host}:{port}"));
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let (largest, upstream) = (noted.clone(), upstream.clone());
            tokio::spawn(async move {
                let server = tokio::net::TcpStream::connect(upstream).await.unwrap();
                let (mut client_in, mut client_out) = client.into_split();
                let (mut server_in, mut server_out) = server.into_split();
                let answer = Arc::new(AtomicUsize::new(0));
                let sent = answer.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 65536];
                    while let Ok(n @ 1..) = server_in.read(&mut buffer).await {
                        let so_far = sent.fetch_add(n, Ordering::AcqRel) + n;
                        largest.fetch_max(so_far, Ordering::AcqRel);
                        if client_out.write_all(&buffer[..n]).await.is_err() {
                            break;
                        }
                    }
                });
                let mut buffer = vec![0u8; 65536];
                while let Ok(n @ 1..) = client_in.read(&mut buffer).await {
                    answer.store(0, Ordering::Release);
                    if server_out.write_all(&buffer[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    (local, largest)
}

/// Documents to chunk were read a thousand at once: the sync held every
/// one, twice over, while it split the first (40 documents of 11 MiB: a
/// 0.9 GiB peak), and a document's content has no size limit. They are read
/// one at a time.
#[tokio::test]
async fn documents_are_read_one_at_a_time_to_be_chunked() {
    let _turn = SYNCING.lock().await;
    let Some(test_db) = TestDb::create("sync_one_doc") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let mut config = test_db.config();
    config.embedding.url = String::new();
    // Four documents of about 500 KB each.
    test_db.sql_in(
        "INSERT INTO knowledge (title, content) SELECT CONCAT('큰 문서 ', seq), REPEAT(CONCAT('문장 ', seq, '이 길게 이어진다.\n\n'), 18000) FROM seq_1_to_4;",
    );
    let document: usize = test_db.scalar("SELECT MAX(LENGTH(content)) FROM knowledge").parse().unwrap();
    let (port, largest) = answer_watcher(&config.mariadb.host, config.mariadb.port).await;
    config.mariadb.host = "127.0.0.1".into();
    config.mariadb.port = port;
    let db = Db::default();
    let summary = EmbedSync::default().run(&db, &config, &CancellationToken::new()).await.expect("the sync runs");
    db.close().await;
    assert_eq!(summary.chunks_failed, 0, "{summary}");
    assert_eq!(test_db.scalar("SELECT COUNT(DISTINCT doc_seq) FROM knowledge_chunk WHERE title LIKE '큰 문서 %'"), "4");
    let largest = largest.load(std::sync::atomic::Ordering::Acquire);
    assert!(largest < document * 3 / 2, "an answer of {largest} bytes for documents of {document}");
}

/// An embedding server that never answers; each request but the warm-up's
/// is told on the returned channel.
#[cfg(unix)]
async fn silent_embedding_server() -> (u16, tokio::sync::mpsc::UnboundedReceiver<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (told, asked) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let told = told.clone();
            tokio::spawn(async move {
                let mut bytes = vec![];
                let mut buffer = [0u8; 65536];
                while let Ok(n) = socket.read(&mut buffer).await {
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                    let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&bytes[..at]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                        .unwrap_or(0);
                    if bytes.len() >= at + 4 + length {
                        if !String::from_utf8_lossy(&bytes[at + 4..]).contains("warm-up") {
                            let _ = told.send(());
                        }
                        break;
                    }
                }
                // Holds the request unanswered while the backend waits.
                let _ = socket.read(&mut buffer).await;
            });
        }
    });
    (port, asked)
}

/// The backend binary, run with `args` and these settings, stopped by
/// SIGTERM once its sync waits for vectors: its exit status, its output,
/// and whether each of its connections to the DB ended with a goodbye.
#[cfg(unix)]
async fn stopped_during_a_sync(tag: &str, args: &[&str]) -> Option<(std::process::ExitStatus, String, usize, Vec<bool>)> {
    let _turn = SYNCING.lock().await;
    let test_db = TestDb::create(tag)?;
    let mut config = test_db.config();
    let (port, ended) = goodbye_watcher(&config.mariadb.host, config.mariadb.port).await;
    config.mariadb.host = "127.0.0.1".into();
    config.mariadb.port = port;
    let (embedding, mut asked) = silent_embedding_server().await;
    config.embedding.url = format!("http://127.0.0.1:{embedding}/v1");
    config.server.port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("config.toml");
    config.save(&settings).unwrap();
    let backend = tokio::process::Command::new(env!("CARGO_BIN_EXE_llm-agent"))
        .args(args)
        .arg("--config")
        .arg(&settings)
        .current_dir(dir.path())
        .env_remove("LLM_AGENT_CONFIG")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    // The sync has chunked the seed's documents and waits for their vectors.
    let waiting = tokio::time::timeout(Duration::from_secs(30), asked.recv()).await.is_ok();
    // SAFETY: kill only sends a signal.
    unsafe {
        libc::kill(backend.id().unwrap() as libc::pid_t, libc::SIGTERM);
    }
    let output = tokio::time::timeout(Duration::from_secs(15), backend.wait_with_output())
        .await
        .expect("the process stops")
        .unwrap();
    let said = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(waiting, "the sync did not ask for vectors:\n{said}");
    let deadline = Instant::now() + Duration::from_secs(5);
    while {
        let goodbyes = ended.lock().unwrap();
        goodbyes.1.len() < goodbyes.0
    } && Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (taken, ended) = ended.lock().unwrap().clone();
    Some((output.status, said, taken, ended))
}

/// Resource review, eighteenth pass: shutdown closed the pools without
/// waiting for the background jobs, and the runtime's end then dropped a
/// sync stopped mid-way — its lock's connection cut without a goodbye (an
/// aborted connection in the server's log at every stop during a sync, as
/// during a first start's long sync) and its summary never written.
#[cfg(unix)]
#[tokio::test]
async fn a_backend_stopped_during_a_sync_ends_its_connections_in_order() {
    let Some((status, said, taken, ended)) = stopped_during_a_sync("sync_stop", &[]).await else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    assert!(status.success(), "{status:?}\n{said}");
    assert!(said.contains("stopped early for shutdown"), "the sync ends and says so:\n{said}");
    assert!(taken >= 2 && ended.len() == taken && ended.iter().all(|quit| *quit), "{taken} connections, closed with a goodbye: {ended:?}");
}

/// The same for `llm-agent embed-sync` run by hand: with no handler, Ctrl+C
/// or a stop signal ended it on the spot, every connection cut. It now stops
/// after the batch under way, and fails, as the sync did not finish.
#[cfg(unix)]
#[tokio::test]
async fn a_sync_run_by_hand_and_stopped_ends_its_connections_in_order() {
    let Some((status, said, taken, ended)) = stopped_during_a_sync("sync_cli_stop", &["embed-sync"]).await else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    assert_eq!(status.code(), Some(1), "{said}");
    assert!(said.contains("stopped early for shutdown"), "the sync ends and says so:\n{said}");
    assert!(taken >= 2 && ended.len() == taken && ended.iter().all(|quit| *quit), "{taken} connections, closed with a goodbye: {ended:?}");
}
