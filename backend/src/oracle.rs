//! Registered queries against the target Oracle DBs, through the Oracle
//! client library (Instant Client). One pool per target registration; a
//! changed registration replaces its pool. With `oracle.mock` the demo
//! queries answer from built-in rows without connecting.

use crate::{
    config::{Config, OracleConfig},
    db::{self, Db, Row},
    execution::{BindType, Dir, Kind, MAX_RESULT_COLS, execution_spec},
    numbers::{number_from_text, number_json, valid_number_input},
    sql::{SafeError, safe, safe_hint, wasted},
    text::{TRUNC_MARK, clip_marked, clip_utf16, name_key, target_db_names, utf16_len},
};
use anyhow::{Result, bail};
use oracle::sql_type::OracleType;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

/// Rows kept per result; one more is fetched to tell a capped result.
pub const MAX_ROWS: usize = 1000;
/// Characters (UTF-16) kept per cell: a long message or note column is read
/// whole, and a large CLOB is still bounded (rows × cells stay in memory for
/// result_read and the answer's tables).
pub const MAX_CELL_LEN: usize = 4_000;
const MAX_TARGET_DB_NAME_LEN: usize = 200;
const MAX_DB_LIST_LEN: usize = 200;
const POOL_MAX: u32 = 8;
/// A pool no run has used this long is closed (`Oracle::close_idle`), the
/// same 5 minutes its idle sessions are kept for.
pub const POOL_IDLE: Duration = Duration::from_secs(300);

const NLS_SESSION_FORMATS: &str = "ALTER SESSION SET NLS_DATE_FORMAT='YYYY-MM-DD HH24:MI:SS' NLS_NUMERIC_CHARACTERS='.,' NLS_TIMESTAMP_FORMAT='YYYY-MM-DD HH24:MI:SS.FF3' NLS_TIMESTAMP_TZ_FORMAT='YYYY-MM-DD HH24:MI:SS.FF3 TZH:TZM'";
const PREPARE_DBMS_OUTPUT: &str = "BEGIN DBMS_OUTPUT.DISABLE; DBMS_OUTPUT.ENABLE(NULL); END;";
const CLEAR_DBMS_OUTPUT: &str = "BEGIN DBMS_OUTPUT.DISABLE; END;";

const UNRUNNABLE_HINT: &str =
    "이 쿼리는 실행할 수 없다 — 다른 쿼리를 선택하거나 지금까지의 정보로 답변하라";
const SETUP_HINT: &str =
    "설정 문제라 재시도해도 결과가 같다 — 다른 쿼리를 선택하거나 지금까지의 정보로 답변하라";

/// Rows of one run.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub rows: Vec<Map<String, Value>>,
    pub capped: bool,
    pub target_db: String,
    /// Key of the column-omission note when rows were wider than the limit.
    pub omitted_column_key: Option<String>,
}

struct PoolEntry {
    fingerprint: String,
    pool: Arc<oracle::pool::Pool>,
    last_used: Instant,
}

#[derive(Default)]
pub struct Oracle {
    pools: Mutex<HashMap<String, PoolEntry>>,
    client: OnceLock<std::result::Result<String, String>>,
}

impl Oracle {
    /// Loads the Oracle client library once per process (it cannot be
    /// reloaded). Returns the client version or why it is unavailable.
    pub fn init_client(&self, cfg: &OracleConfig) -> std::result::Result<String, String> {
        self.client
            .get_or_init(|| {
                let mut params = oracle::InitParams::new();
                if !cfg.client_lib_dir.trim().is_empty() {
                    params
                        .oracle_client_lib_dir(cfg.client_lib_dir.trim())
                        .map_err(|e| e.to_string())?;
                }
                if !cfg.client_config_dir.trim().is_empty() {
                    params
                        .oracle_client_config_dir(cfg.client_config_dir.trim())
                        .map_err(|e| e.to_string())?;
                }
                params.init().map_err(|e| e.to_string())?;
                oracle::Version::client()
                    .map(|v| v.to_string())
                    .map_err(|e| e.to_string())
            })
            .clone()
    }

    /// The client state without loading it.
    pub fn client_state(&self) -> Option<std::result::Result<String, String>> {
        self.client.get().cloned()
    }

    /// `init_client` from async code: the library is loaded (its files read
    /// from its folder, a network drive's too), or a load under way waited
    /// for, on a blocking thread. Loaded on the runtime's own, as a query
    /// and the settings screen's check did, a folder that did not answer
    /// held a thread serving every request.
    pub async fn load_client(self: &Arc<Self>, cfg: &OracleConfig) -> std::result::Result<String, String> {
        if let Some(state) = self.client_state() {
            return state;
        }
        let (oracle, cfg) = (self.clone(), cfg.clone());
        tokio::task::spawn_blocking(move || oracle.init_client(&cfg))
            .await
            .unwrap_or_else(|_| Err("the Oracle client library could not be loaded: its loading stopped unexpectedly".into()))
    }

    /// Runs a registry row with the model's params.
    #[allow(clippy::too_many_arguments)]
    pub async fn run(
        self: &Arc<Self>,
        db: &Db,
        config: &Config,
        registry: &Row,
        params: &Map<String, Value>,
        chosen_db: Option<&str>,
        is_clipped_copy: &(dyn Fn(&str) -> bool + Sync),
        cancel: &CancellationToken,
    ) -> Result<Outcome> {
        let spec = execution_spec(
            &db::text(registry, "query_type"),
            &db::text(registry, "query_sql"),
            &db::text(registry, "bind_config"),
        )
        .map_err(|e| match e.downcast::<SafeError>() {
            Ok(mut s) => {
                s.wasted = true;
                s.hint.get_or_insert_with(|| UNRUNNABLE_HINT.into());
                anyhow::Error::from(s)
            }
            Err(e) => e,
        })?;
        let value = |name: &str| bind_value(params, name);
        let problems: Vec<String> = spec
            .inputs
            .iter()
            .filter_map(|n| bind_problem(value(n), is_clipped_copy).map(|p| format!("{n}: {p}")))
            .collect();
        if !problems.is_empty() {
            return Err(SafeError {
                message: format!("바인드 변수를 쓸 수 없습니다 — {}.", problems.join(", ")),
                hint: Some("질문이나 실행 이력에서 값을 확인하고, 알 수 없으면 사용자에게 되묻거나 다른 쿼리를 선택하라".into()),
                wasted: false,
            }
            .into());
        }
        // Routine NUMBER inputs must be decimal text within Oracle's range.
        for b in &spec.bindings {
            if b.dir != Dir::Out && b.kind == BindType::Number {
                let v = value(&b.name).cloned().unwrap_or(Value::Null);
                if !valid_number_input(&v) {
                    let text = match &v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    static DECIMAL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                        regex::Regex::new(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$").unwrap()
                    });
                    let shape_ok = DECIMAL.is_match(text.trim());
                    return Err(safe(if shape_ok && text.trim().parse::<f64>().is_ok_and(f64::is_finite) {
                        format!(":{}의 값이 Oracle NUMBER 범위(0 또는 절댓값 1e-130 이상 1e126 미만)를 벗어났습니다.", b.name)
                    } else {
                        format!(":{}에는 유효한 숫자를 입력해주세요. 큰 정수는 문자열로 전달해주세요.", b.name)
                    }));
                }
            }
        }
        let target = resolve_target_db(registry, chosen_db)?;
        let query_name = db::text(registry, "query_name");
        if config.oracle.mock {
            if spec.kind != Kind::Query {
                return Err(wasted(
                    "프로시저·함수는 Oracle mock 모드에서 실행할 수 없습니다. 실제 Oracle 연결을 사용해주세요.",
                    UNRUNNABLE_HINT,
                ));
            }
            let inputs: Map<String, Value> = spec
                .inputs
                .iter()
                .filter_map(|n| value(n).map(|v| (name_key(n), v.clone())))
                .collect();
            return Ok(cap(mock_rows(&query_name, &inputs)?, target));
        }
        // The management DB waits for its time limit alone; the statement's
        // own stop is below.
        let row = tokio::select! {
            biased;
            _ = cancel.cancelled() => bail!("cancelled"),
            row = db::load_target_db(db, &config.mariadb, &target) => row?,
        };
        let Some(row) = row else {
            eprintln!("[oracle] target_db row not found: {target} (registered for {query_name})");
            return Err(wasted("조회대상 DB 접속 정보가 등록되어 있지 않습니다.", UNRUNNABLE_HINT));
        };
        let db_type = db::text(&row, "db_type");
        if !db_type.is_empty() && name_key(&db_type) != "oracle" {
            return Err(wasted(
                format!("지원하지 않는 db_type: {db_type} (현재 oracle만 지원)"),
                UNRUNNABLE_HINT,
            ));
        }
        let empty: Vec<&str> = ["connection_info", "db_user", "db_password"]
            .into_iter()
            .filter(|c| db::text(&row, c).is_empty())
            .collect();
        if !empty.is_empty() {
            eprintln!("[oracle] target_db row for {target} has empty {}", empty.join(", "));
            return Err(wasted("조회대상 DB 접속 정보가 서버에 설정되어 있지 않습니다.", SETUP_HINT));
        }
        let password = resolve_password(&db::text(&row, "db_password"))?;
        if let Err(e) = self.load_client(&config.oracle).await {
            eprintln!("[oracle] the Oracle client library could not be loaded — install the Instant Client or set its folder in the settings: {e}");
            return Err(wasted(
                "조회대상 DB 드라이버를 초기화하지 못했습니다.",
                "조회는 지금 불가능하다 — 다른 쿼리로 재시도하지 말고 지금까지의 정보로 답변하라",
            ));
        }
        let pool = self.pool(&row, &password, &config.oracle)?;
        let timeout = Duration::from_millis(config.oracle.timeout_ms);
        let read_only = config.oracle.routine_read_only;
        let inputs: Vec<(String, Value)> = spec
            .inputs
            .iter()
            .map(|n| (n.clone(), value(n).cloned().unwrap_or(Value::Null)))
            .collect();
        let connection: Arc<Mutex<Option<Arc<oracle::Connection>>>> = Arc::new(Mutex::new(None));
        let slot = connection.clone();
        let stopped = cancel.clone();
        let work = tokio::task::spawn_blocking(move || -> Result<Vec<Map<String, Value>>> {
            let mut conn = pool.get()?;
            // First, so whatever the session sends from here has the limit:
            // dropped below or pooled, its logoff too (a pool closing waited
            // for good on the logoff of a session with none, its target
            // frozen).
            conn.set_call_timeout(Some(timeout))?;
            // A LOB cell's start comes with its row, all of a LOB that fits
            // a cell (`lob_start`): read as locators alone, each cell took a
            // round trip of its own (1,000 short CLOBs: 7 ms as values,
            // 200 ms so, on a local server; 10 ms with it). Its buffers count
            // in what the session keeps (`FETCH_ROWS`). Set on the session,
            // it holds for the cursors its routines open too; a client
            // without it only reads slower.
            let _ = conn.set_oci_attr::<oracle::oci_attr::DefaultLobPrefetchSize>(&LOB_PREFETCH_CHARS);
            let conn = Arc::new(conn);
            *slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(conn.clone());
            // Stopped while it waited for a session (all in use, a new one
            // being made), there was nothing to break: the statement then ran
            // to its end, up to the call timeout, the question waiting.
            // Checked once the session is in `slot`, a stop is seen here or
            // breaks the statement; a session it may have broken idle is
            // closed rather than pooled.
            if stopped.is_cancelled() {
                *slot.lock().unwrap_or_else(|p| p.into_inner()) = None;
                let _ = conn.close_with_mode(oracle::conn::CloseMode::Drop);
                bail!("cancelled");
            }
            if conn.is_new_connection()
                && let Err(e) = conn.execute(NLS_SESSION_FORMATS, &[])
            {
                eprintln!("[oracle] failed to fix the session date format — the DB default stays: {e}");
            }
            let result = execute(&conn, &spec, &inputs, read_only);
            // A routine that opened its REF CURSOR and then failed (raised,
            // was stopped, ran past the call timeout) never handed the
            // cursor over: the session keeps it open until it ends. Pooled,
            // a session gathered one per failure until its statements failed
            // with ORA-01000 (open_cursors, 300 by default), anyone's.
            let mut drop_connection =
                result.is_err() && spec.bindings.iter().any(|b| b.kind == BindType::Cursor);
            if !drop_connection && spec.kind != Kind::Query && conn.rollback().is_err() {
                drop_connection = true;
            }
            if !drop_connection && conn.execute(CLEAR_DBMS_OUTPUT, &[]).is_err() {
                drop_connection = true;
            }
            *slot.lock().unwrap_or_else(|p| p.into_inner()) = None;
            if drop_connection {
                let _ = conn.close_with_mode(oracle::conn::CloseMode::Drop);
            }
            result
        });
        let mut work = std::pin::pin!(work);
        let rows = tokio::select! {
            joined = &mut work => joined??,
            _ = cancel.cancelled() => {
                if let Some(conn) = connection.lock().unwrap_or_else(|p| p.into_inner()).clone() {
                    let _ = conn.break_execution();
                }
                let _ = work.await;
                bail!("cancelled");
            }
        };
        Ok(cap(rows, target))
    }

    fn pool(&self, row: &Row, password: &str, cfg: &OracleConfig) -> Result<Arc<oracle::pool::Pool>> {
        let name = name_key(&db::text(row, "db_name"));
        let connect = bounded_connect(
            &db::text(row, "connection_info"),
            cfg.timeout_ms.div_ceil(1000).max(1),
            oracle::Version::client().map_or(0, |v| v.major()),
        );
        let mut hash = Sha256::new();
        for part in [connect.clone(), db::text(row, "db_user"), password.to_owned()] {
            hash.update(part.len().to_le_bytes());
            hash.update(part.as_bytes());
        }
        let fingerprint = hex::encode(hash.finalize());
        let mut pools = self.pools.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = pools.get_mut(&name)
            && entry.fingerprint == fingerprint
        {
            entry.last_used = Instant::now();
            return Ok(entry.pool.clone());
        }
        let pool = oracle::pool::PoolBuilder::new(db::text(row, "db_user"), password, connect)
        .min_connections(0)
        .max_connections(POOL_MAX)
        .connection_increment(1)
        .ping_interval(Some(Duration::from_secs(60)))?
        .timeout(Duration::from_secs(300))?
        .get_mode(oracle::pool::GetMode::TimedWait(Duration::from_millis(cfg.timeout_ms)))
        .build()?;
        let pool = Arc::new(pool);
        let entry = PoolEntry {
            fingerprint,
            pool: pool.clone(),
            last_used: Instant::now(),
        };
        if let Some(old) = pools.insert(name, entry) {
            close_later(vec![old.pool]);
        }
        Ok(pool)
    }

    /// Closes the pools no run has used for `idle`. Closing frees their
    /// sessions on the target DB whatever the client library does with idle
    /// sessions, and drops the pools of renamed or deleted registrations,
    /// which nothing would use again.
    pub fn close_idle(&self, idle: Duration) -> usize {
        let now = Instant::now();
        let mut stale = vec![];
        self.pools
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|_, entry| {
                let keep = now.duration_since(entry.last_used) < idle;
                if !keep {
                    stale.push(entry.pool.clone());
                }
                keep
            });
        let closed = stale.len();
        if closed > 0 {
            close_later(stale);
        }
        closed
    }

    /// Pools currently kept (one per target registration in use).
    pub fn pool_count(&self) -> usize {
        self.pools.lock().map_or(0, |pools| pools.len())
    }
}

/// Closes pools on a thread of their own (closing waits on the network). A
/// pool a run still holds closes when the run lets go of it: the client
/// library destroys a pool when its last reference goes.
fn close_later(pools: Vec<Arc<oracle::pool::Pool>>) {
    std::thread::spawn(move || {
        for pool in pools {
            if let Ok(pool) = Arc::try_unwrap(pool) {
                let _ = pool.close(&oracle::pool::CloseMode::Default);
            }
        }
    });
}

/// `connect` with a limit of `secs` seconds on making a connection, where
/// its form takes one and does not set its own: a descriptor's
/// CONNECT_TIMEOUT, or an Easy Connect string's `connect_timeout` (Easy
/// Connect Plus, from client 19). The pool makes its sessions on a thread of
/// its own, and with no limit one whose listener took the connection and
/// said nothing (a hung listener or host, a firewall keeping the
/// connection) waited for good: a run gave up on its session at the query
/// limit, while the pool, waiting, made no other, and closing it waited too.
/// Each pool closed for its idle minutes kept a thread, the attempt's own
/// and its socket for as long as the server ran, and the target's next use
/// made a pool that did the same. A tnsnames alias is used as named (its
/// entry, or sqlnet.ora's SQLNET.OUTBOUND_CONNECT_TIMEOUT, sets the limit).
fn bounded_connect(connect: &str, secs: u64, client_major: i32) -> String {
    static DESCRIPTION: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\(\s*DESCRIPTION\s*=").unwrap());
    static OWN_LIMIT: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\(\s*CONNECT_TIMEOUT\s*=").unwrap());
    let connect = connect.trim();
    if connect.starts_with('(') {
        if OWN_LIMIT.is_match(connect) {
            return connect.to_owned();
        }
        return DESCRIPTION.replace_all(connect, format!("${{0}}(CONNECT_TIMEOUT={secs})")).into_owned();
    }
    let easy_connect = connect.contains(['/', ':']) && !connect.contains(char::is_whitespace);
    if !easy_connect || client_major < 19 {
        return connect.to_owned();
    }
    let Some((_, params)) = connect.split_once('?') else {
        return format!("{connect}?connect_timeout={secs}");
    };
    if params
        .split('&')
        .any(|param| param.split('=').next().is_some_and(|key| key.trim().eq_ignore_ascii_case("connect_timeout")))
    {
        return connect.to_owned();
    }
    let joint = if connect.ends_with(['?', '&']) { "" } else { "&" };
    format!("{connect}{joint}connect_timeout={secs}")
}

/// A bind value by exact key, then by Oracle's case-insensitive name.
fn bind_value<'a>(params: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    params.get(name).or_else(|| {
        let key = name_key(name);
        params
            .iter()
            .find(|(k, v)| !v.is_null() && name_key(k) == key)
            .map(|(_, v)| v)
    })
}

fn bind_problem(value: Option<&Value>, is_clipped_copy: &(dyn Fn(&str) -> bool + Sync)) -> Option<&'static str> {
    match value {
        None | Some(Value::Null) => Some("값 없음"),
        Some(Value::String(s)) if s.is_empty() => Some("값 없음"),
        Some(Value::Bool(_)) => Some("true/false는 바인드할 수 없음 — 컬럼에 저장된 값(예: 'Y'/'N', 1/0)으로 지정할 것"),
        Some(Value::Array(_) | Value::Object(_)) => Some("값이 아닌 구조"),
        Some(Value::String(s)) if s.ends_with(TRUNC_MARK) || is_clipped_copy(s) => {
            Some("잘린 값이라 원본과 다름")
        }
        _ => None,
    }
}

/// The registered target DB this run uses: the only candidate, or the one
/// the model chose by its registered spelling. Only a query with no
/// candidate cannot run; a target_db left out, too long or not among them is
/// corrected by sending another.
pub fn resolve_target_db(registry: &Row, chosen: Option<&str>) -> Result<String> {
    let names = target_db_names(&db::text(registry, "target_db_name"));
    let list = clip_utf16(&names.join(", "), MAX_DB_LIST_LEN).to_owned();
    if names.is_empty() {
        return Err(wasted("이 쿼리에는 조회대상 DB가 등록되어 있지 않습니다.", UNRUNNABLE_HINT));
    }
    if let Some(chosen) = chosen
        && crate::text::utf16_len(crate::text::js_trim(chosen)) > MAX_TARGET_DB_NAME_LEN
    {
        return Err(safe_hint(
            format!("조회대상 DB 이름이 너무 깁니다 (상한: {MAX_TARGET_DB_NAME_LEN}자, 후보: {list})."),
            "target_db는 후보 목록에 있는 이름이어야 한다 — 그중 하나를 골라 다시 실행하라",
        ));
    }
    let want = chosen.map(name_key).unwrap_or_default();
    if want.is_empty() {
        if names.len() == 1 {
            return Ok(names[0].clone());
        }
        return Err(safe_hint(
            format!("조회할 대상 DB를 고르지 않았습니다 (후보: {list})."),
            "target_db에 후보 중 하나를 등록된 철자 그대로 적어 같은 쿼리를 다시 실행하라",
        ));
    }
    names
        .iter()
        .find(|n| name_key(n) == want)
        .cloned()
        .ok_or_else(|| {
            safe_hint(
                format!(
                    "등록되지 않은 대상 DB입니다: {} (후보: {list}).",
                    clip_utf16(chosen.unwrap_or_default(), MAX_TARGET_DB_NAME_LEN)
                ),
                "target_db는 후보 목록에 있는 이름이어야 한다 — 그중 하나를 골라 다시 실행하라",
            )
        })
}

/// `ENV:NAME` reads the process environment (and `.env`, loaded at start);
/// anything else is the password itself.
fn resolve_password(stored: &str) -> Result<String> {
    match crate::text::password_env_reference(stored) {
        Some((name, true)) if crate::text::backend_secret(&name) => {
            eprintln!("[oracle] the target DB password refers to {name}, a secret of the backend itself — not sent; enter another variable");
            Err(wasted("조회대상 DB 접속 정보가 서버에 설정되어 있지 않습니다.", SETUP_HINT))
        }
        Some((name, true)) => match std::env::var(&name) {
            Ok(value) if !value.is_empty() => Ok(value),
            _ => {
                eprintln!("[oracle] target DB password env var is not set: {name}");
                Err(wasted("조회대상 DB 접속 정보가 서버에 설정되어 있지 않습니다.", SETUP_HINT))
            }
        },
        Some((_, false)) => {
            eprintln!("[oracle] target DB password env var reference is invalid");
            Err(wasted("조회대상 DB 접속 정보가 서버에 설정되어 있지 않습니다.", SETUP_HINT))
        }
        None => Ok(stored.to_owned()),
    }
}

/// A bindable value: strings as text, integers and other numbers as numbers.
enum BindArg {
    Text(String),
    Int(i64),
    Float(f64),
}
impl BindArg {
    fn of(v: &Value) -> Self {
        match v {
            // An integer past i64 (a 20-digit ID sent as a number) is bound
            // as its exact digits: as a double it was another number, and
            // `WHERE id = :id` matched nothing, without a word.
            Value::Number(n) => match (n.as_i64(), n.as_u64()) {
                (Some(i), _) => BindArg::Int(i),
                (None, Some(_)) => BindArg::Text(n.to_string()),
                _ => BindArg::Float(n.as_f64().unwrap_or(0.0)),
            },
            Value::String(s) => BindArg::Text(s.clone()),
            other => BindArg::Text(other.to_string()),
        }
    }
    fn sql(&self) -> &dyn oracle::sql_type::ToSql {
        match self {
            BindArg::Text(s) => s,
            BindArg::Int(i) => i,
            BindArg::Float(f) => f,
        }
    }
}

fn execute(
    conn: &oracle::Connection,
    spec: &crate::execution::Spec,
    inputs: &[(String, Value)],
    read_only: bool,
) -> Result<Vec<Map<String, Value>>> {
    if spec.kind != Kind::Query && read_only {
        conn.execute("SET TRANSACTION READ ONLY", &[])?;
    }
    conn.execute(PREPARE_DBMS_OUTPUT, &[])?;
    if spec.kind == Kind::Query {
        // Not kept in the session's statement cache: a cached query kept the
        // rows it prefetched, each registered query a session had run its
        // last result's size, twenty a session (1,000 rows of 4,000
        // characters: 4 MB a query, 78 MB a session, eight sessions a
        // target DB) for as long as the session was in use. Parsed again
        // on the server instead, in the same round trip (about 1 ms more,
        // local).
        let mut stmt = conn
            .statement(&spec.sql)
            .fetch_array_size(FETCH_ROWS)
            .prefetch_rows((MAX_ROWS + 2) as u32)
            .lob_locator()
            .exclude_from_cache()
            .build()?;
        let args: Vec<(String, BindArg)> = inputs
            .iter()
            .map(|(n, v)| (n.clone(), BindArg::of(v)))
            .collect();
        let named: Vec<(&str, &dyn oracle::sql_type::ToSql)> =
            args.iter().map(|(n, a)| (n.as_str(), a.sql())).collect();
        let rows = stmt.query_named(&named)?;
        return collect(rows);
    }
    // A REF CURSOR's rows are read as the statement's (`lob_locator`).
    let mut stmt = conn.statement(&spec.sql).lob_locator().build()?;
    let mut held: Vec<String> = vec![];
    for b in &spec.bindings {
        let input = (b.dir != Dir::Out).then(|| {
            inputs
                .iter()
                .find(|(n, _)| name_key(n) == name_key(&b.name))
                .map(|(_, v)| match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default()
        });
        match (b.kind, input) {
            (BindType::Cursor, _) => stmt.bind(b.name.as_str(), &OracleType::RefCursor)?,
            (_, Some(value)) if b.dir == Dir::In => {
                held.push(value);
                stmt.bind(b.name.as_str(), held.last().unwrap())?;
            }
            // NUMBER outputs bind as NUMBER (read back as exact decimal text):
            // a 32767-byte VARCHAR2 bind is LONG to the OCI client, and
            // PL/SQL refuses to assign a NUMBER to it (PLS-00382).
            (BindType::Number, Some(value)) => {
                stmt.bind(b.name.as_str(), &(&value, &OracleType::Number(0, 0)))?;
            }
            (BindType::Number, None) => stmt.bind(b.name.as_str(), &OracleType::Number(0, 0))?,
            (_, Some(value)) => {
                let size = b.max_size.unwrap_or(32767);
                stmt.bind(b.name.as_str(), &(&value, &OracleType::Varchar2(size)))?;
            }
            (_, None) => {
                let size = b.max_size.unwrap_or(32767);
                stmt.bind(b.name.as_str(), &OracleType::Varchar2(size))?;
            }
        }
    }
    stmt.execute(&[])?;
    let outputs: Vec<&crate::execution::Binding> =
        spec.bindings.iter().filter(|b| b.dir != Dir::In).collect();
    if let Some(cursor) = outputs.iter().find(|b| b.kind == BindType::Cursor) {
        let mut cursor: oracle::sql_type::RefCursor = stmt
            .bind_value(cursor.name.as_str())
            .map_err(|_| safe("루틴이 유효한 REF CURSOR를 반환하지 않았습니다. 빈 결과도 열린 커서로 반환해주세요."))?;
        let rows = cursor.query()?;
        return collect(rows);
    }
    let mut row = Map::new();
    for b in outputs {
        let value: Option<String> = stmt.bind_value(b.name.as_str())?;
        let value = match value {
            None => Value::Null,
            Some(text) if b.kind == BindType::Number => number_from_text(&text),
            Some(text) => json!(clip_marked(&text, MAX_CELL_LEN)),
        };
        row.insert(b.name.clone(), value);
    }
    Ok(vec![row])
}

fn collect(rows: oracle::ResultSet<'_, oracle::Row>) -> Result<Vec<Map<String, Value>>> {
    let names = distinct_names(rows.column_info().iter().map(|c| c.name().to_owned()).collect());
    let columns: Vec<(String, OracleType)> = names
        .into_iter()
        .zip(rows.column_info().iter().map(|c| c.oracle_type().clone()))
        .collect();
    let mut out = Vec::new();
    for row in rows {
        let row = row?;
        let mut map = Map::new();
        for (i, (name, ty)) in columns.iter().enumerate() {
            map.insert(name.clone(), cell(&row, i, ty));
        }
        out.push(map);
        if out.len() > MAX_ROWS {
            break;
        }
    }
    Ok(out)
}

/// Column names a row can hold side by side. Oracle names the columns of a
/// join `SELECT a.status, b.status` alike, and a row keyed by name kept the
/// last of them alone: the first one's values were gone, without a word. A
/// repeated name becomes `NAME_1`, `NAME_2`… (as node-oracledb named them),
/// past any name the result already has.
fn distinct_names(names: Vec<String>) -> Vec<String> {
    let taken: std::collections::HashSet<String> = names.iter().cloned().collect();
    let mut given: std::collections::HashSet<String> = std::collections::HashSet::new();
    names
        .into_iter()
        .map(|name| {
            if given.insert(name.clone()) {
                return name;
            }
            let renamed = (1..)
                .map(|n| format!("{name}_{n}"))
                .find(|candidate| !taken.contains(candidate) && !given.contains(candidate))
                .unwrap();
            given.insert(renamed.clone());
            renamed
        })
        .collect()
}

fn two(n: impl Into<i64>) -> String {
    format!("{:02}", n.into())
}

fn timestamp_text(ts: &oracle::sql_type::Timestamp, fraction: bool, offset: bool) -> String {
    // A year before 1 (Oracle's -4712 to -1) keeps four digits after its
    // sign: `{:04}` counts the sign, and -44 came out as "-044".
    let year = if ts.year() < 0 { format!("-{:04}", ts.year().unsigned_abs()) } else { format!("{:04}", ts.year()) };
    let mut text = format!(
        "{year}-{}-{} {}:{}:{}",
        two(ts.month()),
        two(ts.day()),
        two(ts.hour()),
        two(ts.minute()),
        two(ts.second())
    );
    if fraction {
        text.push_str(&format!(".{:03}", ts.nanosecond() / 1_000_000));
    }
    if offset {
        let minutes = ts.tz_offset() / 60;
        let sign = if minutes < 0 { '-' } else { '+' };
        let abs = minutes.abs();
        text.push_str(&format!(" {sign}{}:{}", two(abs / 60), two(abs % 60)));
    }
    text
}

fn cell(row: &oracle::Row, i: usize, ty: &OracleType) -> Value {
    let text = |row: &oracle::Row| -> Value {
        match row.get::<usize, Option<String>>(i) {
            Ok(Some(s)) => json!(clip_marked(&s, MAX_CELL_LEN)),
            Ok(None) => Value::Null,
            Err(e) => json!(format!("<{ty} 값 — 읽을 수 없음: {e}>")),
        }
    };
    match ty {
        OracleType::Number(precision, scale) if (1..=15).contains(precision) && *scale >= 0 => {
            match row.get::<usize, Option<f64>>(i) {
                Ok(Some(f)) => number_json(f),
                Ok(None) => Value::Null,
                Err(_) => text(row),
            }
        }
        OracleType::Number(..) | OracleType::Float(_) | OracleType::Int64 => {
            match row.get::<usize, Option<String>>(i) {
                Ok(Some(s)) => number_from_text(&s),
                Ok(None) => Value::Null,
                Err(_) => text(row),
            }
        }
        OracleType::BinaryFloat | OracleType::BinaryDouble => match row.get::<usize, Option<f64>>(i) {
            Ok(Some(f)) if f.is_finite() => number_json(f),
            Ok(Some(f)) => json!(f.to_string()),
            Ok(None) => Value::Null,
            Err(_) => text(row),
        },
        OracleType::Date | OracleType::Timestamp(_) | OracleType::TimestampTZ(_) | OracleType::TimestampLTZ(_) => {
            match row.get::<usize, Option<oracle::sql_type::Timestamp>>(i) {
                Ok(Some(ts)) => json!(timestamp_text(
                    &ts,
                    !matches!(ty, OracleType::Date),
                    matches!(ty, OracleType::TimestampTZ(_) | OracleType::TimestampLTZ(_))
                )),
                Ok(None) => Value::Null,
                Err(_) => text(row),
            }
        }
        OracleType::IntervalDS(..) => match row.get::<usize, Option<oracle::sql_type::IntervalDS>>(i) {
            Ok(Some(v)) => {
                let negative = v.days() < 0 || v.hours() < 0 || v.minutes() < 0 || v.seconds() < 0 || v.nanoseconds() < 0;
                let frac = if v.nanoseconds() != 0 {
                    format!(".{:09}", v.nanoseconds().abs()).trim_end_matches('0').to_owned()
                } else {
                    String::new()
                };
                json!(format!(
                    "{}{} {}:{}:{}{frac}",
                    if negative { "-" } else { "" },
                    v.days().abs(),
                    two(v.hours().abs()),
                    two(v.minutes().abs()),
                    two(v.seconds().abs())
                ))
            }
            Ok(None) => Value::Null,
            Err(_) => text(row),
        },
        OracleType::IntervalYM(_) => match row.get::<usize, Option<oracle::sql_type::IntervalYM>>(i) {
            Ok(Some(v)) => json!(format!(
                "{}{}-{}",
                if v.years() < 0 || v.months() < 0 { "-" } else { "" },
                v.years().abs(),
                v.months().abs()
            )),
            Ok(None) => Value::Null,
            Err(_) => text(row),
        },
        // LOB cells as locators (`lob_locator`): read up to the cell's
        // limit, a BLOB only measured. Fetched as values, a LOB was read
        // whole, the fetch's every row at once — 200 rows of a 1 MB CLOB
        // were 206 MiB, to keep 4,000 characters of each.
        OracleType::CLOB => match row.get::<usize, Option<oracle::sql_type::Clob>>(i) {
            Ok(Some(lob)) => lob_cell(lob_start(lob), ty),
            Ok(None) => Value::Null,
            Err(_) => text(row),
        },
        OracleType::NCLOB => match row.get::<usize, Option<oracle::sql_type::Nclob>>(i) {
            Ok(Some(lob)) => lob_cell(lob_start(lob), ty),
            Ok(None) => Value::Null,
            Err(_) => text(row),
        },
        OracleType::BLOB => match row.get::<usize, Option<oracle::sql_type::Blob>>(i) {
            Ok(Some(lob)) => match oracle::sql_type::Lob::size(&lob) {
                Ok(size) => json!(format!("<binary {size} bytes>")),
                Err(_) => json!("<binary>"),
            },
            Ok(None) => Value::Null,
            Err(_) => json!("<binary>"),
        },
        OracleType::Raw(_) | OracleType::LongRaw => {
            match row.get::<usize, Option<Vec<u8>>>(i) {
                Ok(Some(bytes)) => json!(format!("<binary {} bytes>", bytes.len())),
                Ok(None) => Value::Null,
                Err(_) => json!("<binary>"),
            }
        }
        OracleType::BFILE | OracleType::Object(_) => json!(format!("<{ty} 값 — 지원하지 않는 컬럼 타입>")),
        _ => text(row),
    }
}

/// Rows a fetch takes. All of a result's come in its first round trip
/// (`prefetch_rows`) unless it has LOB columns, which are fetched a fetch's
/// rows at a time — and the session keeps buffers for each LOB column as
/// large as a fetch's rows take (about 18 KiB a row with its prefetched
/// start), until it closes idle: 1,001 rows a fetch were 16 MiB a column
/// for even a one-row result (11 CLOB columns: 87 MiB), times each pooled
/// session. A thousand rows of a LOB, beyond what a result shows the model
/// anyway, so take nine more round trips.
const FETCH_ROWS: u32 = 100;

/// Characters of each LOB cell sent with its row: more than a cell keeps.
const LOB_PREFETCH_CHARS: u32 = MAX_CELL_LEN as u32 + 1;

/// A CLOB's first MAX_CELL_LEN characters, marked cut by its length: both
/// come with the row (`LOB_PREFETCH_CHARS`), so a cell takes no round trip.
/// A read stops at what came with the row, one less where that cuts a
/// surrogate pair, and Oracle refuses a read that ends inside one
/// (ORA-22831): the one past it reads on only a start that falls short of
/// the cell. An empty LOB is null, as it was read as a value.
fn lob_start<L: std::io::Read + oracle::sql_type::Lob>(mut lob: L) -> Result<Option<String>> {
    // UTF-16 units, as Oracle counts a CLOB's characters.
    let size = usize::try_from(lob.size()?).unwrap_or(usize::MAX);
    if size == 0 {
        return Ok(None);
    }
    let wanted = size.min(MAX_CELL_LEN);
    let mut text = String::new();
    let mut buffer = vec![0u8; (MAX_CELL_LEN + 1) * 4];
    while utf16_len(&text) < wanted {
        let read = lob.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        text.push_str(std::str::from_utf8(&buffer[..read])?);
    }
    Ok(Some(if size > MAX_CELL_LEN || utf16_len(&text) > MAX_CELL_LEN {
        format!("{}{TRUNC_MARK}", clip_utf16(&text, MAX_CELL_LEN))
    } else {
        text
    }))
}

fn lob_cell(start: Result<Option<String>>, ty: &OracleType) -> Value {
    match start {
        Ok(Some(text)) => json!(text),
        Ok(None) => Value::Null,
        Err(e) => json!(format!("<{ty} 값 — 읽을 수 없음: {e}>")),
    }
}

/// At most MAX_ROWS rows (`capped` tells more existed) and MAX_RESULT_COLS
/// columns, the cut columns named in a note column.
fn cap(mut rows: Vec<Map<String, Value>>, target_db: String) -> Outcome {
    let capped = rows.len() > MAX_ROWS;
    rows.truncate(MAX_ROWS);
    let mut omitted_column_key = None;
    let rows = rows
        .into_iter()
        .map(|row| {
            if row.len() <= MAX_RESULT_COLS {
                return row;
            }
            let total = row.len();
            let mut key = "…".to_owned();
            while row.contains_key(&key) {
                key.push('…');
            }
            let mut kept: Map<String, Value> = row.into_iter().take(MAX_RESULT_COLS).collect();
            kept.insert(
                key.clone(),
                json!(format!("외 {}개 컬럼 생략 (컬럼 수 상한 {MAX_RESULT_COLS}개)", total - MAX_RESULT_COLS)),
            );
            omitted_column_key = Some(key);
            kept
        })
        .collect();
    Outcome {
        rows,
        capped,
        target_db,
        omitted_column_key,
    }
}

/// The demo rows of `seed-space.sql`'s queries, for running without Oracle.
fn mock_rows(query_name: &str, params: &Map<String, Value>) -> Result<Vec<Map<String, Value>>> {
    let s = |k: &str| params.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let row = |pairs: &[(&str, Value)]| -> Map<String, Value> {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect()
    };
    let jobs = [
        ("BATCH001", "일별 정산 배치", "FAILED", "2026-08-28 01:00"),
        ("BATCH002", "주문 집계 배치", "SUCCESS", "2026-08-29 02:10"),
        ("BATCH003", "고객 등급 산정", "RUNNING", "2026-08-29 03:00"),
    ];
    let customers = [
        ("C-1001", "홍길동", "VIP"),
        ("C-1002", "김철수", "GOLD"),
        ("C-1003", "이영희", "SILVER"),
    ];
    let orders = [
        ("O-777", "C-1001", "배송중", "2026-08-27", 128000),
        ("O-778", "C-1001", "결제완료", "2026-08-25", 45000),
        ("O-779", "C-1001", "배송완료", "2026-08-20", 233000),
        ("O-801", "C-1002", "배송완료", "2026-08-26", 71000),
        ("O-802", "C-1003", "주문접수", "2026-08-29", 19900),
    ];
    Ok(match name_key(query_name).as_str() {
        "batch_job_status" => jobs
            .iter()
            .filter(|j| j.0 == s("job_id"))
            .map(|j| row(&[("JOB_ID", json!(j.0)), ("JOB_NAME", json!(j.1)), ("STATUS", json!(j.2)), ("LAST_RUN_AT", json!(j.3))]))
            .collect(),
        "batch_list_by_status" => {
            let mut list: Vec<_> = jobs.iter().filter(|j| j.2 == s("status")).collect();
            list.sort_by(|a, b| b.3.cmp(a.3));
            list.iter()
                .map(|j| row(&[("JOB_ID", json!(j.0)), ("JOB_NAME", json!(j.1)), ("LAST_RUN_AT", json!(j.3))]))
                .collect()
        }
        "find_customer_id" => customers
            .iter()
            .filter(|c| c.1 == s("customer_name"))
            .map(|c| row(&[("CUSTOMER_ID", json!(c.0)), ("CUSTOMER_NAME", json!(c.1)), ("GRADE", json!(c.2))]))
            .collect(),
        "order_status_by_customer" => {
            let mut list: Vec<_> = orders.iter().filter(|o| o.1 == s("customer_id")).collect();
            list.sort_by(|a, b| b.3.cmp(a.3));
            list.iter()
                .take(5)
                .map(|o| row(&[("ORDER_ID", json!(o.0)), ("STATUS", json!(o.2)), ("ORDER_DATE", json!(o.3)), ("AMOUNT", json!(o.4))]))
                .collect()
        }
        "today_date" => {
            let now = chrono::Utc::now() + chrono::Duration::hours(9);
            vec![row(&[
                ("TODAY", json!(now.format("%Y-%m-%d").to_string())),
                ("NOW_TIME", json!(now.format("%H:%M:%S").to_string())),
            ])]
        }
        _ => return Err(safe(format!("mock 데이터가 정의되지 않은 쿼리: {query_name}"))),
    })
}

/// A user-facing message of a failed run: our own wording, or a generic
/// line instead of driver text (which names hosts, schemas and SQL).
pub fn public_error(error: &anyhow::Error) -> (String, Option<String>, bool) {
    match error.downcast_ref::<SafeError>() {
        Some(s) => (s.message.clone(), s.hint.clone(), s.wasted),
        None => ("조회 중 오류가 발생했습니다.".into(), None, false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row written before the admin screen refused it (or by hand) is not
    /// resolved either: the backend's own password stays home.
    #[test]
    fn a_target_password_naming_the_backends_own_secret_is_not_read() {
        let refused = resolve_password("ENV:MARIADB_PASSWORD").unwrap_err();
        let (_, _, wasted) = public_error(&refused);
        assert!(wasted, "{refused}");
        assert!(resolve_password("ENV:Llm_Api_Key").is_err());
        assert_eq!(resolve_password("plain").unwrap(), "plain");
    }

    /// Full review, 2026-10-22 (second session): a query and the settings
    /// screen's check loaded the client library on the runtime's thread.
    /// Loaded once, its state answers without a thread.
    #[tokio::test(flavor = "current_thread")]
    async fn a_loaded_client_state_answers_without_loading_again() {
        let oracle = Arc::new(Oracle::default());
        oracle.client.set(Err("no client".into())).unwrap();
        let cfg = OracleConfig { client_lib_dir: "/nonexistent/instantclient".into(), ..OracleConfig::default() };
        assert_eq!(oracle.load_client(&cfg).await, Err("no client".into()));
        let loaded = Arc::new(Oracle::default());
        loaded.client.set(Ok("23.0.0.0.0".into())).unwrap();
        assert_eq!(loaded.load_client(&cfg).await, Ok("23.0.0.0.0".into()));
    }

    fn registry(targets: &str) -> Row {
        let mut r = Map::new();
        r.insert("query_name".into(), json!("q"));
        r.insert("target_db_name".into(), json!(targets));
        r
    }

    #[test]
    fn target_db_is_chosen_from_the_registered_candidates() {
        assert_eq!(resolve_target_db(&registry("A"), None).unwrap(), "A");
        assert_eq!(resolve_target_db(&registry("A;B"), Some(" b ")).unwrap(), "B");
        let e = resolve_target_db(&registry("A;B"), None).unwrap_err();
        assert!(e.to_string().contains("후보: A, B"));
        // Another target_db runs it: not a query that cannot run.
        assert!(!e.downcast_ref::<SafeError>().unwrap().wasted);
        let e = resolve_target_db(&registry("A;B"), Some("C")).unwrap_err();
        assert!(!e.downcast_ref::<SafeError>().unwrap().wasted);
        let e = resolve_target_db(&registry(""), None).unwrap_err();
        assert!(e.downcast_ref::<SafeError>().unwrap().wasted);
    }

    #[test]
    fn bind_problems_are_named() {
        let never = |_: &str| false;
        assert_eq!(bind_problem(None, &never), Some("값 없음"));
        assert_eq!(bind_problem(Some(&json!("")), &never), Some("값 없음"));
        assert!(bind_problem(Some(&json!(true)), &never).unwrap().contains("true/false"));
        assert_eq!(bind_problem(Some(&json!({"a":1})), &never), Some("값이 아닌 구조"));
        assert_eq!(bind_problem(Some(&json!(format!("ab{TRUNC_MARK}"))), &never), Some("잘린 값이라 원본과 다름"));
        assert_eq!(bind_problem(Some(&json!("BATCH001")), &never), None);
        let mut params = Map::new();
        params.insert("JOB_ID".into(), json!("x"));
        assert_eq!(bind_value(&params, "job_id"), Some(&json!("x")));
    }

    /// Tool review, 2026-10-22 (sixth pass): an integer past i64 was bound as
    /// a double (12345678901234567890 as 1.2345678901234567e19).
    #[test]
    fn integers_past_i64_bind_as_their_digits() {
        let bound = |v: Value| match BindArg::of(&v) {
            BindArg::Text(t) => format!("text {t}"),
            BindArg::Int(i) => format!("int {i}"),
            BindArg::Float(f) => format!("float {f}"),
        };
        assert_eq!(bound(json!(12345678901234567890u64)), "text 12345678901234567890");
        assert_eq!(bound(json!(-9)), "int -9");
        assert_eq!(bound(json!(9_007_199_254_740_993i64)), "int 9007199254740993");
        assert_eq!(bound(json!(0.5)), "float 0.5");
        assert_eq!(bound(json!("C-1")), "text C-1");
    }

    /// Tool review, 2026-10-22 (sixth pass): a year before 1 lost a digit to
    /// its sign ("-044-03-15").
    #[test]
    fn timestamps_keep_four_year_digits_and_their_offset() {
        use oracle::sql_type::Timestamp;
        let bc = Timestamp::new(-44, 3, 15, 0, 0, 0, 0).unwrap();
        assert_eq!(timestamp_text(&bc, false, false), "-0044-03-15 00:00:00");
        let old = Timestamp::new(99, 1, 2, 3, 4, 5, 123_456_789).unwrap();
        assert_eq!(timestamp_text(&old, true, false), "0099-01-02 03:04:05.123");
        let zoned = Timestamp::new(2026, 1, 2, 3, 4, 5, 0).unwrap().and_tz_hm_offset(-5, -30).unwrap();
        assert_eq!(timestamp_text(&zoned, true, true), "2026-01-02 03:04:05.000 -05:30");
    }

    #[test]
    fn repeated_column_names_keep_every_column() {
        let names = |list: &[&str]| distinct_names(list.iter().map(|s| (*s).to_owned()).collect());
        assert_eq!(names(&["X", "X", "Y"]), ["X", "X_1", "Y"]);
        assert_eq!(names(&["X", "X", "X_1"]), ["X", "X_2", "X_1"]);
        assert_eq!(names(&["X", "X_1", "X", "X"]), ["X", "X_1", "X_2", "X_3"]);
        assert_eq!(names(&["A", "B"]), ["A", "B"]);
    }

    #[test]
    fn wide_and_long_results_are_capped() {
        let wide: Map<String, Value> = (0..35).map(|i| (format!("C{i}"), json!(i))).collect();
        let out = cap(vec![wide; 1001], "A".into());
        assert!(out.capped);
        assert_eq!(out.rows.len(), MAX_ROWS);
        assert_eq!(out.rows[0].len(), MAX_RESULT_COLS + 1);
        assert_eq!(out.omitted_column_key.as_deref(), Some("…"));
    }

    #[test]
    fn connections_are_made_within_a_limit_where_the_form_takes_one() {
        assert_eq!(bounded_connect(" db:1521/SVC ", 30, 23), "db:1521/SVC?connect_timeout=30");
        assert_eq!(bounded_connect("tcps://db:2484/SVC?wallet_location=/w", 5, 19), "tcps://db:2484/SVC?wallet_location=/w&connect_timeout=5");
        assert_eq!(bounded_connect("db/SVC?", 5, 19), "db/SVC?connect_timeout=5");
        assert_eq!(bounded_connect("db/SVC?Connect_Timeout=90", 5, 23), "db/SVC?Connect_Timeout=90", "its own limit stays");
        assert_eq!(bounded_connect("db/SVC?transport_connect_timeout=3", 5, 23), "db/SVC?transport_connect_timeout=3&connect_timeout=5");
        // Easy Connect Plus is a 19c client's; an alias is the tnsnames entry's.
        assert_eq!(bounded_connect("db:1521/SVC", 30, 18), "db:1521/SVC");
        assert_eq!(bounded_connect("ORDER_DB", 30, 23), "ORDER_DB");
        assert_eq!(bounded_connect("orcl.world", 30, 23), "orcl.world");
        let descriptor = "(DESCRIPTION = (ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=SVC)))";
        assert_eq!(
            bounded_connect(descriptor, 30, 11),
            "(DESCRIPTION =(CONNECT_TIMEOUT=30) (ADDRESS=(PROTOCOL=TCP)(HOST=db)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=SVC)))"
        );
        let list = "(DESCRIPTION_LIST=(description=(ADDRESS=(HOST=a)))(DESCRIPTION=(ADDRESS=(HOST=b))))";
        assert_eq!(
            bounded_connect(list, 7, 23),
            "(DESCRIPTION_LIST=(description=(CONNECT_TIMEOUT=7)(ADDRESS=(HOST=a)))(DESCRIPTION=(CONNECT_TIMEOUT=7)(ADDRESS=(HOST=b))))"
        );
        let own = "(DESCRIPTION=(TRANSPORT_CONNECT_TIMEOUT=3)( connect_timeout = 9)(ADDRESS=(HOST=a)))";
        assert_eq!(bounded_connect(own, 7, 23), own);
    }

    #[test]
    fn mock_rows_answer_the_demo_queries() {
        let mut p = Map::new();
        p.insert("job_id".into(), json!("BATCH001"));
        let rows = mock_rows("batch_job_status", &p).unwrap();
        assert_eq!(rows[0]["STATUS"], "FAILED");
        assert!(mock_rows("unknown", &p).is_err());
    }
}
