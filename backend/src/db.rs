//! The management MariaDB: knowledge, Q&A methods, the query registry,
//! target DB registrations, vectors and the chat log. The pool is rebuilt
//! when the connection settings change in the settings screen.

use crate::config::MariaDbConfig;
use anyhow::{Result, bail};
use mysql_async::{Conn, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, prelude::Queryable};
use serde_json::{Map, Value, json};
use std::{sync::Mutex, time::Duration};

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
    pool: Mutex<Option<(String, Pool)>>,
}

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

impl Db {
    fn pool(&self, cfg: &MariaDbConfig) -> Result<Pool> {
        let fingerprint = cfg.fingerprint();
        let mut slot = self.pool.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((known, pool)) = slot.as_ref()
            && *known == fingerprint
        {
            return Ok(pool.clone());
        }
        let constraints = PoolConstraints::new(0, cfg.pool_size.max(1))
            .ok_or_else(|| anyhow::anyhow!("invalid pool size"))?;
        let opts = options(cfg).pool_opts(
            PoolOpts::default()
                .with_constraints(constraints)
                .with_inactive_connection_ttl(IDLE_CONNECTION_TTL),
        );
        let pool = Pool::new(Opts::from(opts));
        if let Some((_, old)) = slot.replace((fingerprint, pool.clone())) {
            tokio::spawn(async move {
                let _ = old.disconnect().await;
            });
        }
        Ok(pool)
    }

    /// A connection of its own, for a transaction or a session lock.
    pub async fn conn(&self, cfg: &MariaDbConfig) -> Result<Conn> {
        let pool = self.pool(cfg)?;
        timed(cfg, async move { Ok(pool.get_conn().await?) }).await
    }

    /// A connection outside the pool, for a session lock held while the
    /// pool's connections do the work. Taken from the pool, the lock's
    /// connection waited for a second one, which a pool of one never freed:
    /// every embedding sync failed after twice the DB timeout, every other
    /// use of the DB waiting meanwhile. Closed with `close_conn`.
    pub async fn lock_conn(&self, cfg: &MariaDbConfig) -> Result<Conn> {
        let opts = Opts::from(options(cfg));
        timed(cfg, async move { Ok(Conn::new(opts).await?) }).await
    }

    /// Closes a connection of its own (`lock_conn`) as the protocol has it,
    /// within the DB time limit. Dropped instead, it was cut without a word
    /// (mysql_async marks it closed before it says so), which the server
    /// counts and logs as an aborted connection — at every embedding sync,
    /// once a minute by default, into a log nothing trims.
    pub async fn close_conn(&self, cfg: &MariaDbConfig, conn: Conn) {
        let _ = timed(cfg, async { Ok(conn.disconnect().await?) }).await;
    }

    pub async fn query(&self, cfg: &MariaDbConfig, sql: &str, params: Vec<Param>) -> Result<Vec<Row>> {
        let mut conn = self.conn(cfg).await?;
        query_on(cfg, &mut conn, sql, params).await
    }

    /// Runs a statement; returns (affected rows, last insert id).
    pub async fn exec(&self, cfg: &MariaDbConfig, sql: &str, params: Vec<Param>) -> Result<(u64, u64)> {
        let mut conn = self.conn(cfg).await?;
        exec_on(cfg, &mut conn, sql, params).await
    }

    pub async fn close(&self) {
        let pool = self.pool.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some((_, pool)) = pool {
            let _ = pool.disconnect().await;
        }
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

pub async fn query_on(cfg: &MariaDbConfig, conn: &mut Conn, sql: &str, values: Vec<Param>) -> Result<Vec<Row>> {
    timed(cfg, async {
        let rows: Vec<mysql_async::Row> = conn.exec(sql, params(values)).await?;
        Ok(rows.into_iter().map(row_json).collect())
    })
    .await
}

pub async fn exec_on(cfg: &MariaDbConfig, conn: &mut Conn, sql: &str, values: Vec<Param>) -> Result<(u64, u64)> {
    timed(cfg, async {
        conn.exec_drop(sql, params(values)).await?;
        Ok((conn.affected_rows(), conn.last_insert_id().unwrap_or(0)))
    })
    .await
}

/// A text-protocol statement without parameters (SET, transactions).
pub async fn plain_on(cfg: &MariaDbConfig, conn: &mut Conn, sql: &str) -> Result<()> {
    timed(cfg, async {
        conn.query_drop(sql).await?;
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

pub async fn cleanup_chat_logs(db: &Db, cfg: &MariaDbConfig, days: u32) -> Result<u64> {
    let (affected, _) = db
        .exec(cfg, "DELETE FROM chat_log WHERE created_at < NOW() - INTERVAL ? DAY", vec![n(days.into())])
        .await?;
    Ok(affected)
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
