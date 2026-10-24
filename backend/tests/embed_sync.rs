//! The embedding sync on a throwaway MariaDB database: its lock, and the
//! connections it takes.

mod support;

use llm_agent::{
    db::{self, Db},
    embed_sync::{EmbedSync, LOCK_NAME, Skipped},
};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use support::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

/// The tests that sync take turns: several syncs at once load the server
/// under the times some of them check.
static SYNCING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Backend review, 2026-10-23: the sync's lock was one name for the whole
/// server, so a sync of another database on it (another installation, a
/// test database) skipped this one's as busy for as long as it ran.
#[tokio::test]
async fn another_databases_sync_does_not_hold_this_ones_lock() {
    let _turn = SYNCING.lock().await;
    let (Some(one), Some(other)) = (TestDb::create("sync_lock_one"), TestDb::create("sync_lock_other")) else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let db = Db::default();
    let (mut one_config, mut other_config) = (one.config(), other.config());
    one_config.embedding.url = String::new();
    other_config.embedding.url = String::new();
    // The other database's lock held, as its sync holds it.
    let mut held = db.lock_conn(&other_config.mariadb).await.unwrap();
    db::plain_on(&other_config.mariadb, &mut held, &format!("DO GET_LOCK({LOCK_NAME}, 0)")).await.unwrap();
    let summary = EmbedSync::default().run(&db, &one_config, &CancellationToken::new()).await.unwrap();
    assert_eq!(summary.skipped, Skipped::Unconfigured, "{summary}");
    // Its own sync still waits for it.
    let summary = EmbedSync::default().run(&db, &other_config, &CancellationToken::new()).await.unwrap();
    assert_eq!(summary.skipped, Skipped::Busy);
    db.close_conn(&other_config.mariadb, held).await;
    db.close().await;
}

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
    let free = db.query(&config.mariadb, &format!("SELECT IS_FREE_LOCK({LOCK_NAME}) AS free"), vec![]).await.unwrap();
    assert_eq!(db::int(&free[0], "free"), 1, "the lock is released");

    // Held elsewhere, the lock skips the sync.
    let mut other = db.lock_conn(&config.mariadb).await.unwrap();
    db::plain_on(&config.mariadb, &mut other, &format!("DO GET_LOCK({LOCK_NAME}, 0)")).await.unwrap();
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
    db::plain_on(&direct, &mut other, &format!("DO GET_LOCK({LOCK_NAME}, 0)")).await.unwrap();
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

/// Vectors for `vec_qa_method` rows `seqs` (a `seq_<from>_to_<to>` table, or
/// `qa_method`), whatever rows `qa_method` has.
fn add_vectors(test_db: &TestDb, seqs: &str) {
    test_db.sql_in(&format!(
        "INSERT INTO vec_qa_method (seq, embed_hash, embedding)
         SELECT seq, MD5(seq), VEC_FromText(CONCAT('[', REPEAT(CONCAT(seq % 7 + 1, ','), 1023), '1]')) FROM {seqs};"
    ));
}

/// Entries `vec_qa_method`'s vector index holds, by the server's count (an
/// estimate from sampled pages, exact for a few pages).
fn index_entries(test_db: &TestDb) -> u64 {
    test_db.sql_in("ANALYZE TABLE vec_qa_method;");
    test_db
        .scalar(&format!(
            "SELECT SUM(num_rows) FROM information_schema.INNODB_SYS_TABLESTATS WHERE name LIKE '{}/vec\\_qa\\_method#i#%'",
            test_db.name
        ))
        .parse()
        .unwrap()
}

/// A management DB account as the README grants it, with `on_qa_vectors`
/// on `vec_qa_method`; dropped (as each host has it) however a test ends.
/// This server has an anonymous ''@'localhost', so `%` alone cannot log in.
struct Users<'a> {
    test_db: &'a TestDb,
    user: String,
}
impl<'a> Users<'a> {
    const HOSTS: [&'static str; 3] = ["localhost", "127.0.0.1", "%"];

    fn create(test_db: &'a TestDb, on_qa_vectors: &str) -> Self {
        let users = Users { test_db, user: format!("zz_sync_{}", std::process::id()) };
        for host in Self::HOSTS {
            let user = &users.user;
            test_db.sql(&format!("DROP USER IF EXISTS '{user}'@'{host}'; CREATE USER '{user}'@'{host}' IDENTIFIED BY 'zz-sync';"));
        }
        users.grant("SELECT ON {db}.*");
        users.grant("SELECT, INSERT, UPDATE, DELETE ON {db}.knowledge_chunk");
        users.grant("SELECT, INSERT, UPDATE, DELETE ON {db}.vec_knowledge_chunk");
        users.grant(&format!("{on_qa_vectors} ON {{db}}.vec_qa_method"));
        users.grant("SELECT, INSERT, UPDATE, DELETE ON {db}.vec_query_registry");
        users
    }

    /// Grants `what` (`{db}` the test database) on every host.
    fn grant(&self, what: &str) {
        let what = what.replace("{db}", &self.test_db.name);
        for host in Self::HOSTS {
            self.test_db.sql(&format!("GRANT {what} TO '{}'@'{host}';", self.user));
        }
    }

    fn config(&self) -> llm_agent::config::Config {
        let mut config = self.test_db.config();
        config.mariadb.user = self.user.clone();
        config.mariadb.password = Some(llm_agent::config::Secret("zz-sync".into()));
        config
    }
}
impl Drop for Users<'_> {
    fn drop(&mut self) {
        for host in Self::HOSTS {
            self.test_db.sql(&format!("DROP USER IF EXISTS '{}'@'{host}';", self.user));
        }
    }
}

/// MariaDB's vector index keeps the entry of every row deleted or replaced
/// until the table is rebuilt: the sync's deletes and re-embeddings grew it
/// without end (60,856 entries, 180 MB, for 2 rows after an afternoon of
/// edits), and searches over it missed rows it had. Once it holds as many
/// such entries as rows (100 at least), the sync rebuilds the table.
#[tokio::test]
async fn a_vector_index_holding_deleted_rows_is_rebuilt() {
    let _turn = SYNCING.lock().await;
    let Some(test_db) = TestDb::create("sync_rebuild") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let mut config = test_db.config();
    // Vectors of deleted rows are cleaned up without the server.
    config.embedding.url = String::new();
    let rows: u64 = test_db.scalar("SELECT COUNT(*) FROM qa_method").parse().unwrap();
    add_vectors(&test_db, "qa_method");
    add_vectors(&test_db, "seq_1000_to_1049");
    let db = Db::default();
    let sync = EmbedSync::default();
    // 50 left behind: fewer than the least worth a rebuild.
    let summary = sync.run(&db, &config, &CancellationToken::new()).await.unwrap();
    assert_eq!((summary.deleted, summary.rebuilt), (50, 0), "{summary}");
    assert!(index_entries(&test_db) > rows + 25);

    add_vectors(&test_db, "seq_2000_to_2299");
    let summary = sync.run(&db, &config, &CancellationToken::new()).await.unwrap();
    assert_eq!((summary.deleted, summary.rebuilt), (300, 1), "{summary}");
    assert_eq!(index_entries(&test_db), rows, "the index holds the table's rows alone");
    assert_eq!(test_db.scalar("SELECT COUNT(*) FROM vec_qa_method").parse::<u64>().unwrap(), rows);
    // Nothing left behind since: no rebuild.
    let summary = sync.run(&db, &config, &CancellationToken::new()).await.unwrap();
    assert_eq!(summary.rebuilt, 0, "{summary}");
    db.close().await;
}

/// An account as the README grants it reads no server counts (PROCESS) and
/// may not rebuild a table (ALTER): the sync goes on, and once granted
/// ALTER, rebuilds by the entries it left behind itself.
#[tokio::test]
async fn an_account_without_alter_syncs_on_and_with_it_rebuilds_by_its_own_count() {
    let _turn = SYNCING.lock().await;
    let Some(test_db) = TestDb::create("sync_rebuild_grants") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let users = Users::create(&test_db, "SELECT, INSERT, UPDATE, DELETE");
    let mut config = users.config();
    config.embedding.url = String::new();
    let rows: u64 = test_db.scalar("SELECT COUNT(*) FROM qa_method").parse().unwrap();
    add_vectors(&test_db, "qa_method");
    add_vectors(&test_db, "seq_1000_to_1299");
    let db = Db::default();
    let summary = EmbedSync::default().run(&db, &config, &CancellationToken::new()).await.expect("the sync goes on");
    assert_eq!((summary.deleted, summary.rebuilt, summary.chunks_failed), (300, 0, 0), "{summary}");
    assert!(index_entries(&test_db) > rows + 200);

    users.grant("ALTER ON {db}.vec_qa_method");
    add_vectors(&test_db, "seq_2000_to_2299");
    // A new process: it counts only what it leaves behind.
    let summary = EmbedSync::default().run(&db, &config, &CancellationToken::new()).await.unwrap();
    assert_eq!((summary.deleted, summary.rebuilt), (300, 1), "{summary}");
    assert_eq!(index_entries(&test_db), rows);
    db.close().await;
}

/// Backend review, 2026-10-23: a rebuild the account was refused stopped
/// every rebuild of the process for good: the ALTER the log asked for, once
/// granted, took a restart. The same process now tries again after its wait.
#[tokio::test]
async fn a_rebuild_refused_is_tried_again_once_granted() {
    let _turn = SYNCING.lock().await;
    let Some(test_db) = TestDb::create("sync_rebuild_again") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let users = Users::create(&test_db, "SELECT, INSERT, UPDATE, DELETE");
    let mut config = users.config();
    config.embedding.url = String::new();
    let rows: u64 = test_db.scalar("SELECT COUNT(*) FROM qa_method").parse().unwrap();
    add_vectors(&test_db, "qa_method");
    add_vectors(&test_db, "seq_1000_to_1299");
    let db = Db::default();
    let sync = EmbedSync::retrying_rebuilds_after(Duration::ZERO);
    let summary = sync.run(&db, &config, &CancellationToken::new()).await.unwrap();
    assert_eq!((summary.deleted, summary.rebuilt), (300, 0), "{summary}");

    users.grant("ALTER ON {db}.vec_qa_method");
    let summary = sync.run(&db, &config, &CancellationToken::new()).await.unwrap();
    assert_eq!(summary.rebuilt, 1, "{summary}");
    assert_eq!(index_entries(&test_db), rows);
    db.close().await;
}

/// Rows whose vector is out of date leave an index entry behind only once
/// a new vector replaces the old. Counted as replaced whether or not they
/// were, rows the embedding server refused (or could not be reached for)
/// were counted again at every sync, and an account without PROCESS, which
/// goes by its own count, rebuilt the table at every sync for nothing.
#[tokio::test]
async fn rows_not_embedded_again_are_not_counted_as_left_behind() {
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    let _turn = SYNCING.lock().await;
    let Some(test_db) = TestDb::create("sync_rebuild_refused") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in("INSERT INTO qa_method (title, method) SELECT CONCAT('거절 ', seq), CONCAT('절차 ', seq) FROM seq_1_to_150;");
    // Every row has a vector, none of them current.
    add_vectors(&test_db, "qa_method");
    let users = Users::create(&test_db, "SELECT, INSERT, UPDATE, DELETE, ALTER");
    let (taking, asked) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
    let port = refusing_embedding_server(taking.clone(), asked).await;
    let mut config = users.config();
    config.embedding.url = format!("http://127.0.0.1:{port}/v1");
    let db = Db::default();
    let sync = EmbedSync::default();
    for _ in 0..3 {
        let summary = sync.run(&db, &config, &CancellationToken::new()).await.unwrap();
        assert_eq!((summary.embedded, summary.rebuilt), (0, 0), "{summary}");
    }
    // Taken now, every row's vector is replaced: as many entries left as rows.
    taking.store(true, std::sync::atomic::Ordering::Release);
    let mut rebuilt = 0;
    for _ in 0..2 {
        rebuilt += sync.run(&db, &config, &CancellationToken::new()).await.unwrap().rebuilt;
    }
    assert_eq!(rebuilt, 1, "the replaced vectors' entries are rebuilt away once");
    db.close().await;
}

/// The answer of an embedding server to a request body: its status line
/// and JSON.
type Answer = Arc<dyn Fn(&serde_json::Value) -> (&'static str, serde_json::Value) + Send + Sync>;

/// A vector for each input of a request body.
fn vectors(body: &serde_json::Value) -> serde_json::Value {
    let inputs = body["input"].as_array().map_or(0, Vec::len);
    let data: Vec<serde_json::Value> = (0..inputs)
        .map(|i| serde_json::json!({"index":i,"embedding":(0..1024).map(|j| ((i + j) % 7 + 1) as f32).collect::<Vec<_>>()}))
        .collect();
    serde_json::json!({"data":data})
}

/// An embedding server that answers each request as `answer` does; `asked`
/// counts the requests.
async fn embedding_server(answer: Answer, asked: Arc<std::sync::atomic::AtomicUsize>) -> u16 {
    use std::sync::atomic::Ordering;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let (answer, asked) = (answer.clone(), asked.clone());
            tokio::spawn(async move {
                let mut bytes = vec![];
                let mut buffer = [0u8; 65536];
                loop {
                    // One request at a time on a kept connection.
                    let body = loop {
                        if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&bytes[..at]).to_ascii_lowercase();
                            let length = head
                                .lines()
                                .find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                                .unwrap_or(0);
                            if bytes.len() >= at + 4 + length {
                                let body: serde_json::Value = serde_json::from_slice(&bytes[at + 4..at + 4 + length]).unwrap();
                                bytes.drain(..at + 4 + length);
                                break body;
                            }
                        }
                        match socket.read(&mut buffer).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => bytes.extend_from_slice(&buffer[..n]),
                        }
                    };
                    asked.fetch_add(1, Ordering::AcqRel);
                    let (status, answer) = answer(&body);
                    let answer = answer.to_string();
                    let response = format!(
                        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{answer}",
                        answer.len()
                    );
                    if socket.write_all(response.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    port
}

/// An embedding server that refuses every request as a model not pulled
/// (Ollama's 404) until `taking` is set, and then answers every input with
/// a vector of its own; `asked` counts the requests.
async fn refusing_embedding_server(taking: Arc<std::sync::atomic::AtomicBool>, asked: Arc<std::sync::atomic::AtomicUsize>) -> u16 {
    use std::sync::atomic::Ordering;
    let answer: Answer = Arc::new(move |body| {
        if taking.load(Ordering::Acquire) {
            ("200 OK", vectors(body))
        } else {
            ("404 Not Found", serde_json::json!({"error":"model \"qwen3-embedding:0.6b\" not found, try pulling it first"}))
        }
    });
    embedding_server(answer, asked).await
}

/// Each row the embedding server refused was sent again at every sync, one
/// request and one log line each, for good: a model not pulled made 218
/// rows 37 KB of log a minute. Refused rows are held back; each sync sends
/// the one held longest alone, and once the server takes it, all of them.
#[tokio::test]
async fn rows_the_embedding_server_refused_wait_until_it_takes_one() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let _turn = SYNCING.lock().await;
    let Some(test_db) = TestDb::create("sync_refused") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in("INSERT INTO qa_method (title, method) SELECT CONCAT('거절 ', seq), CONCAT('절차 ', seq) FROM seq_1_to_80;");
    let (taking, asked) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
    let port = refusing_embedding_server(taking.clone(), asked.clone()).await;
    let mut config = test_db.config();
    config.embedding.url = format!("http://127.0.0.1:{port}/v1");
    let db = Db::default();
    let sync = EmbedSync::default();
    let stop = CancellationToken::new();

    // The first sync tries every row (the documents' chunks made first).
    let first = sync.run(&db, &config, &stop).await.unwrap();
    let rows: usize = ["knowledge_chunk", "qa_method", "query_registry"]
        .iter()
        .map(|table| test_db.scalar(&format!("SELECT COUNT(*) FROM {table}")).parse::<usize>().unwrap())
        .sum();
    assert_eq!((first.failed, first.embedded), (rows, 0), "{first}");
    assert!(asked.load(Ordering::Acquire) > rows, "{} requests", asked.load(Ordering::Acquire));

    // The next ones send one held row a table, and have nothing to tell.
    for _ in 0..3 {
        asked.store(0, Ordering::Release);
        let again = sync.run(&db, &config, &stop).await.unwrap();
        assert_eq!((again.failed, again.held, again.changed()), (0, rows, false), "{again}");
        assert_eq!(asked.load(Ordering::Acquire), 3, "one request a table");
    }

    // An edited row is sent as it is now.
    test_db.sql_in("UPDATE qa_method SET method = '고친 절차' WHERE title = '거절 7';");
    asked.store(0, Ordering::Release);
    let edited = sync.run(&db, &config, &stop).await.unwrap();
    assert_eq!((edited.failed, edited.held), (1, rows - 1), "{edited}");
    // With the held row of its table: together, and refused, each alone.
    assert_eq!(asked.load(Ordering::Acquire), 2 + 3);

    // Put right, the server takes the held row sent, and then the rest.
    taking.store(true, Ordering::Release);
    let mut embedded = 0;
    for _ in 0..3 {
        embedded += sync.run(&db, &config, &stop).await.unwrap().embedded;
    }
    assert_eq!(embedded, rows);
    let after = sync.run(&db, &config, &stop).await.unwrap();
    assert_eq!((after.failed, after.held, after.embedded), (0, 0, 0), "{after}");
    db.close().await;
}

/// Backend review, 2026-10-23: a 5xx was taken as the server down, also one
/// the server answered for a row alone (llama.cpp's 500 "input is too
/// large"): every sync stopped at that row's batch, and the rows after it,
/// and the tables after its own, were never embedded. Such a row is now held
/// back as a refused one is; a server failing every row still stops the
/// sync after a few of them.
#[tokio::test]
async fn a_row_the_embedding_server_fails_alone_does_not_stop_the_sync() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let _turn = SYNCING.lock().await;
    let Some(test_db) = TestDb::create("sync_poisoned") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in(
        "INSERT INTO qa_method (title, method) VALUES ('긴 방법', '너무 긴 입력');
         INSERT INTO qa_method (title, method) SELECT CONCAT('방법 ', seq), CONCAT('절차 ', seq) FROM seq_1_to_80;",
    );
    let (broken, asked) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
    let failing = broken.clone();
    let answer: Answer = Arc::new(move |body| {
        let poisoned = body["input"].as_array().into_iter().flatten().any(|input| input.as_str().is_some_and(|text| text.contains("너무 긴")));
        if poisoned || failing.load(Ordering::Acquire) {
            ("500 Internal Server Error", serde_json::json!({"error":{"code":500,"message":"input is too large to process. increase the physical batch size"}}))
        } else {
            ("200 OK", vectors(body))
        }
    });
    let port = embedding_server(answer, asked.clone()).await;
    let mut config = test_db.config();
    config.embedding.url = format!("http://127.0.0.1:{port}/v1");
    let db = Db::default();
    let sync = EmbedSync::default();
    let stop = CancellationToken::new();
    let count = |table: &str| test_db.scalar(&format!("SELECT COUNT(*) FROM {table}")).parse::<usize>().unwrap();

    // Every row but the one the server fails, the tables after it too.
    let first = sync.run(&db, &config, &stop).await.unwrap();
    assert_eq!((first.failed, first.skipped.clone()), (1, Skipped::None), "{first}");
    assert_eq!(count("vec_qa_method"), count("qa_method") - 1);
    assert_eq!(count("vec_query_registry"), count("query_registry"));
    assert_eq!(count("vec_knowledge_chunk"), count("knowledge_chunk"));
    // Then it alone, tried once a sync.
    asked.store(0, Ordering::Release);
    let again = sync.run(&db, &config, &stop).await.unwrap();
    assert_eq!((again.failed, again.held, again.changed()), (0, 1, false), "{again}");
    assert_eq!(asked.load(Ordering::Acquire), 1);

    // A server failing every row stops the sync after a few rows.
    test_db.sql_in("INSERT INTO qa_method (title, method) SELECT CONCAT('새 방법 ', seq), CONCAT('새 절차 ', seq) FROM seq_1_to_40;");
    broken.store(true, Ordering::Release);
    asked.store(0, Ordering::Release);
    let down = sync.run(&db, &config, &stop).await.unwrap();
    assert_eq!(down.skipped, Skipped::Unavailable, "{down}");
    assert!(asked.load(Ordering::Acquire) <= 1 + 1 + 4, "{} requests", asked.load(Ordering::Acquire));

    // Put right, every row but the failing one is embedded within a few syncs.
    broken.store(false, Ordering::Release);
    for _ in 0..4 {
        sync.run(&db, &config, &stop).await.unwrap();
    }
    assert_eq!(count("vec_qa_method"), count("qa_method") - 1);
    let after = sync.run(&db, &config, &stop).await.unwrap();
    assert_eq!((after.failed, after.held, after.embedded), (0, 1, 0), "{after}");
    db.close().await;
}

/// A `vec_*` table that takes no writes (an account without DELETE, which
/// REPLACE needs; a read-only server) had every row the sync found stale
/// embedded again at every sync, each then refused with a log line of its
/// own: as many embeddings and lines a minute as rows, for good. The table
/// is now tried with a statement that writes nothing first, and its rows
/// wait for a sync it takes them in.
#[tokio::test]
async fn rows_of_a_table_that_takes_no_writes_are_not_embedded() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let _turn = SYNCING.lock().await;
    let Some(test_db) = TestDb::create("sync_unwritable") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in("INSERT INTO qa_method (title, method) SELECT CONCAT('저장 ', seq), CONCAT('절차 ', seq) FROM seq_1_to_80;");
    let users = Users::create(&test_db, "SELECT, INSERT, UPDATE");
    let (taking, asked) = (Arc::new(AtomicBool::new(true)), Arc::new(AtomicUsize::new(0)));
    let port = refusing_embedding_server(taking, asked.clone()).await;
    let mut config = users.config();
    config.embedding.url = format!("http://127.0.0.1:{port}/v1");
    let count = |table: &str| test_db.scalar(&format!("SELECT COUNT(*) FROM {table}")).parse::<usize>().unwrap();
    let db = Db::default();
    let sync = EmbedSync::default();
    let stop = CancellationToken::new();

    let first = sync.run(&db, &config, &stop).await.unwrap();
    let (chunks, queries, methods) = (count("knowledge_chunk"), count("query_registry"), count("qa_method"));
    assert_eq!(first.embedded, chunks + queries, "{first}");
    assert_eq!(asked.load(Ordering::Acquire), chunks.div_ceil(32) + queries.div_ceil(32), "nothing embedded for vec_qa_method");
    for _ in 0..2 {
        asked.store(0, Ordering::Release);
        let again = sync.run(&db, &config, &stop).await.unwrap();
        assert_eq!((again.embedded, again.failed), (0, 0), "{again}");
        assert_eq!(asked.load(Ordering::Acquire), 0);
    }

    users.grant("DELETE ON {db}.vec_qa_method");
    let granted = sync.run(&db, &config, &stop).await.unwrap();
    assert_eq!((granted.embedded, granted.failed), (methods, 0), "{granted}");
    assert_eq!(count("vec_qa_method"), methods);
    db.close().await;
}

/// A table that refuses its rows as it would any, past the write of no rows
/// (full, say): the sync splits no more documents and embeds no more rows
/// for it than the first refused, at every sync.
#[tokio::test]
async fn a_table_that_refuses_its_first_rows_waits_with_the_rest() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let _turn = SYNCING.lock().await;
    let Some(test_db) = TestDb::create("sync_full") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in("INSERT INTO qa_method (title, method) SELECT CONCAT('가득 ', seq), CONCAT('절차 ', seq) FROM seq_1_to_80;");
    let documents: usize = test_db.scalar("SELECT COUNT(*) FROM knowledge").parse().unwrap();
    assert!(documents > 1);
    // ER_RECORD_FILE_FULL, as InnoDB says it.
    for table in ["knowledge_chunk", "vec_qa_method"] {
        test_db.sql_in(&format!(
            "CREATE TRIGGER zz_full_{table} BEFORE INSERT ON {table} FOR EACH ROW
             SIGNAL SQLSTATE 'HY000' SET MYSQL_ERRNO = 1114, MESSAGE_TEXT = 'The table is full';"
        ));
    }
    let (taking, asked) = (Arc::new(AtomicBool::new(true)), Arc::new(AtomicUsize::new(0)));
    let port = refusing_embedding_server(taking, asked.clone()).await;
    let mut config = test_db.config();
    config.embedding.url = format!("http://127.0.0.1:{port}/v1");
    let queries: usize = test_db.scalar("SELECT COUNT(*) FROM query_registry").parse().unwrap();
    let db = Db::default();
    let sync = EmbedSync::default();
    let stop = CancellationToken::new();
    // The query rows are embedded at the first sync, the others never.
    for embedded in [queries, 0, 0] {
        asked.store(0, Ordering::Release);
        let summary = sync.run(&db, &config, &stop).await.unwrap();
        assert_eq!((summary.chunks_failed, summary.failed, summary.embedded), (1, 32, embedded), "{summary}");
        assert_eq!(asked.load(Ordering::Acquire), 1 + embedded.div_ceil(32), "one batch for vec_qa_method");
    }
    db.close().await;
}

/// Settings, 2026-10-24: a server syncs what its tool groups search — the
/// knowledge chunks with knowledge, the methods' and queries' vectors with
/// the DB tools. A server of another role on the same management DB syncs
/// the rest.
#[tokio::test]
async fn a_sync_leaves_what_its_tool_groups_do_not_search() {
    let _turn = SYNCING.lock().await;
    let Some(test_db) = TestDb::create("sync_groups") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let mut config = test_db.config();
    config.embedding.url = String::new();
    test_db.sql_in("INSERT INTO knowledge (title, content) VALUES ('역할별 동기화', '지식을 쓰는 서버만 나눈다.');");
    // The vector of a method that is gone: a sync over the methods removes it.
    add_vectors(&test_db, "(SELECT 999999 AS seq) AS gone");
    let chunks = || test_db.scalar("SELECT COUNT(*) FROM knowledge_chunk");
    let orphans = || test_db.scalar("SELECT COUNT(*) FROM vec_qa_method WHERE seq = 999999");
    let db = Db::default();
    let sync = |config: llm_agent::config::Config| {
        let db = &db;
        async move { EmbedSync::default().run(db, &config, &CancellationToken::new()).await.unwrap() }
    };

    let (mut nothing, mut knowledge) = (config.clone(), config.clone());
    nothing.assistant.knowledge = false;
    nothing.assistant.database = false;
    let summary = sync(nothing).await;
    assert_eq!((summary.chunks, summary.deleted), (0, 0), "{summary}");
    // Said as what it is, not as a missing embedding server.
    assert_eq!(summary.skipped, Skipped::NotSearched);
    assert!(summary.to_string().contains("searches nothing"), "{summary}");
    assert_eq!((chunks(), orphans()), ("0".to_owned(), "1".to_owned()));

    knowledge.assistant.database = false;
    let summary = sync(knowledge).await;
    assert!(summary.chunks > 0, "{summary}");
    assert_eq!(chunks(), summary.chunks.to_string(), "the seed's documents and this one are chunked");
    assert_eq!(orphans(), "1", "the methods' vectors are another role's");

    config.assistant.knowledge = false;
    let summary = sync(config).await;
    assert_eq!(summary.deleted, 1, "{summary}");
    assert_eq!(orphans(), "0");
    db.close().await;
}
