//! Keeps knowledge chunks and the `vec_*` tables in step with the admin
//! tables: documents whose hash changed are split again, rows whose content
//! hash differs from the stored vector are embedded again, and vectors of
//! deleted rows are removed. One sync runs at a time across processes
//! (a MariaDB named lock).

use crate::{
    chunk::{CHUNK_RULE, split_content},
    config::Config,
    db::{self, Db, Param, exec_on, marks, n, p, plain_on, query_on},
    embedding::{EmbedError, MAX_EMBED_TEXT_LEN, embed, vector_text},
    search::{SEARCH_COLUMNS, hash_expr, vec_table},
};
use anyhow::Result;
use futures_util::FutureExt;
use std::{
    collections::HashMap,
    panic::AssertUnwindSafe,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const BATCH: usize = 32;
const IN_CHUNK: usize = 1000;
const LOCK_NAME: &str = "space_voc_embed_sync";
const DOC_HASH_EXPR: &str = "MD5(JSON_ARRAY(?, title, content))";

/// Entries a `vec_*` table's vector index may hold for rows it no longer has
/// (at least) before the table is rebuilt. MariaDB's vector index keeps the
/// entry of every row deleted or replaced for good, and only a table copy
/// leaves it out: a vector index of 60,856 entries (180 MB) held 2 rows
/// after an afternoon of edits, measured, and searches over such an index
/// missed rows it had (6 of 10 found). Rebuilt once it holds as many such
/// entries as rows, a rebuild costs as much as the edits before it.
const STALE_ENTRIES_MIN: u64 = 100;
/// Time a rebuild may take for each row it keeps, past the DB time limit
/// (0.5 ms measured on a laptop; 10,000 rows of 1,024 dimensions in 5 s).
const REBUILD_MS_PER_ROW: u64 = 10;
/// How long a table whose rebuild failed waits before another try.
const REBUILD_RETRY: Duration = Duration::from_secs(3600);

#[derive(Debug, Default, Clone, PartialEq)]
pub enum Skipped {
    #[default]
    None,
    /// Another sync is running.
    Busy,
    /// No embedding server is configured; search cannot run.
    Unconfigured,
    /// The embedding server did not answer; the rest waits for the next run.
    Unavailable,
    /// Stopped for shutdown; the next run continues.
    Stopped,
}

#[derive(Debug, Default, Clone)]
pub struct Summary {
    pub embedded: usize,
    pub deleted: u64,
    pub failed: usize,
    pub chunks: usize,
    pub chunks_dropped: u64,
    pub chunks_failed: usize,
    /// `vec_*` tables rebuilt to drop the index entries of deleted rows.
    pub rebuilt: usize,
    pub skipped: Skipped,
}
impl Summary {
    pub fn changed(&self) -> bool {
        self.embedded > 0
            || self.deleted > 0
            || self.failed > 0
            || self.chunks_failed > 0
            || self.chunks > 0
            || self.rebuilt > 0
    }
}
impl std::fmt::Display for Summary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "created/updated {}, cleaned up {}", self.embedded, self.deleted)?;
        if self.chunks > 0 {
            write!(f, ", rechunked {} (replacing {})", self.chunks, self.chunks_dropped)?;
        }
        if self.rebuilt > 0 {
            write!(f, ", rebuilt the vector index of {} table(s)", self.rebuilt)?;
        }
        if self.failed > 0 {
            write!(f, ", skipped {} (see the [embed] row warnings)", self.failed)?;
        }
        if self.chunks_failed > 0 {
            write!(f, ", chunk failures {}", self.chunks_failed)?;
        }
        let note = match self.skipped {
            Skipped::None => "",
            Skipped::Busy => " — skipped, another sync is already in progress",
            Skipped::Unconfigured => " — no embedding URL set, embedding skipped; search cannot run without it",
            Skipped::Unavailable => " — could not reach the embedding server; the remaining rows stay unsearchable until the next run",
            Skipped::Stopped => " — stopped early for shutdown; the remaining rows are picked up on the next run",
        };
        f.write_str(note)
    }
}

#[derive(Default)]
pub struct EmbedSync {
    running: AtomicBool,
    /// By `vec_*` table, since this process last looked at its index.
    indexes: Mutex<HashMap<String, IndexState>>,
    /// The account may not rebuild a table (no ALTER privilege): told once.
    rebuild_denied: AtomicBool,
}

/// What this process knows of a `vec_*` table's vector index.
#[derive(Default)]
struct IndexState {
    /// Entries of rows this process deleted or replaced since the index was
    /// last rebuilt or counted: the count when the server's own cannot be
    /// read (it takes the PROCESS privilege).
    stale: u64,
    /// When a rebuild last failed.
    failed_at: Option<Instant>,
}

impl EmbedSync {
    pub async fn run(&self, db: &Db, config: &Config, stop: &CancellationToken) -> Result<Summary> {
        if self.running.swap(true, Ordering::AcqRel) {
            return Ok(Summary {
                skipped: Skipped::Busy,
                ..Default::default()
            });
        }
        let result = async {
            let cfg = &config.mariadb;
            // Not one of the pool's, which the sync uses meanwhile.
            let mut lock = db.lock_conn(cfg).await?;
            let locked = async {
                let got = query_on(cfg, &mut lock, &format!("SELECT GET_LOCK('{LOCK_NAME}', 0) AS l"), vec![]).await?;
                if got.first().map_or(0, |r| db::int(r, "l")) != 1 {
                    return Ok(Summary {
                        skipped: Skipped::Busy,
                        ..Default::default()
                    });
                }
                let summary = sync(self, db, config, stop).await;
                let _ = plain_on(cfg, &mut lock, &format!("SELECT RELEASE_LOCK('{LOCK_NAME}')")).await;
                summary
            }
            .await;
            db.close_conn(cfg, lock).await;
            locked
        };
        // A panic would otherwise leave `running` set (every later sync
        // skipped as busy) and end the periodic sync's loop with it. The
        // lock goes with its connection, cut when dropped.
        let result = AssertUnwindSafe(result)
            .catch_unwind()
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("embedding sync stopped unexpectedly (panic)")));
        self.running.store(false, Ordering::Release);
        result
    }
}

async fn rebuild_chunks(db: &Db, config: &Config, stop: &CancellationToken, out: &mut Summary) -> Result<()> {
    let cfg = &config.mariadb;
    let docs = db
        .query(cfg, &format!("SELECT seq, {DOC_HASH_EXPR} AS h FROM knowledge"), vec![p(CHUNK_RULE)])
        .await?;
    if stop.is_cancelled() {
        return Ok(());
    }
    let have: HashMap<i64, db::Row> = db
        .query(
            cfg,
            "SELECT doc_seq, MIN(doc_hash) AS h, MAX(doc_hash) AS max_h, COUNT(*) AS n,
               MIN(chunk_no) AS first_no, MAX(chunk_no) AS last_no,
               MIN(chunk_of) AS min_of, MAX(chunk_of) AS max_of
             FROM knowledge_chunk GROUP BY doc_seq",
            vec![],
        )
        .await?
        .into_iter()
        .map(|r| (db::int(&r, "doc_seq"), r))
        .collect();
    let stale: Vec<i64> = docs
        .iter()
        .filter(|d| {
            let h = db::text(d, "h");
            match have.get(&db::int(d, "seq")) {
                None => true,
                Some(c) => {
                    let count = db::int(c, "n");
                    db::text(c, "h") != h
                        || db::text(c, "max_h") != h
                        || db::int(c, "first_no") != 1
                        || db::int(c, "last_no") != count
                        || db::int(c, "min_of") != count
                        || db::int(c, "max_of") != count
                }
            }
        })
        .map(|d| db::int(d, "seq"))
        .collect();
    // One document read at a time: a document's content has no size limit
    // (LONGTEXT), and read a thousand at once, the sync held every one of
    // them, twice over, while it split the first (40 documents of 11 MiB:
    // 0.9 GiB at its peak).
    for seq in stale {
        if stop.is_cancelled() {
            return Ok(());
        }
        let Some(mut row) = db
            .query(
                cfg,
                &format!("SELECT title, content, {DOC_HASH_EXPR} AS h FROM knowledge WHERE seq = ?"),
                vec![p(CHUNK_RULE), n(seq)],
            )
            .await?
            .pop()
        else {
            // Deleted meanwhile: its chunks went with it.
            continue;
        };
        let parts = split_content(&db::text(&row, "content"));
        row.remove("content");
        let mut conn = db.conn(cfg).await?;
        let result: Result<Option<u64>> = async {
            plain_on(cfg, &mut conn, "START TRANSACTION").await?;
            for (i, content) in parts.iter().enumerate() {
                if stop.is_cancelled() {
                    return Ok(None);
                }
                exec_on(
                    cfg,
                    &mut conn,
                    "INSERT INTO knowledge_chunk (doc_seq, chunk_no, chunk_of, doc_hash, title, content)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE chunk_of = VALUES(chunk_of), doc_hash = VALUES(doc_hash),
                                             title = VALUES(title), content = VALUES(content)",
                    vec![
                        n(seq),
                        n(i as i64 + 1),
                        n(parts.len() as i64),
                        p(db::text(&row, "h")),
                        p(db::text(&row, "title")),
                        p(content.clone()),
                    ],
                )
                .await?;
            }
            let (dropped, _) = exec_on(
                cfg,
                &mut conn,
                "DELETE FROM knowledge_chunk WHERE doc_seq = ? AND chunk_no > ?",
                vec![n(seq), n(parts.len() as i64)],
            )
            .await?;
            if stop.is_cancelled() {
                return Ok(None);
            }
            plain_on(cfg, &mut conn, "COMMIT").await?;
            Ok(Some(dropped))
        }
        .await;
        match result {
            Ok(Some(dropped)) => {
                out.chunks += parts.len();
                out.chunks_dropped += dropped;
            }
            Ok(None) => {
                let _ = plain_on(cfg, &mut conn, "ROLLBACK").await;
                return Ok(());
            }
            Err(e) => {
                let _ = plain_on(cfg, &mut conn, "ROLLBACK").await;
                out.chunks_failed += 1;
                eprintln!("[embed] knowledge#{seq} chunking failed — skipping this document only: {e}");
            }
        }
    }
    Ok(())
}

async fn sync(state: &EmbedSync, db: &Db, config: &Config, stop: &CancellationToken) -> Result<Summary> {
    let cfg = &config.mariadb;
    let enabled = config.embedding.enabled();
    let mut out = Summary {
        skipped: if enabled { Skipped::None } else { Skipped::Unconfigured },
        ..Default::default()
    };
    if let Err(e) = rebuild_chunks(db, config, stop, &mut out).await {
        out.chunks_failed += 1;
        eprintln!("[embed] chunk rebuild failed — vector sync continues with existing chunks: {e}");
    }
    let model = config.embedding.model.clone();
    let mut unavailable = false;
    for (table, cols) in SEARCH_COLUMNS {
        if stop.is_cancelled() {
            out.skipped = Skipped::Stopped;
            break;
        }
        let cols: Vec<String> = cols.iter().map(|c| (*c).to_owned()).collect();
        let check = enabled && !unavailable;
        let rows = if check {
            db.query(cfg, &format!("SELECT seq, {} AS h FROM {table}", hash_expr(&cols)), vec![p(model.clone())]).await?
        } else {
            db.query(cfg, &format!("SELECT seq FROM {table}"), vec![]).await?
        };
        let mut stored: HashMap<i64, String> = db
            .query(cfg, &format!("SELECT seq, embed_hash FROM {}", vec_table(table)), vec![])
            .await?
            .into_iter()
            .map(|r| (db::int(&r, "seq"), db::text(&r, "embed_hash")))
            .collect();
        let mut stale: Vec<(i64, String)> = vec![];
        // Rows whose vector is replaced: each leaves its old index entry.
        let mut replaced = 0u64;
        for r in &rows {
            let seq = db::int(r, "seq");
            let h = db::text(r, "h");
            if check && stored.get(&seq) != Some(&h) {
                replaced += u64::from(stored.contains_key(&seq));
                stale.push((seq, h));
            }
            stored.remove(&seq);
        }
        let deleted_before = out.deleted;
        let orphans: Vec<i64> = stored.into_keys().collect();
        for seqs in orphans.chunks(IN_CHUNK) {
            if stop.is_cancelled() {
                break;
            }
            let (deleted, _) = db
                .exec(
                    cfg,
                    &format!("DELETE FROM {} WHERE seq IN ({})", vec_table(table), marks(seqs.len())),
                    seqs.iter().map(|s| n(*s)).collect(),
                )
                .await?;
            out.deleted += deleted;
        }
        // Read as many rows as one embedding call takes: a thousand rows of
        // three TEXT columns each were up to 190 MiB read at once, for
        // texts cut to MAX_EMBED_TEXT_LEN.
        for seqs in stale.chunks(BATCH) {
            if stop.is_cancelled() {
                out.skipped = Skipped::Stopped;
                break;
            }
            let mut params: Vec<Param> = vec![p(model.clone())];
            params.extend(seqs.iter().map(|(s, _)| n(*s)));
            let content = db
                .query(
                    cfg,
                    &format!(
                        "SELECT seq, {}, {} AS h FROM {table} WHERE seq IN ({})",
                        cols.join(", "),
                        hash_expr(&cols),
                        marks(seqs.len())
                    ),
                    params,
                )
                .await?;
            let batch: Vec<(i64, String, String)> = content
                .iter()
                .map(|r| {
                    let text = cols.iter().map(|c| db::text(r, c)).collect::<Vec<_>>().join("\n");
                    (
                        db::int(r, "seq"),
                        crate::text::clip_utf16(&text, MAX_EMBED_TEXT_LEN).to_owned(),
                        db::text(r, "h"),
                    )
                })
                .collect();
            match embed_stale(db, config, table, &batch, stop, &mut out).await {
                Flow::Continue => {}
                Flow::Unavailable => {
                    unavailable = true;
                    out.skipped = Skipped::Unavailable;
                    break;
                }
                Flow::Stopped => {
                    out.skipped = Skipped::Stopped;
                    break;
                }
            }
        }
        if out.skipped == Skipped::Stopped {
            break;
        }
        let left = replaced + (out.deleted - deleted_before);
        if let Err(e) = rebuild_index(state, db, config, table, left, stop, &mut out).await {
            eprintln!("[embed] could not check the vector index of {} — trying again at a later sync: {e:#}", vec_table(table));
        }
    }
    Ok(out)
}

/// Rebuilds `table`'s vector table when its index holds as many entries of
/// deleted or replaced rows as rows (`STALE_ENTRIES_MIN`), counted by the
/// server where the account may read it, else as this process left them
/// (`left` more now). Looked at once a process, then after changes.
async fn rebuild_index(
    state: &EmbedSync,
    db: &Db,
    config: &Config,
    table: &str,
    left: u64,
    stop: &CancellationToken,
    out: &mut Summary,
) -> Result<()> {
    let cfg = &config.mariadb;
    let vec = vec_table(table);
    let counted = {
        let mut indexes = state.indexes.lock().unwrap_or_else(|p| p.into_inner());
        let seen = indexes.contains_key(&vec);
        let index = indexes.entry(vec.clone()).or_default();
        index.stale += left;
        if (seen && left == 0)
            || stop.is_cancelled()
            || state.rebuild_denied.load(Ordering::Acquire)
            || index.failed_at.is_some_and(|at| at.elapsed() < REBUILD_RETRY)
        {
            return Ok(());
        }
        index.stale
    };
    let rows = db.query(cfg, &format!("SELECT COUNT(*) AS n FROM {vec}"), vec![]).await?;
    let rows = u64::try_from(rows.first().map_or(0, |r| db::int(r, "n"))).unwrap_or(0);
    // InnoDB keeps the index in a table of its own, `<table>#i#<n>`.
    let entries = db
        .query(
            cfg,
            "SELECT SUM(num_rows) AS n FROM information_schema.INNODB_SYS_TABLESTATS WHERE name LIKE CONCAT(DATABASE(), '/', ?, '#i#%')",
            vec![p(vec.replace('_', "\\_"))],
        )
        .await
        .ok()
        .and_then(|r| r.into_iter().next())
        .filter(|r| r.get("n").is_some_and(|n| !n.is_null()))
        .map(|r| db::int(&r, "n"));
    let stale = match entries {
        Some(entries) => u64::try_from(entries).unwrap_or(0).saturating_sub(rows),
        None => counted,
    };
    let update = |change: &dyn Fn(&mut IndexState)| {
        let mut indexes = state.indexes.lock().unwrap_or_else(|p| p.into_inner());
        change(indexes.entry(vec.clone()).or_default());
    };
    if stale < rows.max(STALE_ENTRIES_MIN) {
        if entries.is_some() {
            update(&|index| index.stale = 0);
        }
        return Ok(());
    }
    // Searches read the table meanwhile; its writes wait (this sync's alone).
    let mut long = cfg.clone();
    long.timeout_ms = cfg.timeout_ms.saturating_add(rows.saturating_mul(REBUILD_MS_PER_ROW));
    let started = Instant::now();
    match db.exec(&long, &format!("ALTER TABLE {vec} ALGORITHM=COPY, FORCE"), vec![]).await {
        Ok(_) => {
            update(&|index| *index = IndexState::default());
            out.rebuilt += 1;
            eprintln!(
                "[embed] rebuilt {vec}: its vector index dropped about {stale} entries of deleted or replaced rows, {rows} rows kept ({} ms)",
                started.elapsed().as_millis()
            );
        }
        Err(e) if db::server_code(&e) == Some(db::ER_TABLEACCESS_DENIED) => {
            if !state.rebuild_denied.swap(true, Ordering::AcqRel) {
                eprintln!(
                    "[embed] the vector index of {vec} holds about {stale} entries of deleted or replaced rows ({rows} rows): MariaDB drops them only when the table is rebuilt, which the management DB account may not do — grant it ALTER on the vec_* tables (README, MariaDB schema), or run `ALTER TABLE {vec} ALGORITHM=COPY, FORCE` now and then"
                );
            }
        }
        Err(e) => {
            update(&|index| index.failed_at = Some(Instant::now()));
            eprintln!("[embed] rebuilding {vec} failed — trying again in an hour: {e:#}");
        }
    }
    Ok(())
}

enum Flow {
    Continue,
    Unavailable,
    Stopped,
}

async fn embed_stale(
    db: &Db,
    config: &Config,
    table: &str,
    stale: &[(i64, String, String)],
    stop: &CancellationToken,
    out: &mut Summary,
) -> Flow {
    for batch in stale.chunks(BATCH) {
        if stop.is_cancelled() {
            return Flow::Stopped;
        }
        let texts: Vec<String> = batch.iter().map(|b| b.1.clone()).collect();
        match embed(&config.embedding, &texts, stop).await {
            Ok(vectors) => store(db, config, table, batch, &vectors, out).await,
            Err(_) if stop.is_cancelled() => return Flow::Stopped,
            Err(e) => {
                warn(&e);
                if e.retriable {
                    return Flow::Unavailable;
                }
                // One bad row must not fail its batch: embed them one by one.
                for row in batch {
                    if stop.is_cancelled() {
                        return Flow::Stopped;
                    }
                    match embed(&config.embedding, std::slice::from_ref(&row.1), stop).await {
                        Ok(vectors) => store(db, config, table, std::slice::from_ref(row), &vectors, out).await,
                        Err(_) if stop.is_cancelled() => return Flow::Stopped,
                        Err(e) if e.retriable => {
                            warn(&e);
                            return Flow::Unavailable;
                        }
                        Err(e) => {
                            out.failed += 1;
                            eprintln!("[embed] {table}#{} embedding failed — skipping this row only: {e}", row.0);
                        }
                    }
                }
            }
        }
    }
    Flow::Continue
}

fn warn(e: &EmbedError) {
    eprintln!("[embedding] embedding call failed: {e}");
}

async fn store(db: &Db, config: &Config, table: &str, batch: &[(i64, String, String)], vectors: &[Vec<f32>], out: &mut Summary) {
    let cfg = &config.mariadb;
    let vec = vec_table(table);
    let mut params = vec![];
    for (row, vector) in batch.iter().zip(vectors) {
        params.extend([n(row.0), p(row.2.clone()), p(vector_text(vector))]);
    }
    let sql = format!(
        "REPLACE INTO {vec} (seq, embed_hash, embedding) VALUES {}",
        vec!["(?, ?, VEC_FromText(?))"; batch.len()].join(", ")
    );
    if db.exec(cfg, &sql, params).await.is_ok() {
        out.embedded += batch.len();
        return;
    }
    for (row, vector) in batch.iter().zip(vectors) {
        match db
            .exec(
                cfg,
                &format!("REPLACE INTO {vec} (seq, embed_hash, embedding) VALUES (?, ?, VEC_FromText(?))"),
                vec![n(row.0), p(row.2.clone()), p(vector_text(vector))],
            )
            .await
        {
            Ok(_) => out.embedded += 1,
            Err(e) => {
                out.failed += 1;
                eprintln!("[embed] {table}#{} store failed: {e}", row.0);
            }
        }
    }
}
