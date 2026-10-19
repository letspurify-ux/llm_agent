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
    sync::atomic::{AtomicBool, Ordering},
};
use tokio_util::sync::CancellationToken;

const BATCH: usize = 32;
const IN_CHUNK: usize = 1000;
const LOCK_NAME: &str = "space_voc_embed_sync";
const DOC_HASH_EXPR: &str = "MD5(JSON_ARRAY(?, title, content))";

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
    pub skipped: Skipped,
}
impl Summary {
    pub fn changed(&self) -> bool {
        self.embedded > 0 || self.deleted > 0 || self.failed > 0 || self.chunks_failed > 0 || self.chunks > 0
    }
}
impl std::fmt::Display for Summary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "created/updated {}, cleaned up {}", self.embedded, self.deleted)?;
        if self.chunks > 0 {
            write!(f, ", rechunked {} (replacing {})", self.chunks, self.chunks_dropped)?;
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
            let got = query_on(cfg, &mut lock, &format!("SELECT GET_LOCK('{LOCK_NAME}', 0) AS l"), vec![]).await?;
            if got.first().map_or(0, |r| db::int(r, "l")) != 1 {
                return Ok(Summary {
                    skipped: Skipped::Busy,
                    ..Default::default()
                });
            }
            let summary = sync(db, config, stop).await;
            let _ = plain_on(cfg, &mut lock, &format!("SELECT RELEASE_LOCK('{LOCK_NAME}')")).await;
            summary
        };
        // A panic would otherwise leave `running` set (every later sync
        // skipped as busy) and end the periodic sync's loop with it. The
        // lock goes with its connection, closed when dropped.
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
    for seqs in stale.chunks(IN_CHUNK) {
        if stop.is_cancelled() {
            break;
        }
        let mut params = vec![p(CHUNK_RULE)];
        params.extend(seqs.iter().map(|s| n(*s)));
        let rows = db
            .query(
                cfg,
                &format!("SELECT seq, title, content, {DOC_HASH_EXPR} AS h FROM knowledge WHERE seq IN ({})", marks(seqs.len())),
                params,
            )
            .await?;
        for row in rows {
            if stop.is_cancelled() {
                return Ok(());
            }
            let seq = db::int(&row, "seq");
            let parts = split_content(&db::text(&row, "content"));
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
    }
    Ok(())
}

async fn sync(db: &Db, config: &Config, stop: &CancellationToken) -> Result<Summary> {
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
        for r in &rows {
            let seq = db::int(r, "seq");
            let h = db::text(r, "h");
            if check && stored.get(&seq) != Some(&h) {
                stale.push((seq, h));
            }
            stored.remove(&seq);
        }
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
        for seqs in stale.chunks(IN_CHUNK) {
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
    }
    Ok(out)
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
