//! Process-wide state shared by the HTTP handlers and background jobs.

use crate::{
    config::Config,
    db::Db,
    embed_sync::EmbedSync,
    embedding::QueryCache,
    llm::LlmClient,
    mcp::McpHub,
    oracle::Oracle,
    session::SessionStore,
};
use std::{
    path::PathBuf,
    sync::{Arc, RwLock, atomic::AtomicUsize},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

/// How long a blocking thread of the server waits for its next task before
/// it ends: it does not end. The tokenizer (tiktoken-rs) keeps 128 copies of
/// its regex and takes one by the thread's ID, and each copy a thread used
/// keeps its match cache for good. Threads that ended after Tokio's 10 s
/// were followed by threads with new IDs, so a server with pauses between
/// questions filled copy after copy (72 MiB over the first 300 threads,
/// measured, and more for more varied text). Kept, the threads that count
/// tokens are as many as were ever busy at once.
const BLOCKING_THREAD_IDLE: Duration = Duration::MAX;

/// The server's Tokio runtime.
pub fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_keep_alive(BLOCKING_THREAD_IDLE)
        .build()
}

/// Raises this process's open-file limit to the most the system allows and
/// returns the limit before and after, when it was raised. Each connection
/// (a browser's, the management DB's, a provider's) and each MCP server's
/// pipes take a descriptor, and a backend started from a macOS terminal
/// had 256: a few hundred connections at once failed new ones ("too many
/// open files") — the management DB, the model, the browser's next request.
/// Node, which ran the former backend, raises it at start in the same way.
#[cfg(unix)]
pub fn raise_open_file_limit() -> Option<(libc::rlim_t, libc::rlim_t)> {
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: getrlimit and setrlimit read and write this process's limit.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 || limit.rlim_cur >= limit.rlim_max {
        return None;
    }
    let before = limit.rlim_cur;
    let set = |value: libc::rlim_t| {
        let wanted = libc::rlimit { rlim_cur: value, rlim_max: limit.rlim_max };
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &wanted) == 0 }
    };
    // The hard limit, or the most below it the system takes (macOS refuses
    // a soft limit past kern.maxfilesperproc, even under an unlimited hard
    // one).
    let (mut taken, mut refused) = (before, limit.rlim_max);
    if !set(refused) {
        while refused - taken > 1 {
            let middle = taken + (refused - taken) / 2;
            if set(middle) {
                taken = middle;
            } else {
                refused = middle;
            }
        }
        if !set(taken) {
            return None;
        }
    } else {
        taken = refused;
    }
    (taken > before).then_some((before, taken))
}

pub struct App {
    pub config_path: PathBuf,
    config: RwLock<Arc<Config>>,
    /// Serializes settings and project writes (read-modify-save).
    pub config_write: tokio::sync::Mutex<()>,
    /// The settings this process started with: port and Oracle client
    /// folders apply only at start.
    pub started: Arc<Config>,
    pub db: Db,
    pub oracle: Arc<Oracle>,
    pub sessions: SessionStore,
    pub llm: Arc<dyn LlmClient>,
    pub embeddings: QueryCache,
    pub sync: EmbedSync,
    /// MCP tool servers; `serve` starts them from the settings.
    pub mcp: McpHub,
    /// Key of admin record revisions; a restart invalidates open editors.
    pub revision_key: [u8; 32],
    pub shutdown: CancellationToken,
    pub pending_logs: AtomicUsize,
}

impl App {
    pub fn new(config_path: PathBuf, config: Config, llm: Arc<dyn LlmClient>) -> Arc<Self> {
        // The proxy address in the settings may carry its password too.
        crate::tools::keep_out(&config_path);
        crate::tools::keep_out(&crate::config::credentials_path(&config_path));
        let config = Arc::new(config);
        Arc::new(Self {
            config_path,
            config: RwLock::new(config.clone()),
            config_write: tokio::sync::Mutex::new(()),
            started: config,
            db: Db::default(),
            oracle: Arc::new(Oracle::default()),
            sessions: SessionStore::default(),
            llm,
            embeddings: QueryCache::default(),
            sync: EmbedSync::default(),
            mcp: McpHub::default(),
            revision_key: rand::random(),
            shutdown: CancellationToken::new(),
            pending_logs: AtomicUsize::new(0),
        })
    }

    /// A snapshot of the current settings.
    pub fn config(&self) -> Arc<Config> {
        self.config.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Saves and applies new settings. The caller holds `config_write`.
    pub fn store_config(&self, mut config: Config) -> anyhow::Result<Arc<Config>> {
        config.number_projects();
        config.save(&self.config_path)?;
        let config = Arc::new(config);
        *self.config.write().unwrap_or_else(|p| p.into_inner()) = config.clone();
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A blocking thread outlasts a pause longer than Tokio's default keep-
    /// alive, so the next task (a tool counting tokens) runs on the same
    /// thread and the tokenizer copy it already filled (see
    /// `BLOCKING_THREAD_IDLE`).
    #[test]
    fn blocking_threads_outlast_a_pause() {
        let runtime = runtime().unwrap();
        let thread = || runtime.block_on(runtime.spawn_blocking(|| std::thread::current().id())).unwrap();
        let first = thread();
        std::thread::sleep(Duration::from_secs(11));
        assert_eq!(thread(), first);
    }
}
