//! Settings: `config.toml` holds everything the admin screen edits, and
//! `config.credentials.json` (owner-only permissions) holds the secrets the
//! screen can set or clear but never read back. On first start, when no
//! `config.toml` exists, the former Node backend's `.env` is imported.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

/// Tokens one tool result may fill when `result_tokens` is unset, as Claude
/// Code bounds a file read: each result on its own, however many calls one
/// response makes. A context smaller than 8 × this gives each result an
/// eighth of it.
pub const DEFAULT_RESULT_TOKENS: usize = 25_000;
pub const RESULT_CONTEXT_SHARE: usize = 8;
pub const MIN_RESULT_TOKENS: usize = 200;
/// Vector width of the `vec_*` tables (schema.sql).
pub const EMBEDDING_DIMENSIONS: usize = 1024;
/// Upper bound of the seconds settings (one day).
pub const MAX_TIMEOUT_SECS: u64 = 86_400;
/// Upper bound of the conversation idle time (one year).
pub const MAX_IDLE_MINUTES: u64 = 525_600;

mod empty_is_none {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &Option<String>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(value.as_deref().unwrap_or(""))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
        let value: Option<String> = Option::deserialize(d)?;
        Ok(value.filter(|v| !v.trim().is_empty()))
    }
}

pub(crate) fn deadline_after(seconds: u64) -> Result<std::time::Instant> {
    if seconds == 0 {
        bail!("invalid_timeout: timeout must be positive");
    }
    std::time::Instant::now()
        .checked_add(std::time::Duration::from_secs(seconds))
        .ok_or_else(|| anyhow::anyhow!("invalid_timeout: timeout exceeds supported clock range"))
}

#[derive(Clone)]
pub struct Secret(pub String);
impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct LlmConfig {
    #[serde(skip)]
    pub api_key: Option<Secret>,
    pub base_url: String,
    pub model: String,
    pub proxy: Option<String>,
    pub disable_proxy: bool,
    pub context_tokens: usize,
    pub output_tokens: usize,
    /// low, medium or high; unset sends none. TOML has no null, so an unset
    /// effort is stored as "".
    #[serde(with = "empty_is_none")]
    pub reasoning_effort: Option<String>,
    /// When false the provider's no-reasoning value is sent even if an
    /// effort is kept for re-enabling.
    pub enable_thinking: bool,
    pub legacy_max_tokens: bool,
    pub stream_usage: bool,
    /// Bounds waiting for response headers and each silent gap in the
    /// stream, not the whole answer.
    pub request_timeout_secs: u64,
    pub retries: usize,
    /// Runtime only: whether a request that timed out is retried as is.
    #[serde(skip)]
    pub retry_timeouts: bool,
}
impl PartialEq for Secret {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            api_key: None,
            base_url: "https://openrouter.ai/api/v1".into(),
            model: String::new(),
            proxy: None,
            disable_proxy: false,
            context_tokens: 128_000,
            output_tokens: 16_384,
            reasoning_effort: Some("low".into()),
            enable_thinking: true,
            legacy_max_tokens: false,
            stream_usage: true,
            request_timeout_secs: 120,
            retries: 2,
            retry_timeouts: true,
        }
    }
}
impl LlmConfig {
    pub fn completion_url(&self) -> Result<reqwest::Url> {
        let mut url = reqwest::Url::parse(&self.base_url)
            .map_err(|_| anyhow::anyhow!("LLM 주소(base_url)가 올바른 URL이 아닙니다."))?;
        if !matches!(url.scheme(), "http" | "https") {
            bail!("LLM 주소(base_url)는 http 또는 https여야 합니다.");
        }
        if url.fragment().is_some() {
            bail!("LLM 주소(base_url)에 #은 쓸 수 없습니다.");
        }
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| anyhow::anyhow!("LLM 주소(base_url)가 올바른 URL이 아닙니다."))?;
            path.pop_if_empty();
            path.push("chat");
            path.push("completions");
        }
        Ok(url)
    }
    pub fn validate(&self) -> Result<()> {
        self.completion_url()?;
        if self.output_tokens == 0 || self.context_tokens == 0 || self.request_timeout_secs == 0 {
            bail!("모델 연결의 토큰·시간 한도는 0보다 커야 합니다.");
        }
        if !self.disable_proxy
            && let Some(proxy) = self.proxy.as_deref().filter(|p| !p.trim().is_empty())
        {
            reqwest::Proxy::all(proxy).map_err(|_| anyhow::anyhow!("프록시 주소가 올바르지 않습니다."))?;
        }
        Ok(())
    }
    /// A chat request needs a model name on top of a valid configuration.
    pub fn runnable(&self) -> Result<()> {
        self.validate()?;
        if self.model.trim().is_empty() {
            bail!("LLM 모델이 설정되지 않았습니다. 관리자 화면의 설정 탭에서 모델 연결을 설정해주세요.");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct EmbeddingConfig {
    /// OpenAI-compatible base URL (Ollama: http://localhost:11434/v1). Empty
    /// turns vector search off; exact query-name lookup still works.
    pub url: String,
    pub model: String,
    /// Prepended to search texts only; stored rows are embedded as written.
    pub query_prefix: String,
    /// Seconds between background syncs; 0 turns the periodic sync off.
    pub sync_interval_secs: u64,
    /// Cosine distance threshold; the nearest few are kept regardless.
    pub max_distance: f64,
    /// MHNSW search depth. The server default (20) loses recall at 1024
    /// dimensions.
    pub ef_search: u32,
    pub timeout_secs: u64,
}
impl Default for EmbeddingConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            model: "qwen3-embedding:0.6b".into(),
            query_prefix: String::new(),
            sync_interval_secs: 60,
            max_distance: 0.4,
            ef_search: 150,
            timeout_secs: 60,
        }
    }
}
impl EmbeddingConfig {
    pub fn enabled(&self) -> bool {
        !self.url.trim().is_empty()
    }
    /// The prefix with `\n`, `\t` and `\\` written as text turned back into
    /// characters (a `.env` value without double quotes keeps them literal).
    pub fn decoded_prefix(&self) -> String {
        let mut out = String::new();
        let mut chars = self.query_prefix.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.peek() {
                    Some('n') => {
                        out.push('\n');
                        chars.next();
                        continue;
                    }
                    Some('t') => {
                        out.push('\t');
                        chars.next();
                        continue;
                    }
                    Some('\\') => {
                        out.push('\\');
                        chars.next();
                        continue;
                    }
                    _ => {}
                }
            }
            out.push(c);
        }
        out
    }
    pub fn validate(&self) -> Result<()> {
        if self.enabled() {
            let url = reqwest::Url::parse(&self.url)
                .map_err(|_| anyhow::anyhow!("임베딩 주소가 올바른 URL이 아닙니다."))?;
            if !matches!(url.scheme(), "http" | "https") {
                bail!("임베딩 주소는 http 또는 https여야 합니다.");
            }
        }
        if self.model.trim().is_empty() {
            bail!("임베딩 모델 이름을 입력해주세요.");
        }
        if !(self.max_distance.is_finite() && self.max_distance > 0.0 && self.max_distance <= 2.0) {
            bail!("관련도 거리 문턱은 0보다 크고 2 이하여야 합니다.");
        }
        if !(1..=10_000).contains(&self.ef_search) || self.timeout_secs == 0 {
            bail!("벡터 탐색 깊이는 1~10000, 임베딩 시간 한도는 0보다 커야 합니다.");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct MariaDbConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub pool_size: usize,
    pub timeout_ms: u64,
    #[serde(skip)]
    pub password: Option<Secret>,
}
impl Default for MariaDbConfig {
    fn default() -> Self {
        Self {
            host: "localhost".into(),
            port: 3306,
            user: String::new(),
            database: "llm_agent".into(),
            // Five connections per concurrent question, four questions, and
            // one for the embedding sync's lock (the former Node sizing).
            pool_size: 21,
            timeout_ms: 30_000,
            password: None,
        }
    }
}
impl MariaDbConfig {
    pub fn validate(&self) -> Result<()> {
        if self.host.trim().is_empty() || self.database.trim().is_empty() || self.port == 0 {
            bail!("관리 DB의 호스트·포트·DB 이름을 입력해주세요.");
        }
        if !(1..=200).contains(&self.pool_size) || self.timeout_ms == 0 {
            bail!("관리 DB 풀 크기는 1~200, 시간 한도는 0보다 커야 합니다.");
        }
        Ok(())
    }
    /// Identity of a connection: a pool is rebuilt when it changes.
    pub fn fingerprint(&self) -> String {
        let mut hash = Sha256::new();
        for part in [
            self.host.as_str(),
            &self.port.to_string(),
            &self.user,
            &self.database,
            &self.pool_size.to_string(),
            self.password.as_ref().map_or("", |s| s.0.as_str()),
        ] {
            hash.update(part.len().to_le_bytes());
            hash.update(part.as_bytes());
        }
        hex::encode(hash.finalize())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct OracleConfig {
    /// Oracle Instant Client directory. Empty uses the OS search path
    /// (PATH, LD_LIBRARY_PATH, ~/lib on macOS). Applied at startup.
    pub client_lib_dir: String,
    /// Directory of tnsnames.ora/sqlnet.ora (TNS_ADMIN). Applied at startup.
    pub client_config_dir: String,
    pub timeout_ms: u64,
    /// Runs procedures and functions in a read-only transaction. It stops
    /// stray DML only; a COMMIT inside a routine or an autonomous
    /// transaction still writes.
    pub routine_read_only: bool,
    /// Answers registered demo queries from built-in stub data without
    /// connecting anywhere.
    pub mock: bool,
}
impl Default for OracleConfig {
    fn default() -> Self {
        Self {
            client_lib_dir: String::new(),
            client_config_dir: String::new(),
            timeout_ms: 30_000,
            routine_read_only: true,
            mock: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct AgentConfig {
    /// Former limit on model requests per question; a question now runs
    /// until it answers or `run_seconds` is near. Read so an older
    /// `config.toml` loads; not used and not written back.
    #[serde(skip_serializing)]
    pub max_rounds: Option<usize>,
    /// Seconds a question may run; the browser gives up at 450. Near the
    /// end the model is asked to answer without tools.
    pub run_seconds: u64,
    /// Share of the input budget that starts evicting old history bundles.
    pub high_water: f64,
    /// Share eviction brings the estimate down to.
    pub low_water: f64,
    /// Bytes of evicted history (bundles out of the context and archived
    /// results) one conversation keeps for the history tool, as held in
    /// memory (`session::Held`).
    pub history_bytes: usize,
    /// Tokens of one tool result. Empty: see `Config::result_budget`.
    pub result_tokens: Option<usize>,
    /// Former limit on all results of one response, which divided it among
    /// the calls. Still read so an older `config.toml` loads; not used and
    /// not written back.
    #[serde(skip_serializing)]
    pub batch_tokens: Option<usize>,
    /// Former limit on tool calls run from one response; every call runs
    /// now (a response past `llm::MAX_TOOL_CALLS` is malformed). Read so an
    /// older `config.toml` loads; not used and not written back.
    #[serde(skip_serializing)]
    pub max_tool_calls: Option<usize>,
    pub tool_timeout_secs: u64,
    /// Former setting for identical unchanged reads before a read is
    /// suppressed; fixed now (`tools::REPEATED_READ_LIMIT`). Read so an older
    /// `config.toml` loads; not used and not written back.
    #[serde(skip_serializing)]
    pub repeated_read_limit: Option<usize>,
    pub session_idle_minutes: u64,
    pub max_sessions: usize,
    /// Bytes of fetched query rows one conversation keeps for result_read
    /// and table references, as held in memory (`session::Held`).
    pub result_store_bytes: usize,
}
impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            max_rounds: None,
            run_seconds: 400,
            high_water: 0.9,
            low_water: 0.5,
            history_bytes: 16 * 1024 * 1024,
            result_tokens: None,
            batch_tokens: None,
            max_tool_calls: None,
            tool_timeout_secs: 30,
            repeated_read_limit: None,
            session_idle_minutes: 60,
            max_sessions: 200,
            result_store_bytes: 32 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// Applied at the next start.
    pub port: u16,
    pub chat_log_retention_days: u32,
}
impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: 5173,
            chat_log_retention_days: 3,
        }
    }
}

/// A source tree the agent may read to answer questions about a project.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Project {
    /// Number shown and used in the admin screen; assigned on save.
    pub seq: u64,
    pub name: String,
    /// What the project is; the model picks a project by it.
    pub description: String,
    pub root: PathBuf,
    /// Reference Markdown documents, relative to `root` or absolute.
    pub docs: Vec<String>,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}
impl Default for Project {
    fn default() -> Self {
        Self {
            seq: 0,
            name: String::new(),
            description: String::new(),
            root: PathBuf::new(),
            docs: vec![],
            include: vec![],
            exclude: vec![],
        }
    }
}

/// An MCP tool server (docs/mcp-design.md): a command spoken to over stdio,
/// or a Streamable HTTP endpoint. Its tools join the agent's as
/// `name__tool`, those in `tools` only.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct McpServer {
    /// Letters, digits, '-' and '_' (no "__"), at most 24: the start of its
    /// tool names.
    pub name: String,
    /// What the server is for; the model picks its tools by it.
    pub description: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub command: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Working folder of the command; empty is the backend's.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cwd: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    /// Reach the server without a proxy: an HTTP server is connected to
    /// directly, and a command does not inherit the proxy variables (it is
    /// given `NO_PROXY=*` unless its `env` says otherwise).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub disable_proxy: bool,
    /// Tools offered to the model: their names, or "*" for every tool.
    pub tools: Vec<String>,
    /// Seconds one call may take; unset is `agent.tool_timeout_secs`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    /// Environment of the command beyond the safe inherited set. A value
    /// `ENV:NAME` reads the backend's environment (and `.env`).
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// HTTP headers of every request; values as `env`.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// Environment values and headers kept in the secrets file; they win
    /// over the visible ones of the same name.
    #[serde(skip)]
    pub secret_env: BTreeMap<String, Secret>,
    #[serde(skip)]
    pub secret_headers: BTreeMap<String, Secret>,
}
impl Default for McpServer {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            enabled: true,
            command: String::new(),
            args: vec![],
            cwd: String::new(),
            url: String::new(),
            disable_proxy: false,
            tools: vec![],
            timeout_secs: None,
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            secret_env: BTreeMap::new(),
            secret_headers: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub llm: LlmConfig,
    pub embedding: EmbeddingConfig,
    pub mariadb: MariaDbConfig,
    pub oracle: OracleConfig,
    pub agent: AgentConfig,
    pub server: ServerConfig,
    pub projects: Vec<Project>,
    pub mcp_servers: Vec<McpServer>,
    /// Shared admin key; empty leaves the admin API open to the local
    /// network (as the former ADMIN_TOKEN did).
    #[serde(skip)]
    pub admin_token: Option<Secret>,
}

/// The secret file: written only by the settings screen and the `.env`
/// import, never sent back to the browser.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Credentials {
    #[serde(skip_serializing_if = "Option::is_none")]
    llm_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mariadb_password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    admin_token: Option<String>,
    /// MCP server secrets by server name.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    mcp: BTreeMap<String, McpCredentials>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct McpCredentials {
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    headers: BTreeMap<String, String>,
}

pub fn credentials_path(config: &Path) -> PathBuf {
    config.with_extension("credentials.json")
}

impl Config {
    /// Tokens of one tool result: the setting, or 25,000 (in a smaller
    /// context an eighth of it, and never past half the input budget).
    pub fn result_budget(&self) -> usize {
        self.agent.result_tokens.unwrap_or_else(|| {
            DEFAULT_RESULT_TOKENS
                .min(self.llm.context_tokens / RESULT_CONTEXT_SHARE)
                .min(self.input_budget() / 2)
                .max(MIN_RESULT_TOKENS)
        })
    }
    /// Input tokens a request may use: the context minus one response and a
    /// small frame.
    pub fn input_budget(&self) -> usize {
        self.llm
            .context_tokens
            .saturating_sub(self.llm.output_tokens.saturating_add(1024))
    }

    pub fn validate(&self) -> Result<()> {
        self.llm.validate()?;
        self.embedding.validate()?;
        self.mariadb.validate()?;
        let a = &self.agent;
        if !(0.0 < a.low_water && a.low_water < a.high_water && a.high_water < 1.0) {
            bail!("컨텍스트 비우기 비율은 0 < 하한 < 상한 < 1 이어야 합니다.");
        }
        if a.run_seconds == 0
            || a.tool_timeout_secs == 0
            || a.history_bytes < 64 * 1024
            || a.session_idle_minutes == 0
            || a.max_sessions == 0
            || a.result_store_bytes < 64 * 1024
        {
            bail!("실행 한도는 0보다 커야 하고, 이력·결과 보관 용량은 64KiB 이상이어야 합니다.");
        }
        // A deadline is the current instant plus these: past the clock's
        // range the addition panics on every question.
        if a.run_seconds > MAX_TIMEOUT_SECS
            || a.tool_timeout_secs > MAX_TIMEOUT_SECS
            || a.session_idle_minutes > MAX_IDLE_MINUTES
        {
            bail!("실행·도구 시간 한도는 {MAX_TIMEOUT_SECS}초, 대화 보관 시간은 {MAX_IDLE_MINUTES}분 이하여야 합니다.");
        }
        if self.result_budget() < MIN_RESULT_TOKENS {
            bail!("도구 결과 한도는 {MIN_RESULT_TOKENS} 토큰 이상이어야 합니다.");
        }
        if self.input_budget() < 4096 {
            bail!("컨텍스트가 출력을 빼고 4,096 토큰 이상 남아야 합니다. 출력 한도를 줄이거나 컨텍스트를 늘려주세요.");
        }
        if self.result_budget() > self.input_budget() / 2 {
            bail!(
                "도구 결과 하나의 한도({} 토큰)는 출력을 뺀 컨텍스트의 절반({} 토큰) 이하여야 합니다.",
                self.result_budget(),
                self.input_budget() / 2
            );
        }
        // The Oracle client takes its limits as 32-bit milliseconds: past
        // them every query failed, the pool or session refusing the limit.
        if self.oracle.timeout_ms == 0 || self.oracle.timeout_ms > MAX_TIMEOUT_SECS * 1000 {
            bail!("Oracle 시간 한도는 0보다 크고 {} ms(하루) 이하여야 합니다.", MAX_TIMEOUT_SECS * 1000);
        }
        if self.server.port == 0 || self.server.chat_log_retention_days == 0 {
            bail!("서버 포트와 대화 로그 보관 일수는 0보다 커야 합니다.");
        }
        let mut names = std::collections::BTreeSet::new();
        let mut seqs = std::collections::BTreeSet::new();
        for project in &self.projects {
            crate::projects::validate(project)?;
            if !names.insert(crate::text::name_key(&project.name)) {
                bail!("같은 이름의 프로젝트가 이미 있습니다: {}", project.name);
            }
            if project.seq != 0 && !seqs.insert(project.seq) {
                bail!("프로젝트 번호가 중복되었습니다.");
            }
        }
        let mut servers = std::collections::BTreeSet::new();
        for server in &self.mcp_servers {
            crate::mcp::validate_server(server)?;
            if !servers.insert(server.name.to_ascii_lowercase()) {
                bail!("같은 이름의 MCP 서버가 이미 있습니다: {}", server.name);
            }
        }
        Ok(())
    }

    /// Defaults, then `config.toml`, then the secrets file. A missing
    /// `config.toml` is created from `.env` (see `import_env`).
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            let imported = Self::import_env(&dotenv_map(), std::env::vars().collect());
            imported.save(path)?;
            eprintln!(
                "[config] {} was missing — created it from .env and the process environment",
                path.display()
            );
        }
        let text = std::fs::read_to_string(path)?;
        let mut config: Config =
            toml::from_str(&text).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))?;
        let credentials = credentials_path(path);
        if credentials.exists() {
            let secrets: Credentials = serde_json::from_str(&std::fs::read_to_string(&credentials)?)
                .map_err(|e| anyhow::anyhow!("{}: {e}", credentials.display()))?;
            config.apply_credentials(secrets);
        }
        config.number_projects();
        // The former per-response limit allowed one result past half the
        // input budget; such a file still starts, with the limit lowered.
        let half = config.input_budget() / 2;
        if let Some(tokens) = config.agent.result_tokens
            && tokens > half
            && half >= MIN_RESULT_TOKENS
        {
            eprintln!("[config] agent.result_tokens {tokens} is past half the input budget; {half} is used");
            config.agent.result_tokens = Some(half);
        }
        config.validate()?;
        Ok(config)
    }

    /// Gives projects without a number the next free one.
    pub fn number_projects(&mut self) {
        let mut next = self.projects.iter().map(|p| p.seq).max().unwrap_or(0);
        for project in &mut self.projects {
            if project.seq == 0 {
                next += 1;
                project.seq = next;
            }
        }
    }

    fn apply_credentials(&mut self, c: Credentials) {
        let secret = |v: Option<String>| v.filter(|s| !s.is_empty()).map(Secret);
        self.llm.api_key = secret(c.llm_api_key);
        self.mariadb.password = secret(c.mariadb_password);
        self.admin_token = secret(c.admin_token);
        // Secrets kept for a server name config.toml no longer has (renamed
        // by hand) do not reach it, and the next save drops them.
        for name in c.mcp.keys().filter(|name| !self.mcp_servers.iter().any(|s| &s.name == *name)) {
            eprintln!("[config] the secrets file holds MCP secrets for {name:?}, which config.toml has no server for — enter them again on the server they belong to; the next save drops them");
        }
        for server in &mut self.mcp_servers {
            let stored = c.mcp.get(&server.name).cloned().unwrap_or_default();
            let secrets = |values: BTreeMap<String, String>| {
                values.into_iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| (k, Secret(v))).collect()
            };
            server.secret_env = secrets(stored.env);
            server.secret_headers = secrets(stored.headers);
        }
    }

    fn credentials(&self) -> Credentials {
        Credentials {
            llm_api_key: self.llm.api_key.as_ref().map(|s| s.0.clone()),
            mariadb_password: self.mariadb.password.as_ref().map(|s| s.0.clone()),
            admin_token: self.admin_token.as_ref().map(|s| s.0.clone()),
            mcp: self
                .mcp_servers
                .iter()
                .filter(|s| !s.secret_env.is_empty() || !s.secret_headers.is_empty())
                .map(|s| {
                    let plain = |values: &BTreeMap<String, Secret>| {
                        values.iter().map(|(k, v)| (k.clone(), v.0.clone())).collect()
                    };
                    (s.name.clone(), McpCredentials { env: plain(&s.secret_env), headers: plain(&s.secret_headers) })
                })
                .collect(),
        }
    }

    /// Writes `config.toml` and the secrets file atomically. The secrets
    /// file keeps owner-only permissions.
    pub fn save(&self, path: &Path) -> Result<()> {
        self.validate()?;
        write_atomic(path, toml::to_string_pretty(self)?.as_bytes(), false)?;
        write_atomic(
            &credentials_path(path),
            serde_json::to_string_pretty(&self.credentials())?.as_bytes(),
            true,
        )?;
        Ok(())
    }

    /// The former Node backend's environment, mapped onto the settings.
    pub fn import_env(dotenv: &BTreeMap<String, String>, process: BTreeMap<String, String>) -> Self {
        // The process environment wins over the file, as dotenv did.
        let mut env = dotenv.clone();
        env.extend(process);
        let get = |key: &str| env.get(key).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let num = |key: &str| get(key).and_then(|v| v.parse::<u64>().ok());
        let flag = |key: &str| {
            get(key).map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        };
        let mut c = Config::default();
        if let Some(v) = get("MARIADB_HOST") {
            c.mariadb.host = v;
        }
        if let Some(v) = num("MARIADB_PORT").and_then(|v| u16::try_from(v).ok()) {
            c.mariadb.port = v;
        }
        if let Some(v) = get("MARIADB_USER") {
            c.mariadb.user = v;
        }
        if let Some(v) = env.get("MARIADB_PASSWORD").filter(|v| !v.is_empty()) {
            c.mariadb.password = Some(Secret(v.clone()));
        }
        if let Some(v) = get("MARIADB_DATABASE") {
            c.mariadb.database = v;
        }
        if let Some(v) = num("MARIADB_POOL_SIZE") {
            c.mariadb.pool_size = v as usize;
        }
        if let Some(v) = num("MARIADB_TIMEOUT_MS") {
            c.mariadb.timeout_ms = v;
        }
        // LLM_PROVIDER=mock was a planner without a model; with it the model
        // stays unset and chat asks for one in the settings screen.
        if get("LLM_PROVIDER").is_some_and(|p| p.eq_ignore_ascii_case("openai")) {
            if let Some(v) = get("LLM_BASE_URL") {
                c.llm.base_url = v;
            }
            if let Some(v) = get("LLM_MODEL") {
                c.llm.model = v;
            }
        }
        if let Some(v) = env.get("LLM_API_KEY").filter(|v| !v.trim().is_empty()) {
            c.llm.api_key = Some(Secret(v.trim().to_owned()));
        }
        match get("LLM_REASONING_EFFORT").as_deref() {
            Some("off") => c.llm.reasoning_effort = None,
            Some(v) => c.llm.reasoning_effort = Some(v.to_owned()),
            None => {}
        }
        if let Some(v) = flag("ORACLE_MOCK") {
            c.oracle.mock = v;
        }
        if let Some(v) = get("ORACLE_CLIENT_LIB_DIR") {
            c.oracle.client_lib_dir = v;
        }
        if let Some(v) = get("ORACLE_CLIENT_CONFIG_DIR") {
            c.oracle.client_config_dir = v;
        }
        if let Some(v) = num("ORACLE_TIMEOUT_MS") {
            c.oracle.timeout_ms = v;
        }
        if let Some(v) = flag("ORACLE_ROUTINE_READ_ONLY") {
            c.oracle.routine_read_only = v;
        }
        if let Some(v) = num("PORT").and_then(|v| u16::try_from(v).ok()).filter(|v| *v > 0) {
            c.server.port = v;
        }
        if let Some(v) = get("ADMIN_TOKEN") {
            c.admin_token = Some(Secret(v));
        }
        if let Some(v) = get("EMBEDDING_URL") {
            c.embedding.url = v;
        }
        if let Some(v) = get("EMBEDDING_MODEL") {
            c.embedding.model = v;
        }
        if let Some(v) = env.get("EMBEDDING_QUERY_PREFIX").filter(|v| !v.is_empty()) {
            c.embedding.query_prefix = v.clone();
        }
        if let Some(v) = num("EMBED_SYNC_INTERVAL") {
            c.embedding.sync_interval_secs = v;
        }
        c
    }

    /// Revision of the settings as the admin screen edits them: changes when
    /// any setting or the presence of a secret changes.
    pub fn revision(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(toml::to_string(self).unwrap_or_default().as_bytes());
        for secret in [
            self.llm.api_key.as_ref(),
            self.mariadb.password.as_ref(),
            self.admin_token.as_ref(),
        ] {
            hash.update(secret.map_or(&[0u8][..], |s| s.0.as_bytes()));
            hash.update([0xff]);
        }
        for server in &self.mcp_servers {
            for (key, value) in server.secret_env.iter().chain(&server.secret_headers) {
                for part in [server.name.as_str(), key, value.0.as_str()] {
                    hash.update(part.len().to_le_bytes());
                    hash.update(part.as_bytes());
                }
            }
        }
        hex::encode(hash.finalize())
    }
}

/// `.env` next to the working directory, as dotenv read it.
pub fn dotenv_map() -> BTreeMap<String, String> {
    dotenvy::from_path_iter(".env")
        .map(|iter| iter.filter_map(Result::ok).collect())
        .unwrap_or_default()
}

fn write_atomic(path: &Path, bytes: &[u8], private: bool) -> Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    match std::fs::metadata(path) {
        Ok(metadata) if !private => temp.as_file().set_permissions(metadata.permissions())?,
        Ok(metadata) if !metadata.is_file() => bail!("{} is not a regular file", path.display()),
        _ => {}
    }
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_servers_keep_their_secrets_in_the_secrets_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::default();
        let mut server = McpServer {
            name: "wiki".into(),
            url: "https://wiki.example.com/mcp".into(),
            tools: vec!["*".into()],
            ..Default::default()
        };
        server.headers.insert("X-Team".into(), "voc".into());
        server.secret_headers.insert("Authorization".into(), Secret("Bearer s3cret".into()));
        config.mcp_servers.push(server);
        let mut local = McpServer { name: "jira".into(), command: "npx".into(), args: vec!["-y".into(), "jira-mcp".into()], ..Default::default() };
        local.env.insert("JIRA_TOKEN".into(), "ENV:JIRA_TOKEN".into());
        local.timeout_secs = Some(20);
        config.mcp_servers.push(local);
        config.save(&path).unwrap();
        let toml = std::fs::read_to_string(&path).unwrap();
        assert!(toml.contains("[[mcp_servers]]") && toml.contains("X-Team") && toml.contains("ENV:JIRA_TOKEN"), "{toml}");
        assert!(!toml.contains("s3cret"), "{toml}");
        let secrets = std::fs::read_to_string(credentials_path(&path)).unwrap();
        assert!(secrets.contains("Bearer s3cret"), "{secrets}");
        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.mcp_servers, config.mcp_servers);
        assert_eq!(loaded.revision(), config.revision());
        let mut changed = loaded.clone();
        changed.mcp_servers[0].secret_headers.insert("Authorization".into(), Secret("Bearer other".into()));
        assert_ne!(changed.revision(), loaded.revision(), "a changed secret changes the revision");
        // A server written by hand: the defaults fill in what it leaves out.
        std::fs::write(&path, "[[mcp_servers]]\nname = \"x\"\ncommand = \"node\"\n").unwrap();
        let loaded = Config::load(&path).unwrap();
        assert!(loaded.mcp_servers[0].enabled && loaded.mcp_servers[0].tools.is_empty());
        std::fs::write(&path, "[[mcp_servers]]\nname = \"x\"\ncommand = \"node\"\ntool = [\"*\"]\n").unwrap();
        assert!(Config::load(&path).is_err(), "a misspelt key is refused, not ignored");
        std::fs::write(&path, "[[mcp_servers]]\nname = \"x\"\ncommand = \"node\"\n[[mcp_servers]]\nname = \"X\"\nurl = \"http://h/mcp\"\n").unwrap();
        assert!(Config::load(&path).is_err(), "names are unique ignoring case");
    }

    #[test]
    fn defaults_validate_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut config = Config::default();
        config.llm.reasoning_effort = None;
        config.llm.api_key = Some(Secret("sk-test".into()));
        config.mariadb.password = Some(Secret("pw".into()));
        config.save(&path).unwrap();
        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded, config);
        assert!(!std::fs::read_to_string(&path).unwrap().contains("sk-test"));
        let secrets = std::fs::read_to_string(credentials_path(&path)).unwrap();
        assert!(secrets.contains("sk-test"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(credentials_path(&path)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn time_settings_stay_within_the_clock_range() {
        let mut config = Config::default();
        config.agent.run_seconds = MAX_TIMEOUT_SECS;
        config.agent.tool_timeout_secs = MAX_TIMEOUT_SECS;
        config.agent.session_idle_minutes = MAX_IDLE_MINUTES;
        config.validate().unwrap();
        // i64::MAX seconds still saves to TOML, and an instant plus that
        // panics on every question.
        for set in [
            |c: &mut Config| c.agent.run_seconds = i64::MAX as u64,
            |c: &mut Config| c.agent.tool_timeout_secs = MAX_TIMEOUT_SECS + 1,
            |c: &mut Config| c.agent.session_idle_minutes = MAX_IDLE_MINUTES + 1,
        ] {
            let mut wrong = Config::default();
            set(&mut wrong);
            assert!(wrong.validate().unwrap_err().to_string().contains("이하여야"));
        }
        // Past 2^32 ms the Oracle client refuses the limit itself.
        let mut config = Config::default();
        config.oracle.timeout_ms = MAX_TIMEOUT_SECS * 1000;
        config.validate().unwrap();
        config.oracle.timeout_ms = u64::from(u32::MAX) + 1;
        assert!(config.validate().unwrap_err().to_string().contains("Oracle"));
    }

    #[test]
    fn one_result_gets_25k_tokens_or_less_in_a_small_context() {
        let budget = |context: usize, output: usize| {
            let mut config = Config::default();
            config.llm.context_tokens = context;
            config.llm.output_tokens = output;
            (config.result_budget(), config.input_budget())
        };
        assert_eq!(budget(230_000, 16_384), (25_000, 212_592));
        assert_eq!(budget(128_000, 16_384).0, 16_000);
        assert_eq!(budget(16_000, 2_000).0, 2_000);
        // A large output reserve leaves half the input budget at most.
        assert_eq!(budget(64_000, 50_000), (6_488, 12_976));
        let mut config = Config::default();
        config.llm.context_tokens = 230_000;
        config.agent.result_tokens = Some(150_000);
        assert!(config.validate().unwrap_err().to_string().contains("절반"));
        config.agent.result_tokens = Some(60_000);
        config.validate().unwrap();
        assert_eq!(config.result_budget(), 60_000);
    }

    #[test]
    fn a_config_written_with_the_former_batch_limit_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mut text = toml::to_string_pretty(&Config::default()).unwrap();
        assert!(!text.contains("batch_tokens"));
        text = text.replace("[agent]\n", "[agent]\nbatch_tokens = 8000\nmax_rounds = 24\nmax_tool_calls = 8\nrepeated_read_limit = 3\n");
        std::fs::write(&path, text).unwrap();
        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.agent.batch_tokens, Some(8000));
        let written = toml::to_string_pretty(&loaded).unwrap();
        for former in ["batch_tokens", "max_rounds", "max_tool_calls", "repeated_read_limit"] {
            assert!(!written.contains(former), "{former} is not written back");
        }
        // A result limit the former batch limit allowed, past half the input
        // budget now, is lowered on load; the server still starts.
        let mut old = Config::default();
        old.agent.result_tokens = Some(60_000);
        let text = toml::to_string_pretty(&old).unwrap().replace("[agent]\n", "[agent]\nbatch_tokens = 60000\n");
        std::fs::write(&path, text).unwrap();
        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.result_budget(), loaded.input_budget() / 2);
        // Saved from the settings screen, the same value is still refused.
        assert!(old.validate().unwrap_err().to_string().contains("절반"));
    }

    #[test]
    fn env_import_maps_the_node_settings() {
        let env: BTreeMap<String, String> = [
            ("MARIADB_USER", "agent"),
            ("MARIADB_PASSWORD", "agent1234"),
            ("LLM_PROVIDER", "openai"),
            ("LLM_BASE_URL", "https://openrouter.ai/api/v1"),
            ("LLM_MODEL", "qwen/qwen3"),
            ("LLM_API_KEY", "sk-x"),
            ("LLM_REASONING_EFFORT", "off"),
            ("ORACLE_MOCK", "1"),
            ("EMBEDDING_URL", "http://localhost:11434/v1"),
            ("EMBEDDING_QUERY_PREFIX", "Instruct\\nQuery: "),
            ("EMBED_SYNC_INTERVAL", "0"),
            ("PORT", "4001"),
            ("ADMIN_TOKEN", "t"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        let c = Config::import_env(&env, BTreeMap::new());
        assert_eq!(c.mariadb.user, "agent");
        assert_eq!(c.mariadb.password.unwrap().0, "agent1234");
        assert_eq!(c.llm.model, "qwen/qwen3");
        assert_eq!(c.llm.api_key.unwrap().0, "sk-x");
        assert_eq!(c.llm.reasoning_effort, None);
        assert!(c.oracle.mock);
        assert_eq!(c.embedding.decoded_prefix(), "Instruct\nQuery: ");
        assert_eq!(c.embedding.sync_interval_secs, 0);
        assert_eq!(c.server.port, 4001);
        assert_eq!(c.admin_token.unwrap().0, "t");
    }

    #[test]
    fn mock_provider_leaves_the_model_unset() {
        let env: BTreeMap<String, String> = [("LLM_PROVIDER", "mock"), ("LLM_MODEL", "x")]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        let c = Config::import_env(&env, BTreeMap::new());
        assert!(c.llm.model.is_empty());
        assert!(c.llm.runnable().is_err());
    }

    #[test]
    fn revision_changes_with_secrets() {
        let mut c = Config::default();
        let before = c.revision();
        c.llm.api_key = Some(Secret("a".into()));
        assert_ne!(before, c.revision());
    }
}
