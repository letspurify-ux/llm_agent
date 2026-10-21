//! The management MariaDB: knowledge, Q&A methods, the query registry,
//! target DB registrations, vectors and the chat log. A new pool is made
//! when the connection settings change in the settings screen.

use crate::config::MariaDbConfig;
use anyhow::{Result, bail};
use mysql_async::{Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, prelude::Queryable};
use serde_json::{Map, Value, json};
use std::{collections::VecDeque, sync::Mutex, time::Duration};

pub type Row = Map<String, Value>;
pub type Param = mysql_async::Value;

/// A parameter from a string.
pub fn p(value: impl Into<String>) -> Param {
    Param::Bytes(value.into().into_bytes())
}
/// A parameter from an integer.
pub fn n(value: i64) -> Param {
    Param::Int(value)
}

#[derive(Default)]
pub struct Db {
    /// Pools by the settings they connect with, the last used last.
    pools: Mutex<VecDeque<(String, Pool)>>,
}

/// Pools kept for settings no longer the latest. A settings change made a
/// new pool and disconnected the one before at once, which fails every
/// connection still being taken from it ("Pool was disconnected"): the tool
/// calls and chat log of questions under way, an admin save. A question goes
/// on with the settings it started with, so it made the old pool again,
/// ending the new one in turn. A pool left out here closes once the queries
/// using it are done; one kept closes its idle connections as any pool does.
const POOLS_KEPT: usize = 4;

/// How long a connection back in the pool waits idle for the next query
/// before it is closed (checked every 30 s), down to none: an idle server
/// holds no connection. With no idle time the pool kept none at all, and
/// every query opened, logged in to and closed a connection of its own —
/// about four round trips more per query, and a closed socket left in
/// TIME_WAIT each time. A connection back in the pool is reset first
/// (COM_RESET_CONNECTION: session variables, locks, an open transaction;
/// the character set goes back to the login's, which MariaDB maps to the
/// collation SET NAMES gives), so it is taken again as a new one.
const IDLE_CONNECTION_TTL: Duration = Duration::from_secs(60);

/// The largest row or parameter a connection may have carried and still go
/// back to the pool. The driver reads a row, and sends a statement with its
/// parameters, in buffers of the connection's own that grow to the largest
/// it has carried and stay that size as long as the connection lives: a
/// knowledge document of 10 MB read, or saved, left 10 to 20 MB on each
/// connection that did, for as long as the pool used it (8 connections:
/// 172 MB, measured). Past this, the connection is closed when let go.
const LARGE_PACKET: usize = 1024 * 1024;

/// The largest buffer the driver keeps for later in its process-wide pool
/// (`MYSQL_ASYNC_BUFFER_SIZE_CAP`). It kept 128 of up to 4 MiB each for good:
/// a larger buffer, used once for a large row, came back cut to 4 MiB and
/// stayed — 512 MiB at most, 44 MB after 8 connections read 10 MB rows.
/// Rows past this take a buffer of their own, freed when read.
const DRIVER_BUFFER_CAP: usize = 256 * 1024;

/// Sets the driver's buffer cap (`DRIVER_BUFFER_CAP`), unless the
/// environment gives one. The driver reads it once, when it first connects,
/// so this goes first, while the process has a single thread.
pub fn cap_driver_buffers() {
    if std::env::var_os("MYSQL_ASYNC_BUFFER_SIZE_CAP").is_none() {
        // SAFETY: called at the start of main, before any other thread runs
        // (nothing else reads or writes the environment meanwhile).
        unsafe { std::env::set_var("MYSQL_ASYNC_BUFFER_SIZE_CAP", DRIVER_BUFFER_CAP.to_string()) };
    }
}

/// A connection, pooled or of its own, that knows the largest row or
/// parameter it has carried (`LARGE_PACKET`): past it, the connection is
/// closed when let go (politely, on a task of its own) rather than pooled.
pub struct Conn {
    inner: Option<mysql_async::Conn>,
    largest: usize,
    timeout: Duration,
}

impl Conn {
    fn new(inner: mysql_async::Conn, cfg: &MariaDbConfig) -> Self {
        Self {
            inner: Some(inner),
            largest: 0,
            timeout: Duration::from_millis(cfg.timeout_ms),
        }
    }

    fn carried(&mut self, bytes: usize) {
        self.largest = self.largest.max(bytes);
    }

    fn inner(&mut self) -> &mut mysql_async::Conn {
        self.inner.as_mut().expect("a connection being used is held")
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        if self.largest <= LARGE_PACKET {
            return;
        }
        let (Some(conn), Ok(runtime)) = (self.inner.take(), tokio::runtime::Handle::try_current()) else {
            return;
        };
        let timeout = self.timeout;
        runtime.spawn(async move {
            let _ = tokio::time::timeout(timeout, conn.disconnect()).await;
        });
    }
}

/// MariaDB error codes the admin API reports with their own status.
pub const ER_DUP_ENTRY: u16 = 1062;
pub const ER_DBACCESS_DENIED: u16 = 1044;
pub const ER_ACCESS_DENIED: u16 = 1045;
pub const ER_TABLEACCESS_DENIED: u16 = 1142;

/// The server error code of a failed operation, if it was one.
pub fn server_code(error: &anyhow::Error) -> Option<u16> {
    match error.downcast_ref::<mysql_async::Error>() {
        Some(mysql_async::Error::Server(e)) => Some(e.code),
        _ => None,
    }
}

/// A write the table refuses whatever the row: the account may not (a
/// missing grant; REPLACE takes DELETE too), or the server or table is read
/// only, or full. Tried row by row, each is refused the same way.
pub fn refuses_writes(error: &anyhow::Error) -> bool {
    // ER_DISK_FULL, ER_OPEN_AS_READONLY, ER_RECORD_FILE_FULL, table and
    // column access denied, ER_SPECIFIC_ACCESS_DENIED, ER_OPTION_PREVENTS_STATEMENT
    // (read_only), ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION, ER_INNODB_READ_ONLY.
    matches!(server_code(error), Some(1021 | 1036 | 1114 | 1142 | 1143 | 1227 | 1290 | 1792 | 1874))
}

impl Db {
    fn pool(&self, cfg: &MariaDbConfig) -> Result<Pool> {
        let fingerprint = cfg.fingerprint();
        let mut pools = self.pools.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(at) = pools.iter().position(|(known, _)| *known == fingerprint) {
            let entry = pools.remove(at).unwrap();
            let pool = entry.1.clone();
            pools.push_back(entry);
            return Ok(pool);
        }
        let constraints = PoolConstraints::new(0, cfg.pool_size.max(1))
            .ok_or_else(|| anyhow::anyhow!("invalid pool size"))?;
        let opts = options(cfg).pool_opts(
            PoolOpts::default()
                .with_constraints(constraints)
                .with_inactive_connection_ttl(IDLE_CONNECTION_TTL),
        );
        let pool = Pool::new(Opts::from(opts));
        pools.push_back((fingerprint, pool.clone()));
        if pools.len() > POOLS_KEPT {
            pools.pop_front();
        }
        Ok(pool)
    }

    /// A connection of its own, for a transaction or a session lock.
    pub async fn conn(&self, cfg: &MariaDbConfig) -> Result<Conn> {
        let pool = self.pool(cfg)?;
        let conn = timed(cfg, async move { Ok(pool.get_conn().await?) }).await?;
        Ok(Conn::new(conn, cfg))
    }

    /// A connection outside the pool, for a session lock held while the
    /// pool's connections do the work. Taken from the pool, the lock's
    /// connection waited for a second one, which a pool of one never freed:
    /// every embedding sync failed after twice the DB timeout, every other
    /// use of the DB waiting meanwhile. Closed with `close_conn`.
    pub async fn lock_conn(&self, cfg: &MariaDbConfig) -> Result<Conn> {
        let opts = Opts::from(options(cfg));
        let conn = timed(cfg, async move { Ok(mysql_async::Conn::new(opts).await?) }).await?;
        Ok(Conn::new(conn, cfg))
    }

    /// Closes a connection of its own (`lock_conn`) as the protocol has it,
    /// within the DB time limit. Dropped instead, it was cut without a word
    /// (mysql_async marks it closed before it says so), which the server
    /// counts and logs as an aborted connection — at every embedding sync,
    /// once a minute by default, into a log nothing trims.
    pub async fn close_conn(&self, cfg: &MariaDbConfig, mut conn: Conn) {
        if let Some(conn) = conn.inner.take() {
            let _ = timed(cfg, async { Ok(conn.disconnect().await?) }).await;
        }
    }

    pub async fn query(&self, cfg: &MariaDbConfig, sql: &str, params: Vec<Param>) -> Result<Vec<Row>> {
        self.query_with(cfg, "", sql, params).await
    }

    /// `query` with more session settings for this statement alone
    /// (`name=value, …`), sent with it: no round trip of their own, and no
    /// connection kept for them.
    pub async fn query_with(&self, cfg: &MariaDbConfig, settings: &str, sql: &str, params: Vec<Param>) -> Result<Vec<Row>> {
        let statement = limited(cfg, settings, sql);
        to_the_end(self.pool(cfg)?, cfg.clone(), async move |cfg, mut conn| {
            rows(&cfg, &mut conn, &statement, params).await
        })
        .await
    }

    /// Runs a statement; returns (affected rows, last insert id).
    pub async fn exec(&self, cfg: &MariaDbConfig, sql: &str, params: Vec<Param>) -> Result<(u64, u64)> {
        let statement = limited(cfg, "", sql);
        to_the_end(self.pool(cfg)?, cfg.clone(), async move |cfg, mut conn| {
            affected(&cfg, &mut conn, &statement, params).await
        })
        .await
    }

    pub async fn close(&self) {
        let pools = std::mem::take(&mut *self.pools.lock().unwrap_or_else(|p| p.into_inner()));
        futures_util::future::join_all(pools.into_iter().map(|(_, pool)| pool.disconnect())).await;
    }
}

/// How the management DB is reached, by the pool or by a connection of its
/// own.
fn options(cfg: &MariaDbConfig) -> OptsBuilder {
    OptsBuilder::default()
        .ip_or_hostname(cfg.host.clone())
        .tcp_port(cfg.port)
        .user((!cfg.user.is_empty()).then(|| cfg.user.clone()))
        .pass(cfg.password.as_ref().map(|s| s.0.clone()))
        .db_name(Some(cfg.database.clone()))
        .prefer_socket(false)
        .init(vec!["SET NAMES utf8mb4"])
}

/// A pooled connection and `work` on it, on a task of their own. A caller
/// that stops waiting (a stopped question, a closed request) is answered
/// at once, as before, while the statement under way finishes — within the
/// DB time limit, on the server too (`limited`) — and its connection goes
/// back to the pool. Dropped with the caller, it was cut mid-statement or
/// mid-login: the server ran the statement on anyway, the pool opened a new
/// connection for the next query, and the server logged an aborted
/// connection each time (223 stopped questions: 187 connections, 191
/// aborted, against 5 and none for as many answered). Given up before a
/// connection came, nothing runs. A connection that carried a large row or
/// parameter is closed then (`LARGE_PACKET`).
async fn to_the_end<T, F>(pool: Pool, cfg: MariaDbConfig, work: impl FnOnce(MariaDbConfig, Conn) -> F + Send + 'static) -> Result<T>
where
    T: Send + 'static,
    F: std::future::Future<Output = Result<T>> + Send,
{
    let (answer, answered) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let conn = match timed(&cfg, async { Ok(pool.get_conn().await?) }).await {
            Ok(conn) => Conn::new(conn, &cfg),
            Err(e) => {
                let _ = answer.send(Err(e));
                return;
            }
        };
        if !answer.is_closed() {
            let _ = answer.send(work(cfg, conn).await);
        }
    });
    answered
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("database_task_ended: the management DB query stopped unexpectedly")))
}

async fn timed<T>(cfg: &MariaDbConfig, work: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    match tokio::time::timeout(Duration::from_millis(cfg.timeout_ms), work).await {
        Ok(result) => result,
        Err(_) => bail!("database_timeout: the management DB did not answer within {} ms", cfg.timeout_ms),
    }
}

fn params(values: Vec<Param>) -> mysql_async::Params {
    if values.is_empty() {
        mysql_async::Params::Empty
    } else {
        mysql_async::Params::Positional(values)
    }
}

/// Longest `max_statement_time` the server takes (a year, in seconds).
const MAX_STATEMENT_SECS: f64 = 31_536_000.0;

/// `sql` under the DB time limit on the server too. A statement its caller
/// gave up on (past the limit, or dropped with a stopped question or a
/// closed request) had its connection closed, but MariaDB notices that only
/// when it sends the result, and ran it on to its end — a search over a
/// large table for its whole length, holding a server thread, a connection
/// and CPU, each retry after a time limit adding one more (still running
/// 16 s after a 1 s limit, measured). It now ends at the limit: an error,
/// not a part of its rows. The caller's limit counts from before the
/// statement is sent, so it still comes first; the prefix costs no round
/// trip.
/// `settings` are more `name=value` settings for the statement alone.
fn limited(cfg: &MariaDbConfig, settings: &str, sql: &str) -> String {
    let secs = (cfg.timeout_ms as f64 / 1000.0).min(MAX_STATEMENT_SECS);
    let more = if settings.is_empty() { String::new() } else { format!(", {settings}") };
    format!("SET STATEMENT max_statement_time={secs}{more} FOR {sql}")
}

/// Bytes a value takes on the wire, about.
fn value_bytes(value: &mysql_async::Value) -> usize {
    match value {
        mysql_async::Value::Bytes(bytes) => bytes.len(),
        _ => 16,
    }
}

async fn rows(cfg: &MariaDbConfig, conn: &mut Conn, statement: &str, values: Vec<Param>) -> Result<Vec<Row>> {
    conn.carried(statement.len() + values.iter().map(value_bytes).sum::<usize>());
    let link = conn.inner();
    let rows: Vec<mysql_async::Row> = timed(cfg, async { Ok(link.exec(statement, params(values)).await?) }).await?;
    let largest = rows
        .iter()
        .map(|row| (0..row.len()).filter_map(|i| row.as_ref(i)).map(value_bytes).sum::<usize>())
        .max()
        .unwrap_or(0);
    conn.carried(largest);
    Ok(rows.into_iter().map(row_json).collect())
}

async fn affected(cfg: &MariaDbConfig, conn: &mut Conn, statement: &str, values: Vec<Param>) -> Result<(u64, u64)> {
    conn.carried(statement.len() + values.iter().map(value_bytes).sum::<usize>());
    let link = conn.inner();
    timed(cfg, async {
        link.exec_drop(statement, params(values)).await?;
        Ok((link.affected_rows(), link.last_insert_id().unwrap_or(0)))
    })
    .await
}

pub async fn query_on(cfg: &MariaDbConfig, conn: &mut Conn, sql: &str, values: Vec<Param>) -> Result<Vec<Row>> {
    rows(cfg, conn, &limited(cfg, "", sql), values).await
}

pub async fn exec_on(cfg: &MariaDbConfig, conn: &mut Conn, sql: &str, values: Vec<Param>) -> Result<(u64, u64)> {
    affected(cfg, conn, &limited(cfg, "", sql), values).await
}

/// A text-protocol statement without parameters (SET, transactions).
pub async fn plain_on(cfg: &MariaDbConfig, conn: &mut Conn, sql: &str) -> Result<()> {
    conn.carried(sql.len());
    let link = conn.inner();
    timed(cfg, async {
        link.query_drop(sql).await?;
        Ok(())
    })
    .await
}

fn row_json(row: mysql_async::Row) -> Row {
    let names: Vec<String> = row
        .columns_ref()
        .iter()
        .map(|c| c.name_str().into_owned())
        .collect();
    let values = row.unwrap();
    names
        .into_iter()
        .zip(values)
        .map(|(name, value)| (name, value_json(value)))
        .collect()
}

pub fn value_json(value: mysql_async::Value) -> Value {
    use mysql_async::Value as V;
    match value {
        V::NULL => Value::Null,
        V::Bytes(bytes) => Value::String(String::from_utf8_lossy(&bytes).into_owned()),
        V::Int(i) => json!(i),
        V::UInt(u) => json!(u),
        V::Float(f) => json!(f),
        V::Double(d) => json!(d),
        V::Date(y, mo, d, h, mi, s, us) => {
            let base = format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}");
            json!(if us > 0 { format!("{base}.{us:06}") } else { base })
        }
        V::Time(neg, days, h, mi, s, us) => {
            let hours = days * 24 + u32::from(h);
            let sign = if neg { "-" } else { "" };
            json!(format!("{sign}{hours:02}:{mi:02}:{s:02}{}", if us > 0 { format!(".{us:06}") } else { String::new() }))
        }
    }
}

/// A row field as text ("" when absent or null).
pub fn text(row: &Row, key: &str) -> String {
    match row.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}
/// A row field as an integer.
pub fn int(row: &Row, key: &str) -> i64 {
    match row.get(key) {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}
/// A row field as a float.
pub fn float(row: &Row, key: &str) -> f64 {
    match row.get(key) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// `?, ?, ?` for an IN list.
pub fn marks(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// Saves one chat log row. The trace is JSON text (the column checks it).
pub async fn insert_chat_log(db: &Db, cfg: &MariaDbConfig, question: &str, answer: Option<&str>, trace: &Value) -> Result<()> {
    db.exec(
        cfg,
        "INSERT INTO chat_log (question, answer, trace) VALUES (?, ?, ?)",
        vec![p(question), answer.map_or(Param::NULL, p), p(trace.to_string())],
    )
    .await?;
    Ok(())
}

/// Rows one retention delete removes: a long backlog (the retention
/// shortened, a server long off) deleted at once could run past the DB time
/// limit, where the server ends it too (`limited`) and rolls it back — each
/// hour again, the backlog never cleared.
const CLEANUP_BATCH: u64 = 1000;

/// Deletes the chat log rows past the retention, a batch at a time; `stop`
/// (shutdown, which waits for it) ends it between batches.
pub async fn cleanup_chat_logs(db: &Db, cfg: &MariaDbConfig, days: u32, stop: &tokio_util::sync::CancellationToken) -> Result<u64> {
    let sql = format!("DELETE FROM chat_log WHERE created_at < NOW() - INTERVAL ? DAY ORDER BY created_at LIMIT {CLEANUP_BATCH}");
    let mut total = 0;
    loop {
        let (affected, _) = db.exec(cfg, &sql, vec![n(days.into())]).await?;
        total += affected;
        if affected < CLEANUP_BATCH || stop.is_cancelled() {
            return Ok(total);
        }
    }
}

pub async fn load_target_db(db: &Db, cfg: &MariaDbConfig, name: &str) -> Result<Option<Row>> {
    Ok(db
        .query(
            cfg,
            "SELECT seq, db_name, db_type, connection_info, db_user, db_password FROM target_db WHERE db_name = ?",
            vec![p(name)],
        )
        .await?
        .into_iter()
        .next())
}

/// Registered queries by name, in the order asked, compared by `name_key`.
/// The SQL comparison follows the column collation; names whose case
/// mapping differs from it are found by comparing every name in Rust.
pub async fn queries_by_names(db: &Db, cfg: &MariaDbConfig, names: &[String]) -> Result<Vec<Row>> {
    use crate::text::name_key;
    let mut order: Vec<String> = vec![];
    for name in names {
        let key = name_key(name);
        if !key.is_empty() && !order.contains(&key) {
            order.push(key);
        }
    }
    if order.is_empty() {
        return Ok(vec![]);
    }
    let trimmed: Vec<Param> = names.iter().map(|n| p(crate::text::js_trim(n))).collect();
    let mut rows: Vec<Row> = db
        .query(
            cfg,
            &format!("SELECT * FROM query_registry WHERE query_name IN ({})", marks(trimmed.len())),
            trimmed,
        )
        .await?
        .into_iter()
        .filter(|r| order.contains(&name_key(&text(r, "query_name"))))
        .collect();
    let found: Vec<String> = rows.iter().map(|r| name_key(&text(r, "query_name"))).collect();
    if order.iter().any(|k| !found.contains(k)) {
        let all = db.query(cfg, "SELECT seq, query_name FROM query_registry", vec![]).await?;
        let seqs: Vec<Param> = all
            .iter()
            .filter(|r| {
                let k = name_key(&text(r, "query_name"));
                order.contains(&k) && !found.contains(&k)
            })
            .map(|r| n(int(r, "seq")))
            .collect();
        if !seqs.is_empty() {
            rows.extend(
                db.query(
                    cfg,
                    &format!("SELECT * FROM query_registry WHERE seq IN ({})", marks(seqs.len())),
                    seqs,
                )
                .await?,
            );
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    rows.retain(|r| seen.insert(name_key(&text(r, "query_name"))));
    rows.sort_by_key(|r| {
        let k = name_key(&text(r, "query_name"));
        order.iter().position(|o| *o == k).unwrap_or(usize::MAX)
    });
    Ok(rows)
}

/// Registered queries a text names, in order of first mention.
pub async fn queries_mentioned_in(db: &Db, cfg: &MariaDbConfig, body: &str, limit: usize) -> Result<Vec<Row>> {
    if body.trim().is_empty() || limit == 0 {
        return Ok(vec![]);
    }
    let all = db.query(cfg, "SELECT seq, query_name FROM query_registry", vec![]).await?;
    let mut named: Vec<(usize, i64, String)> = all
        .iter()
        .filter_map(|r| {
            let name = text(r, "query_name");
            crate::text::name_index_of(body, &name).map(|at| (at, int(r, "seq"), name))
        })
        .collect();
    named.sort();
    named.truncate(limit);
    let names: Vec<String> = named.into_iter().map(|(_, _, name)| name).collect();
    queries_by_names(db, cfg, &names).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_become_json() {
        use mysql_async::Value as V;
        assert_eq!(value_json(V::Bytes("가".as_bytes().to_vec())), json!("가"));
        assert_eq!(value_json(V::Int(-3)), json!(-3));
        assert_eq!(value_json(V::Date(2026, 9, 6, 1, 2, 3, 0)), json!("2026-09-06 01:02:03"));
        assert_eq!(value_json(V::NULL), Value::Null);
    }
}
