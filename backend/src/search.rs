//! Vector search over the `vec_*` tables (MariaDB VECTOR with a cosine
//! MHNSW index). Rows whose stored vector no longer matches their content
//! (an edit the sync has not embedded yet) or is invalid are dropped, and an
//! exact scan refills the list when that happens. Beside it, a title match
//! finds the rows whose title holds the search words.

use crate::{
    config::{Config, EMBEDDING_DIMENSIONS, MariaDbConfig},
    db::{self, Db, Param, Row, n, p},
    embedding::vector_text,
};
use anyhow::Result;
use serde_json::{Value, json};
use std::sync::LazyLock;

/// The nearest few results are kept whatever their distance.
pub const MIN_RESULTS: usize = 3;
/// Knowledge chunks fetched per wanted document (several chunks of one
/// document often match together).
pub const CHUNK_OVERFETCH: usize = 3;
/// Largest candidate list one search reads.
pub const MAX_CANDIDATES: usize = 600;
/// Candidate lists one knowledge search reads at most.
const KNOWLEDGE_ROUNDS: usize = 6;
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
    nearest(db, config, table, vector, limit, &[]).await
}

/// `vector_rows`, leaving out the chunks of the knowledge documents
/// `without_docs` (the index search reads past them).
async fn nearest(db: &Db, config: &Config, table: &str, vector: &[f32], limit: usize, without_docs: &[i64]) -> Result<Vec<Row>> {
    let cfg = &config.mariadb;
    let (inner_without, refill_without) = if without_docs.is_empty() || table != "knowledge_chunk" {
        (String::new(), String::new())
    } else {
        let marks = db::marks(without_docs.len());
        (
            format!("WHERE seq NOT IN (SELECT kc.seq FROM knowledge_chunk kc WHERE kc.doc_seq IN ({marks}))"),
            format!("AND t.doc_seq NOT IN ({marks})"),
        )
    };
    let without = || without_docs.iter().map(|d| n(*d)).collect::<Vec<_>>();
    let n = limit.clamp(1, MAX_CANDIDATES);
    let current = hash_expr(&columns(table).iter().map(|c| format!("t.{c}")).collect::<Vec<_>>());
    let encoded = vector_text(vector);
    let model = config.embedding.model.clone();
    // With each statement rather than on a connection kept for both.
    let settings = format!("mhnsw_ef_search={}", config.embedding.ef_search);
    let vec = vec_table(table);
    let candidates = db.query_with(
        cfg,
        &settings,
        &format!(
            "SELECT t.*, v._dist,
               (t.seq IS NULL OR v.embed_hash <> {current}) AS _stale,
               (COALESCE(v._norm, 0) NOT BETWEEN {MIN_SAFE_NORM} AND {MAX_SAFE_NORM}) AS _invalid FROM (
               SELECT seq, embed_hash, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS _dist,
                 VEC_DISTANCE_EUCLIDEAN(embedding, VEC_FromText(?)) AS _norm
               FROM {vec} {inner_without} ORDER BY _dist LIMIT {n}
             ) v LEFT JOIN {table} t ON t.seq = v.seq
             ORDER BY v._dist, v.seq LIMIT {n}"
        ),
        [p(model.clone()), p(encoded.clone()), p(ZERO_VECTOR.clone())].into_iter().chain(without()).collect(),
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
    let refill = db.query_with(
        cfg,
        &settings,
        &format!(
            "SELECT t.*, VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(?)) AS _dist
             FROM {vec} v IGNORE INDEX (embedding) JOIN {table} t ON t.seq = v.seq
             WHERE v.embed_hash = {current}
               AND COALESCE(VEC_DISTANCE_EUCLIDEAN(v.embedding, VEC_FromText(?)), 0)
                 BETWEEN {MIN_SAFE_NORM} AND {MAX_SAFE_NORM}
               {refill_without}
             ORDER BY _dist, v.seq LIMIT {n}"
        ),
        [p(encoded), p(model), p(ZERO_VECTOR.clone())].into_iter().chain(without()).collect(),
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
    /// The results end because one search reads at most `MAX_CANDIDATES`
    /// candidates, not because none are left within the threshold.
    pub capped: bool,
}

fn excerpt(text: &str) -> String {
    let line = crate::text::single_line(text);
    crate::text::clip_marked(crate::text::js_trim(&line), 300)
}

/// Knowledge documents nearest to the vector, by their nearest chunk.
pub async fn knowledge(db: &Db, config: &Config, vector: &[f32], offset: usize, limit: usize) -> Result<Page<DocHit>> {
    let wanted = offset + limit;
    let max = config.embedding.max_distance;
    let mut docs: Vec<DocHit> = vec![];
    // Whether the last list ended within the threshold, and whether the
    // rounds stopped at the candidate limit rather than at the last list.
    let (mut past_threshold, mut at_limit) = (false, true);
    // One long document can hold every candidate chunk, and a page from
    // fewer documents than it asks for would end there: the documents found
    // are left out of the next candidate list until the page and one more
    // document are found, the candidates run out, or every document after
    // these is past the threshold.
    for _ in 0..KNOWLEDGE_ROUNDS {
        let fetch = ((wanted + 1 - docs.len()) * CHUNK_OVERFETCH).clamp(MIN_RESULTS * CHUNK_OVERFETCH, MAX_CANDIDATES);
        let found: Vec<i64> = docs.iter().map(|d| d.doc_seq).collect();
        let rows = nearest(db, config, "knowledge_chunk", vector, fetch, &found).await?;
        let full = rows.len() >= fetch;
        let farthest = rows.last().map(|r| db::float(r, "_dist"));
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
        let rest_past_threshold = docs.len() >= MIN_RESULTS && farthest.is_some_and(|d| d > max);
        past_threshold = rest_past_threshold;
        if docs.len() > wanted || !full || rest_past_threshold || docs.len() >= MAX_CANDIDATES {
            at_limit = docs.len() >= MAX_CANDIDATES || (!full && fetch >= MAX_CANDIDATES);
            break;
        }
    }
    for doc in &mut docs {
        doc.chunks.sort_unstable();
    }
    // A later list holds farther documents; the approximate index may
    // still place one a little nearer.
    docs.sort_by(|a, b| a.distance.total_cmp(&b.distance));
    // The rounds read on until more documents would be found or none can
    // be: the documents found tell whether more follow.
    // Rounds that stopped at the candidate limit, short of the page and one
    // more document, may leave documents unread: told by the documents that
    // have vectors at all.
    let cut = at_limit
        && !past_threshold
        && docs.len() <= wanted
        && unread(db, config, "SELECT COUNT(DISTINCT c.doc_seq) AS n FROM vec_knowledge_chunk v JOIN knowledge_chunk c ON c.seq = v.seq", docs.len()).await;
    page(docs, |d| d.distance, offset, limit, false, cut, max)
}

fn page<T>(rows: Vec<T>, distance: impl Fn(&T) -> f64, offset: usize, limit: usize, full: bool, cut: bool, max: f64) -> Result<Page<T>> {
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
        capped: cut && !more && beyond_threshold == 0,
    })
}

/// Whether `count_sql` counts more than the `read` rows a search read; a
/// count that fails says nothing is left.
async fn unread(db: &Db, config: &Config, count_sql: &str, read: usize) -> bool {
    match db.query(&config.mariadb, count_sql, vec![]).await {
        Ok(rows) => rows.first().is_some_and(|r| db::int(r, "n") > read as i64),
        Err(e) => {
            eprintln!("[search] counting the rows a search left unread failed: {e}");
            false
        }
    }
}

/// Q&A methods or queries nearest to the vector.
pub async fn rows(db: &Db, config: &Config, table: &str, vector: &[f32], offset: usize, limit: usize) -> Result<Page<Row>> {
    let fetch = (offset + limit).max(MIN_RESULTS);
    let rows = vector_rows(db, config, table, vector, fetch).await?;
    let full = rows.len() >= fetch;
    // The approximate index may return a few less than the limit, so rows
    // left unread are counted.
    let cut = fetch >= MAX_CANDIDATES && unread(db, config, &format!("SELECT COUNT(*) AS n FROM {}", vec_table(table)), rows.len()).await;
    page(rows, |r| db::float(r, "_dist"), offset, limit, full, cut, config.embedding.max_distance)
}

/// Title matches shown on a first page at most.
pub const TITLE_MAX: usize = 5;
/// Words of one search a title match looks for at most.
const MATCH_WORDS_MAX: usize = 8;
/// A word found inside a longer word (`term34` in `term342`, `주문` in
/// `고객주문`) counts this much of a whole-word match.
const PART_WORD: f64 = 0.5;
/// Scores this close to half the best count as half (and are left out).
const SCORE_EPSILON: f64 = 1e-9;

/// The short text of each row a title match looks in. The matched table
/// is `t`.
pub struct TitleSource {
    table: &'static str,
    /// Joined only for the rows returned.
    join: &'static str,
    text: &'static str,
    /// What a search text equal to it names exactly.
    label: &'static str,
    columns: &'static str,
}

pub const KNOWLEDGE_TITLES: TitleSource = TitleSource {
    table: "knowledge t",
    join: "LEFT JOIN knowledge_chunk c ON c.doc_seq = t.seq AND c.chunk_no = 1",
    text: "t.title",
    label: "t.title",
    // A document the sync has not chunked yet is read whole (knowledge_read
    // does the same), so its chunk count comes from its content.
    columns: "t.seq, t.title, c.chunk_of, COALESCE(c.content, LEFT(t.content, 1000)) AS _head, IF(c.seq IS NULL, t.content, NULL) AS _whole",
};
pub const METHOD_TITLES: TitleSource = TitleSource {
    table: "qa_method t",
    join: "",
    text: "t.title",
    label: "t.title",
    columns: "t.seq, t.title, LEFT(t.method, 1000) AS _head",
};
/// Query names are snake_case words; the description says in the words of
/// a question what the query finds. The name is there as written too: with
/// `_` alone made spaces, a part of a name as written (`batch_job`,
/// `customer_order`) matched no query.
pub const QUERY_TEXTS: TitleSource = TitleSource {
    table: "query_registry t",
    join: "",
    text: "CONCAT_WS(' ', t.query_name, REPLACE(t.query_name, '_', ' '), t.query_desc)",
    label: "t.query_name",
    columns: "t.*",
};

/// Rows a title match keeps, best first, and how many it keeps in all.
#[derive(Default)]
pub struct TitleMatches {
    /// Each row carries `_matched`: the search words its text holds.
    pub rows: Vec<Row>,
    pub total: usize,
}

/// The words of a search text, without surrounding punctuation, one-letter
/// words and repeats (compared without case).
pub fn match_words(text: &str) -> Vec<String> {
    const EDGE: &[char] = &[
        '"', '\'', '`', '“', '”', '‘', '’', ',', '.', ';', ':', '!', '?', '(', ')', '[', ']', '{', '}', '<', '>', '「', '」', '『', '』',
    ];
    let mut words: Vec<String> = vec![];
    for raw in text.split(crate::text::is_js_space) {
        let word = crate::text::clip_utf16(raw.trim_matches(EDGE), 100);
        if word.chars().count() < 2 || words.iter().any(|w| w.to_lowercase() == word.to_lowercase()) {
            continue;
        }
        words.push(word.to_owned());
        if words.len() == MATCH_WORDS_MAX {
            break;
        }
    }
    words
}

/// A LIKE pattern finding `word` anywhere, with `!` as the escape.
fn like_pattern(word: &str) -> String {
    let mut out = String::from("%");
    for c in word.chars() {
        if matches!(c, '!' | '%' | '_') {
            out.push('!');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// A pattern finding `word` as a whole word: no letter, digit or `_` right
/// before it, no ASCII letter, digit or `_` right after it (a Korean
/// particle may follow: `프로시저로` holds `프로시저`).
fn word_pattern(word: &str) -> String {
    let mut out = String::from("(?<![[:alnum:]_])");
    for c in word.chars() {
        if "\\^$.|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out.push_str("(?![A-Za-z0-9_])");
    out
}

/// How rows matched: per word, whether the text holds it and whether it
/// holds it as a whole word; with the number of rows matched that way.
type Group = (Vec<(bool, bool)>, usize);

/// What a title match keeps, from the match groups.
#[derive(Debug, PartialEq)]
struct Plan {
    /// Per word: 1 / the rows holding it — rarer words weigh more.
    weights: Vec<f64>,
    /// Rows scoring above this are kept (None: all are).
    cut: Option<f64>,
    total: usize,
}

fn score(flags: &[(bool, bool)], weights: &[f64]) -> f64 {
    flags
        .iter()
        .zip(weights)
        .map(|(&(part, whole), w)| if whole { *w } else if part { w * PART_WORD } else { 0.0 })
        .sum()
}

/// Rows keep a score above half the best: every word matched scores the
/// most, a rare word outweighs common ones, and rows matched only by
/// common words leave.
fn plan(groups: &[Group], words: usize) -> Option<Plan> {
    let weights: Vec<f64> = (0..words)
        .map(|i| {
            let rows: usize = groups.iter().filter(|(f, _)| f[i].0 || f[i].1).map(|(_, count)| count).sum();
            if rows == 0 { 0.0 } else { 1.0 / rows as f64 }
        })
        .collect();
    let scores: Vec<(f64, usize)> = groups.iter().map(|(f, count)| (score(f, &weights), *count)).collect();
    let top = scores.iter().map(|(s, _)| *s).fold(0.0, f64::max);
    if top <= 0.0 {
        return None;
    }
    let half = top / 2.0 + top * SCORE_EPSILON;
    let kept_min = scores.iter().filter(|(s, _)| *s > half).map(|(s, _)| *s).fold(f64::INFINITY, f64::min);
    let left_max = scores.iter().filter(|(s, _)| *s <= half).map(|(s, _)| *s).fold(f64::NEG_INFINITY, f64::max);
    // The SQL adds the scores up again: the cut sits midway between the
    // groups kept and left, away from both.
    let cut = left_max.is_finite().then(|| (kept_min + left_max) / 2.0);
    let total = scores.iter().filter(|(s, _)| *s > half).map(|(_, count)| count).sum();
    Some(Plan { weights, cut, total })
}

/// Rows whose title (queries: name and description) holds the words of
/// `text`, best first, at most `limit`. Ties go to the text equal to the
/// search, the one holding it whole, the row nearest in `near` (vector
/// distances by seq), then the shorter text.
pub async fn title_matches(
    db: &Db,
    cfg: &MariaDbConfig,
    source: &TitleSource,
    text: &str,
    near: &[(i64, f64)],
    limit: usize,
) -> Result<TitleMatches> {
    let words = match_words(text);
    if words.is_empty() || limit == 0 {
        return Ok(TitleMatches::default());
    }
    let TitleSource { table, join, text: field, label, columns } = source;
    let flags = (0..words.len())
        .map(|i| format!("({field} LIKE ? ESCAPE '!') AS _s{i}, ({field} REGEXP ?) AS _w{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let flag_params = || words.iter().flat_map(|w| [p(like_pattern(w)), p(word_pattern(w))]).collect::<Vec<_>>();
    let any = words.iter().map(|_| format!("{field} LIKE ? ESCAPE '!'")).collect::<Vec<_>>().join(" OR ");
    let any_params = || words.iter().map(|w| p(like_pattern(w))).collect::<Vec<_>>();
    // The rows of each match pattern are counted first, so the second scan
    // is plain expressions (window functions over the same rows took
    // minutes on 100,000 titles).
    let group_by = (0..words.len()).map(|i| format!("_s{i}, _w{i}")).collect::<Vec<_>>().join(", ");
    let mut params = flag_params();
    params.extend(any_params());
    let counted = db
        .query(cfg, &format!("SELECT {flags}, COUNT(*) AS _n FROM {table} WHERE {any} GROUP BY {group_by}"), params)
        .await?;
    let groups: Vec<Group> = counted
        .iter()
        .map(|r| {
            let f = (0..words.len())
                .map(|i| (db::int(r, &format!("_s{i}")) != 0, db::int(r, &format!("_w{i}")) != 0))
                .collect();
            (f, db::int(r, "_n").max(0) as usize)
        })
        .collect();
    let Some(plan) = plan(&groups, words.len()) else {
        return Ok(TitleMatches::default());
    };
    let score = (0..words.len())
        .map(|i| format!("IF(m._w{i}, ?, IF(m._s{i}, ?, 0))"))
        .collect::<Vec<_>>()
        .join(" + ");
    let near_sql = if near.is_empty() {
        "9".to_owned()
    } else {
        format!("CASE t.seq {} ELSE 9 END", near.iter().map(|_| "WHEN ? THEN ? ").collect::<String>())
    };
    let whole = crate::text::js_trim(text);
    // In the order the placeholders appear.
    let mut params: Vec<Param> = plan
        .weights
        .iter()
        .flat_map(|w| [Param::Double(*w), Param::Double(w * PART_WORD)])
        .collect();
    params.extend(flag_params());
    params.push(p(whole));
    params.push(p(like_pattern(whole)));
    params.extend(near.iter().flat_map(|(seq, d)| [n(*seq), Param::Double(*d)]));
    params.extend(any_params());
    params.push(Param::Double(plan.cut.unwrap_or(-1.0)));
    params.push(n(limit as i64));
    let rows = db
        .query(
            cfg,
            &format!(
                "SELECT * FROM (
                   SELECT m.*, {score} AS _score FROM (
                     SELECT {columns}, {flags}, ({label} = ?) AS _exact, ({field} LIKE ? ESCAPE '!') AS _phrase,
                       {near_sql} AS _near, CHAR_LENGTH({field}) AS _len
                     FROM {table} {join} WHERE {any}
                   ) m
                 ) r WHERE r._score > ?
                 ORDER BY r._exact DESC, r._score DESC, r._phrase DESC, r._near, r._len, r.seq LIMIT ?"
            ),
            params,
        )
        .await?;
    let rows = rows
        .into_iter()
        .map(|mut row| {
            let matched: Vec<Value> = words
                .iter()
                .enumerate()
                .filter(|(i, _)| db::int(&row, &format!("_s{i}")) != 0 || db::int(&row, &format!("_w{i}")) != 0)
                .map(|(_, w)| json!(w))
                .collect();
            for i in 0..words.len() {
                row.remove(&format!("_s{i}"));
                row.remove(&format!("_w{i}"));
            }
            for key in ["_exact", "_phrase", "_near", "_len", "_score"] {
                row.remove(key);
            }
            row.insert("_matched".into(), Value::Array(matched));
            row
        })
        .collect();
    Ok(TitleMatches { rows, total: plan.total })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(flags: &[(bool, bool)], count: usize) -> Group {
        (flags.to_vec(), count)
    }

    #[test]
    fn match_words_drop_punctuation_short_words_and_repeats() {
        assert_eq!(match_words("  \"DocCraftAgent\" 설치, 및 방법? docCraftAgent "), vec!["DocCraftAgent", "설치", "방법"]);
        assert_eq!(match_words("a b c"), Vec::<String>::new());
        assert_eq!(match_words("C++ (VM) finish_reason 100%"), vec!["C++", "VM", "finish_reason", "100%"]);
        assert_eq!(match_words(&(0..12).map(|i| format!("w{i} ")).collect::<String>()).len(), MATCH_WORDS_MAX);
    }

    #[test]
    fn patterns_escape_what_like_and_regexp_read_as_syntax() {
        assert_eq!(like_pattern("100%_a!"), "%100!%!_a!!%");
        assert_eq!(word_pattern("C++ (VM)"), "(?<![[:alnum:]_])C\\+\\+ \\(VM\\)(?![A-Za-z0-9_])");
    }

    #[test]
    fn rare_words_outweigh_common_ones_and_every_word_scores_most() {
        // "DocCraftAgent 설치 방법": one title holds the rare word, many hold
        // only the common ones.
        let groups = vec![
            group(&[(true, true), (false, false), (false, false)], 1),
            group(&[(false, false), (true, true), (false, false)], 1898),
            group(&[(false, false), (false, false), (true, true)], 9965),
            group(&[(false, false), (true, true), (true, true)], 40),
        ];
        let plan = plan(&groups, 3).unwrap();
        assert_eq!(plan.total, 1);
        assert_eq!(plan.weights[0], 1.0);
        let all = score(&[(true, true); 3], &plan.weights);
        assert!(groups.iter().all(|(f, _)| score(f, &plan.weights) < all));
    }

    #[test]
    fn rows_at_exactly_half_the_best_leave() {
        // "홍길동 주문 상태" over descriptions: one holds both words, the
        // others one each; 홍길동 is nowhere.
        let groups = vec![
            group(&[(false, false), (true, true), (true, true)], 1),
            group(&[(false, false), (true, true), (false, false)], 2),
            group(&[(false, false), (false, false), (true, true)], 2),
        ];
        let plan = plan(&groups, 3).unwrap();
        assert_eq!(plan.weights[0], 0.0);
        assert_eq!(plan.total, 1);
        let cut = plan.cut.unwrap();
        assert!(score(&groups[0].0, &plan.weights) > cut && score(&groups[1].0, &plan.weights) < cut);
        // Equal scores all stay: a common word alone keeps every title.
        let plan = super::plan(&[group(&[(true, true)], 312)], 1).unwrap();
        assert_eq!((plan.total, plan.cut), (312, None));
    }

    #[test]
    fn a_word_inside_a_longer_word_counts_half() {
        // "term34" whole in 60 titles, inside term342 and the like in 545.
        let groups = vec![group(&[(true, true)], 60), group(&[(true, false)], 545)];
        let plan = plan(&groups, 1).unwrap();
        assert_eq!(plan.total, 60);
        // Both words inside longer words still beat one word whole when the
        // other is rare enough: the parts add up.
        let groups = vec![
            group(&[(true, true), (false, false)], 1),
            group(&[(true, false), (true, false)], 1),
        ];
        let plan = super::plan(&groups, 2).unwrap();
        assert_eq!(plan.total, 2);
    }

    #[test]
    fn no_match_plans_nothing() {
        assert_eq!(plan(&[], 2), None);
    }

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
        let p = page(rows.clone(), |d| *d, 0, 10, false, false, 0.4).unwrap();
        assert_eq!(p.items, vec![0.9, 0.8, 0.7, 0.3]);
        assert_eq!(p.beyond_threshold, 1);
        assert!(!p.more);
        let p = page(rows, |d| *d, 1, 2, false, false, 0.4).unwrap();
        assert_eq!(p.items, vec![0.8, 0.7]);
        assert!(p.more);
    }

    #[test]
    fn a_list_cut_at_the_candidate_limit_says_so() {
        // Every candidate read is within the threshold: nearer ones are unread.
        let rows = vec![0.1, 0.2, 0.3];
        let p = page(rows.clone(), |d| *d, 3, 10, false, true, 0.4).unwrap();
        assert!(p.items.is_empty() && !p.more && p.capped);
        // One past the threshold: the list ended within what was read.
        let p = page(vec![0.1, 0.2, 0.3, 0.5], |d| *d, 3, 10, false, true, 0.4).unwrap();
        assert!(!p.capped);
        // A page that still has more is not cut.
        let p = page(rows, |d| *d, 0, 1, false, true, 0.4).unwrap();
        assert!(p.more && !p.capped);
    }
}
