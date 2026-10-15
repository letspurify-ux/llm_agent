//! Process-wide state shared by the HTTP handlers and background jobs.

use crate::{
    config::Config,
    db::Db,
    embed_sync::EmbedSync,
    embedding::QueryCache,
    llm::LlmClient,
    oracle::Oracle,
    session::SessionStore,
};
use std::{
    path::PathBuf,
    sync::{Arc, RwLock, atomic::AtomicUsize},
};
use tokio_util::sync::CancellationToken;

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
    /// Key of admin record revisions; a restart invalidates open editors.
    pub revision_key: [u8; 32],
    pub shutdown: CancellationToken,
    pub pending_logs: AtomicUsize,
}

impl App {
    pub fn new(config_path: PathBuf, config: Config, llm: Arc<dyn LlmClient>) -> Arc<Self> {
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
