//! Name lookups of the HTTP clients that do not go through the LLM's: the
//! embedding server's and the MCP servers'. A lookup is the system's
//! (`getaddrinfo`), which cannot be stopped once begun. A binary of its own:
//! it counts the process's threads.
#![cfg(any(target_os = "macos", target_os = "linux"))]

use llm_agent::config::{EmbeddingConfig, McpServer};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// The tests count threads one at a time.
static MEASURING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The threads of this process.
fn threads() -> usize {
    #[cfg(target_os = "macos")]
    {
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
        // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
        let read = unsafe {
            libc::proc_pidinfo(std::process::id() as libc::c_int, libc::PROC_PIDTASKINFO, 0, (&raw mut info).cast(), size)
        };
        assert_eq!(read, size);
        info.pti_threadnum as usize
    }
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string("/proc/self/status").unwrap();
        status.lines().find_map(|line| line.strip_prefix("Threads:")).unwrap().trim().parse().unwrap()
    }
}

/// Resource review, 38th pass: these clients looked names up on Tokio's
/// blocking threads (reqwest's default resolver), one thread a lookup,
/// kept busy after the request that asked was given up on. A system
/// resolver that does not answer (on macOS, a `.local` name nobody has for
/// 5 s; a stuck resolver for good) then held a thread for each request
/// given up on meanwhile: 64 embedding requests and 64 MCP connection
/// checks given up on after 300 ms held 128. The server keeps its blocking
/// threads (`app::runtime`), and all its blocking work — Oracle queries,
/// source tools, token counts — waited behind them once 512 were taken.
/// The lookups now take the dedicated threads the LLM's do, a few at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lookups_given_up_on_hold_a_few_threads() {
    let _turn = MEASURING.lock().await;
    let before = threads();
    let stop = CancellationToken::new();
    let mut asked = vec![];
    for i in 0..64 {
        let embedding = EmbeddingConfig {
            url: format!("http://zz-lookup-embed-{i}-{}.local:9/v1", std::process::id()),
            model: "m".into(),
            ..Default::default()
        };
        let stop = stop.clone();
        asked.push(tokio::spawn(async move {
            let _ = llm_agent::embedding::embed(&embedding, &["x".to_owned()], &stop).await;
        }));
        let server = McpServer {
            name: format!("lookup{i}"),
            enabled: true,
            url: format!("http://zz-lookup-mcp-{i}-{}.local:9/mcp", std::process::id()),
            disable_proxy: true,
            tools: vec!["*".into()],
            ..Default::default()
        };
        asked.push(tokio::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_millis(300), llm_agent::mcp::probe(&server, "gpt-4o")).await;
        }));
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    stop.cancel();
    for asked in asked {
        asked.await.unwrap();
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let held = threads().saturating_sub(before);
    assert!(held <= 24, "{held} threads still held by lookups given up on");
}

/// The same for the management DB, whose host is a name by default
/// (`localhost`): its driver looked the name up on Tokio's blocking threads
/// at each connection it made, a lookup the DB time limit did not end — 64
/// queries given up on held 64 threads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn db_lookups_given_up_on_hold_a_few_threads() {
    let mut cfg = llm_agent::config::MariaDbConfig {
        user: "nobody".into(),
        timeout_ms: 300,
        ..Default::default()
    };
    let _turn = MEASURING.lock().await;
    let before = threads();
    let db = std::sync::Arc::new(llm_agent::db::Db::default());
    let mut asked = vec![];
    for i in 0..64 {
        cfg.host = format!("zz-lookup-db-{i}-{}.local", std::process::id());
        let (db, cfg) = (db.clone(), cfg.clone());
        asked.push(tokio::spawn(async move {
            let _ = db.query(&cfg, "SELECT 1", vec![]).await;
        }));
    }
    for asked in asked {
        asked.await.unwrap();
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let held = threads().saturating_sub(before);
    assert!(held <= 24, "{held} threads still held by DB lookups given up on");
}
