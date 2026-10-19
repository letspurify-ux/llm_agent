//! `llm-agent` serves the API (default); `llm-agent embed-sync` runs one
//! embedding sync and exits. `--config <path>` (or LLM_AGENT_CONFIG) names
//! the settings file; the default is config.toml in the working directory.

use llm_agent::{app::App, config::Config, console, embed_sync, llm::OpenAiClient, web};
use std::{path::PathBuf, sync::Arc, time::Duration};

// Console lines that cannot panic once the output's reader is gone (see
// `console`).
macro_rules! eprintln {
    ($($arg:tt)*) => {
        console::line(format_args!($($arg)*))
    };
}
macro_rules! println {
    ($($arg:tt)*) => {
        console::out_line(format_args!($($arg)*))
    };
}

fn config_path(args: &[String]) -> PathBuf {
    if let Some(at) = args.iter().position(|a| a == "--config")
        && let Some(path) = args.get(at + 1)
    {
        return PathBuf::from(path);
    }
    std::env::var_os("LLM_AGENT_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("config.toml"))
}

fn main() {
    console::drop_unwritable();
    let args: Vec<String> = std::env::args().collect();
    // `.env` values (ENV:NAME target DB passwords, first-start import) join
    // the process environment without overriding it.
    let _ = dotenvy::dotenv();
    let path = config_path(&args);
    let config = match Config::load(&path) {
        Ok(config) => config,
        Err(e) => {
            eprintln!("[config] cannot load {}: {e:#}", path.display());
            std::process::exit(1);
        }
    };
    let runtime = llm_agent::app::runtime().expect("tokio runtime");
    let code = runtime.block_on(async move {
        if args.iter().any(|a| a == "embed-sync") {
            sync_once(path, config).await
        } else {
            serve(path, config).await
        }
    });
    runtime.shutdown_timeout(Duration::from_secs(2));
    std::process::exit(code);
}

async fn sync_once(path: PathBuf, config: Config) -> i32 {
    let app = App::new(path, config, Arc::new(OpenAiClient));
    let started = std::time::Instant::now();
    let config = app.config();
    let result = app.sync.run(&app.db, &config, &app.shutdown).await;
    app.db.close().await;
    match result {
        Ok(summary) => {
            println!("embedding sync complete: {summary}, {:.1}s", started.elapsed().as_secs_f64());
            i32::from(summary.failed > 0 || summary.chunks_failed > 0 || summary.skipped == embed_sync::Skipped::Unavailable)
        }
        Err(e) => {
            eprintln!("[embed] sync failed: {e:#}");
            1
        }
    }
}

async fn serve(path: PathBuf, config: Config) -> i32 {
    if config.mariadb.user.is_empty() {
        eprintln!("[setup] the management DB user is not set — open the admin screen's settings tab, or set it in {}", path.display());
    }
    if config.llm.model.trim().is_empty() {
        eprintln!("[setup] no LLM model is set — every question will ask for one; set the model in the admin screen's settings tab");
    }
    let port = config.server.port;
    let mock = config.oracle.mock;
    let app = App::new(path, config, Arc::new(OpenAiClient));
    if !mock {
        let oracle = app.oracle.clone();
        let cfg = app.config().oracle.clone();
        // Loading the client library can take a moment; report it at start
        // rather than on the first question.
        tokio::task::spawn_blocking(move || match oracle.init_client(&cfg) {
            Ok(version) => eprintln!("[oracle] Oracle client {version} loaded"),
            Err(e) => eprintln!(
                "[setup] the Oracle client library could not be loaded — registered queries will fail until the Instant Client is installed (or its folder set in the settings and the server restarted): {e}"
            ),
        });
    }
    background_jobs(&app);
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("[listen] failed to start on port {port}: {e}");
            return 1;
        }
    };
    // MCP tool servers connect in the background once the server can start
    // (a failed start leaves no process behind); one that fails is retried
    // and never holds up the start. They stop as soon as shutdown begins,
    // beside the connections' grace: stop.sh force-kills 11 s after its
    // signal, and their processes would outlive a killed backend.
    let servers = app.config().mcp_servers.clone();
    if !servers.is_empty() {
        eprintln!("[mcp] starting {} tool server(s)", servers.iter().filter(|s| s.enabled).count());
    }
    app.mcp.apply(&servers);
    let stopping_mcp = {
        let (hub, token) = (app.mcp.clone(), app.shutdown.clone());
        tokio::spawn(async move {
            token.cancelled().await;
            hub.shutdown().await;
        })
    };
    let config = app.config();
    println!(
        "agent server: http://localhost:{port} (model={}, oracle_mock={}, embedding={})",
        if config.llm.model.is_empty() { "unset" } else { &config.llm.model },
        u8::from(config.oracle.mock),
        if config.embedding.enabled() { &config.embedding.model } else { "off" }
    );
    let shutdown = app.shutdown.clone();
    let server = web::serve(listener, app.clone(), async move {
        wait_for_signal().await;
        eprintln!("[shutdown] cleaning up and exiting");
        shutdown.cancel();
    });
    let code = match server.await {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("[server] {e}");
            1
        }
    };
    // Pending chat logs get a moment to finish.
    for _ in 0..50 {
        if app.pending_logs.load(std::sync::atomic::Ordering::Acquire) == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    app.shutdown.cancel();
    let _ = stopping_mcp.await;
    app.db.close().await;
    code
}

/// SIGINT, SIGTERM or SIGHUP (the terminal closed, or the log launcher
/// passing on its own): left to its default, a hangup ended the backend on
/// the spot, and an MCP server that outlives its input (a Node server
/// holding a database pool, its docker container) was left running.
async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        let mut hangup = signal(SignalKind::hangup()).expect("SIGHUP handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
            _ = hangup.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Embedding warm-up, the embedding sync (at start and every interval), the
/// chat log retention cleanup (at start and hourly), and every minute the
/// release of idle conversations, Oracle pools and kept syntax trees.
fn background_jobs(app: &Arc<App>) {
    let housekeeping = app.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = housekeeping.shutdown.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(60)) => {}
            }
            let idle = housekeeping.config().agent.session_idle_minutes.saturating_mul(60);
            housekeeping.sessions.sweep(Duration::from_secs(idle));
            housekeeping.oracle.close_idle(llm_agent::oracle::POOL_IDLE);
            let _ = tokio::task::spawn_blocking(|| llm_agent::tools::release_idle_syntax(llm_agent::tools::SYNTAX_IDLE)).await;
        }
    });
    let warm = app.clone();
    tokio::spawn(async move {
        let config = warm.config();
        if config.embedding.enabled()
            && llm_agent::embedding::embed(&config.embedding, &["warm-up".to_owned()], &warm.shutdown)
                .await
                .is_ok()
        {
            eprintln!("[embed] embedding model is warm");
        }
    });
    let sync = app.clone();
    tokio::spawn(async move {
        let mut first = true;
        loop {
            let config = sync.config();
            let interval = config.embedding.sync_interval_secs;
            if first || interval > 0 {
                match sync.sync.run(&sync.db, &config, &sync.shutdown).await {
                    Ok(summary) if first || summary.changed() => eprintln!("[embed] sync: {summary}"),
                    Ok(_) => {}
                    Err(e) => eprintln!("[embed] sync failed: {e:#}"),
                }
                if first && interval == 0 {
                    eprintln!("[embed] periodic sync disabled (interval 0) — run `llm-agent embed-sync` to sync manually");
                }
            }
            first = false;
            let wait = Duration::from_secs(interval.max(10));
            tokio::select! {
                _ = sync.shutdown.cancelled() => break,
                _ = tokio::time::sleep(wait) => {}
            }
        }
    });
    let cleanup = app.clone();
    tokio::spawn(async move {
        loop {
            let config = cleanup.config();
            match llm_agent::db::cleanup_chat_logs(&cleanup.db, &config.mariadb, config.server.chat_log_retention_days).await {
                Ok(0) => {}
                Ok(n) => eprintln!("[chat_log] cleaned up {n} rows (older than {} days)", config.server.chat_log_retention_days),
                Err(e) => eprintln!("[chat_log] cleanup failed: {e:#}"),
            }
            tokio::select! {
                _ = cleanup.shutdown.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(3600)) => {}
            }
        }
    });
}
