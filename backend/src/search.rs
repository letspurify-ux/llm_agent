//! Vector search over the `vec_*` tables (MariaDB VECTOR with a cosine
//! MHNSW index). Rows whose stored vector no longer matches their content
//! (an edit the sync has not embedded yet) or is invalid are dropped, and an
//! exact scan refills the list when that happens.

use crate::{
    config::{Config, EMBEDDING_DIMENSIONS},
    db::{self, Db, Row, p, plain_on, query_on},
    embedding::vector_text,
};
use anyhow::Result;
use std::sync::LazyLock;

/// The nearest few results are kept whatever their distance.
pub const MIN_RESULTS: usize = 3;
/// Knowledge chunks fetched per wanted document (several chunks of one
/// document often match together).
pub const CHUNK_OVERFETCH: usize = 3;
/// Largest candidate list one search reads.
const MAX_CANDIDATES: usize = 600;
const MIN_SAFE_NORM: &str = "1.0842021724855044e-19";
const MAX_SAFE_NORM: &str = "1.844674352395373e19";
static ZERO_VECTOR: LazyLock<String> =
    LazyLock::new(|| vector_text(&vec![0.0; EMBEDDING_DIMENSIONS]));

/// Embedded columns of each searchable table, in hash and text order.
pub const SEARCH_COLUMNS: [(&str, &[&str]); 3] = [
    ("knowledge_chunk", &["title", "content"]),
    ("qa_method", &["title", "method"]),
    ("query_registry", &["query_name", "query_desc", "input_desc", "output_desc"]),
];

pub fn columns(table: &str) -> &'static [&'static str] {
    SEARCH_COLUMNS
        .iter()
        .find(|(t, _)| *t == table)
        .map(|(_, c)| *c)
        .unwrap_or(&[])
}

pub fn vec_table(table: &str) -> String {
    format!("vec_{table}")
}

/// The content hash the sync stores with a vector, computed in MariaDB
/// (the model name is its first parameter).
pub fn hash_expr(cols: &[String]) -> String {
    format!(
        "MD5(CONCAT_WS(CHAR(10), ?, {}))",
        cols.iter()
            .map(|c| format!("COALESCE({c}, '')"))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// Rows of `table` nearest to `vector`, with `_dist`, at most `limit`.
pub async fn vector_rows(db: &Db, config: &Config, table: &str, vector: &[f32], limit: usize) -> Result<Vec<Row>> {
    let cfg = &config.mariadb;
    let n = limit.clamp(1, MAX_CANDIDATES);
    let current = hash_expr(&columns(table).iter().map(|c| format!("t.{c}")).collect::<Vec<_>>());
    let encoded = vector_text(vector);
    let model = config.embedding.model.clone();
    let mut conn = db.conn(cfg).await?;
    plain_on(cfg, &mut conn, &format!("SET SESSION mhnsw_ef_search = {}", config.embedding.ef_search)).await?;
    let vec = vec_table(table);
    let candidates = query_on(
        cfg,
        &mut conn,
        &format!(
            "SELECT t.*, v._dist,
               (t.seq IS NULL OR v.embed_hash <> {current}) AS _stale,
               (COALESCE(v._norm, 0) NOT BETWEEN {MIN_SAFE_NORM} AND {MAX_SAFE_NORM}) AS _invalid FROM (
               SELECT seq, embed_hash, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS _dist,
                 VEC_DISTANCE_EUCLIDEAN(embedding, VEC_FromText(?)) AS _norm
               FROM {vec} ORDER BY _dist LIMIT {n}
             ) v LEFT JOIN {table} t ON t.seq = v.seq
             ORDER BY v._dist, v.seq LIMIT {n}"
        ),
        vec![p(model.clone()), p(encoded.clone()), p(ZERO_VECTOR.clone())],
    )
    .await?;
    let total = candidates.len();
    let valid: Vec<Row> = candidates
        .into_iter()
        .filter(|r| db::int(r, "_stale") == 0 && db::int(r, "_invalid") == 0)
        .map(|mut r| {
            r.remove("_stale");
            r.remove("_invalid");
            r
        })
        .collect();
    if valid.len() == total {
        return Ok(valid);
    }
    let refill = query_on(
        cfg,
        &mut conn,
        &format!(
            "SELECT t.*, VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(?)) AS _dist
             FROM {vec} v IGNORE INDEX (embedding) JOIN {table} t ON t.seq = v.seq
             WHERE v.embed_hash = {current}
               AND COALESCE(VEC_DISTANCE_EUCLIDEAN(v.embedding, VEC_FromText(?)), 0)
                 BETWEEN {MIN_SAFE_NORM} AND {MAX_SAFE_NORM}
             ORDER BY _dist, v.seq LIMIT {n}"
        ),
        vec![p(encoded), p(model), p(ZERO_VECTOR.clone())],
    )
    .await;
    match refill {
        Ok(rows) => Ok(rows),
        Err(e) if !valid.is_empty() => {
            eprintln!("[search] candidate refill failed on {table} — keeping validated matches: {e}");
            Ok(valid)
        }
        Err(e) => Err(e),
    }
}

/// Whether a ranked row stays: the first few always, the rest within the
/// distance threshold.
fn kept(rank: usize, distance: f64, max_distance: f64) -> bool {
    rank < MIN_RESULTS || distance <= max_distance
}

/// One knowledge document among the search results.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DocHit {
    pub doc_seq: i64,
    pub title: String,
    pub chunk_of: i64,
    pub best_chunk: i64,
    pub chunks: Vec<i64>,
    pub distance: f64,
    pub excerpt: String,
}

/// A ranked page of search results.
pub struct Page<T> {
    pub items: Vec<T>,
    /// More results within the threshold may follow this page.
    pub more: bool,
    /// Results dropped for their distance.
    pub beyond_threshold: usize,
}

fn excerpt(text: &str) -> String {
    let line = crate::text::single_line(text);
    crate::text::clip_marked(crate::text::js_trim(&line), 300)
}

pub async fn knowledge(db: &Db, config: &Config, vector: &[f32], offset: usize, limit: usize) -> Result<Page<DocHit>> {
    let wanted = offset + limit;
    let fetch = (wanted * CHUNK_OVERFETCH).clamp(MIN_RESULTS * CHUNK_OVERFETCH, MAX_CANDIDATES);
    let rows = vector_rows(db, config, "knowledge_chunk", vector, fetch).await?;
    let fetched = rows.len();
    let mut docs: Vec<DocHit> = vec![];
    for row in rows {
        let doc = db::int(&row, "doc_seq");
        let chunk = db::int(&row, "chunk_no");
        match docs.iter_mut().find(|d| d.doc_seq == doc) {
            Some(hit) => hit.chunks.push(chunk),
            None => docs.push(DocHit {
                doc_seq: doc,
                title: db::text(&row, "title"),
                chunk_of: db::int(&row, "chunk_of"),
                best_chunk: chunk,
                chunks: vec![chunk],
                distance: db::float(&row, "_dist"),
                excerpt: excerpt(&db::text(&row, "content")),
            }),
        }
    }
    for doc in &mut docs {
        doc.chunks.sort_unstable();
    }
    page(docs, |d| d.distance, offset, limit, fetched >= fetch, config.embedding.max_distance)
}

fn page<T>(rows: Vec<T>, distance: impl Fn(&T) -> f64, offset: usize, limit: usize, full: bool, max: f64) -> Result<Page<T>> {
    let total = rows.len();
    let kept_rows: Vec<T> = rows
        .into_iter()
        .enumerate()
        .filter(|(rank, r)| kept(*rank, distance(r), max))
        .map(|(_, r)| r)
        .collect();
    let beyond_threshold = total - kept_rows.len();
    let available = kept_rows.len();
    // A full candidate list whose last row is still kept may continue.
    let more = available > offset + limit || (full && beyond_threshold == 0);
    let items = kept_rows.into_iter().skip(offset).take(limit).collect();
    Ok(Page {
        items,
        more,
        beyond_threshold,
    })
}

/// Q&A methods or queries nearest to the vector.
pub async fn rows(db: &Db, config: &Config, table: &str, vector: &[f32], offset: usize, limit: usize) -> Result<Page<Row>> {
    let fetch = (offset + limit).max(MIN_RESULTS);
    let rows = vector_rows(db, config, table, vector, fetch).await?;
    let full = rows.len() >= fetch;
    page(rows, |r| db::float(r, "_dist"), offset, limit, full, config.embedding.max_distance)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_expression_matches_the_stored_form() {
        assert_eq!(
            hash_expr(&["t.title".into(), "t.method".into()]),
            "MD5(CONCAT_WS(CHAR(10), ?, COALESCE(t.title, ''), COALESCE(t.method, '')))"
        );
    }

    #[test]
    fn pages_keep_the_nearest_few_and_the_threshold() {
        let rows = vec![0.9, 0.8, 0.7, 0.3, 0.6];
        let p = page(rows.clone(), |d| *d, 0, 10, false, 0.4).unwrap();
        assert_eq!(p.items, vec![0.9, 0.8, 0.7, 0.3]);
        assert_eq!(p.beyond_threshold, 1);
        assert!(!p.more);
        let p = page(rows, |d| *d, 1, 2, false, 0.4).unwrap();
        assert_eq!(p.items, vec![0.8, 0.7]);
        assert!(p.more);
    }
}
