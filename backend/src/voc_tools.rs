//! Tools over the registered knowledge, Q&A methods and queries. They follow
//! the MnemoArc tool rules: search returns ranked summaries and IDs, reading
//! tools return the text, the model chooses limit, offset and cursor within
//! runtime caps, and every result is bounded by the result budget.

use crate::{
    app::App,
    config::Config,
    db::{self, Row, marks, n},
    execution::input_bind_names,
    search,
    session::StoredResult,
    text::{TRUNC_MARK, clip_marked, clip_utf16, js_trim, name_key, target_db_names, utf16_len},
    tools::{ToolSpec, number, schema, string},
};
use anyhow::{Result, bail};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

/// Search results per target: default and cap.
pub const SEARCH_DEFAULT: usize = 10;
pub const SEARCH_MAX: usize = 50;
/// Knowledge chunks one read fetches at most (a chunk is up to 1,000
/// characters): far past what one result budget holds, so a read stops at
/// the budget.
pub const CHUNKS_MAX: usize = 500;
/// Items per method_read / query_describe call.
pub const ITEMS_MAX: usize = 10;
/// Query rows shown with a run: default and cap.
pub const PREVIEW_DEFAULT: usize = 20;
pub const PREVIEW_MAX: usize = 100;
/// Rows per result_read page: default and cap.
pub const READ_DEFAULT: usize = 50;
pub const READ_MAX: usize = 200;
/// Largest offset or start_chunk taken from a call: far past any stored
/// result or document, and small enough that `offset + limit` cannot overflow.
const MAX_OFFSET: u64 = 1_000_000;

pub fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "search",
            description: "Semantic search over the registered knowledge (concepts, policies, procedures, manuals), Q&A methods (lookup procedures for kinds of questions) and registered queries. Returns ranked summaries with IDs and cosine distance (smaller is closer), not full text: read knowledge with knowledge_read, methods with method_read, and queries with query_describe. targets chooses what to search (default all three). limit is per target (default 10, max 50); offset continues the same search past results already received. An exact registered query name returns that query first. The first page also puts up to 5 items whose title (queries: name or description) contains the search words first, marked title_match; title_matches counts all such items. status search_unavailable means the search could not run (not that nothing exists).",
            source: false,
            parameters: schema(
                json!({
                    "query":{"type":"string","description":"2 to 6 key words, or an exact query name"},
                    "targets":{"type":"array","items":{"type":"string","enum":["knowledge","qa_method","query"]}},
                    "limit":{"type":"integer","minimum":1,"maximum":SEARCH_MAX},
                    "offset":number()
                }),
                &["query"],
            ),
        },
        ToolSpec {
            name: "knowledge_read",
            description: "Read a knowledge document by its ID from search (k<number>). By default it reads from the start as far as one result holds, so most documents arrive whole (complete_to_end). Documents are stored in chunks of up to 1,000 characters and chunk_of tells how many a document has. For a document longer than one read, continue with next_cursor, or start at a chunk from search's matched_chunks with start_chunk; max_chunks reads fewer chunks.",
            source: false,
            parameters: schema(
                json!({"id":string(),"start_chunk":{"type":"integer","minimum":1},"max_chunks":{"type":"integer","minimum":1,"maximum":CHUNKS_MAX},"cursor":string()}),
                &[],
            ),
        },
        ToolSpec {
            name: "method_read",
            description: "Read Q&A methods in full by their IDs from search (m<number>), up to 10 per call. Each result lists the registered queries the method names, with their description and inputs.",
            source: false,
            parameters: schema(
                json!({"ids":{"type":"array","minItems":1,"maxItems":ITEMS_MAX,"items":{"type":"string"}}}),
                &["ids"],
            ),
        },
        ToolSpec {
            name: "query_describe",
            description: "Show registered queries in full by exact name, up to 10 per call: type (QUERY, PROCEDURE, FUNCTION), description, input binds with their input description, output description, target DB candidates and the SQL.",
            source: false,
            parameters: schema(
                json!({"names":{"type":"array","minItems":1,"maxItems":ITEMS_MAX,"items":{"type":"string"}}}),
                &["names"],
            ),
        },
        ToolSpec {
            name: "query_run",
            description: "Run one registered query against its target DB and receive a step number, its columns, the row count and the first rows (preview_rows, default 20, max 100). Fill every input bind in params (keys without a colon); values must come from the question or earlier results. target_db is required when the query has more than one candidate. Independent queries can be run together as several calls in one response. Read omitted rows or columns with result_read, never by running the query again; answers refer to the rows with ```table or ```chart blocks naming the step.",
            source: false,
            parameters: schema(
                json!({
                    "query_name":string(),
                    "params":{"type":"object","additionalProperties":{"type":["string","number"]}},
                    "target_db":string(),
                    "preview_rows":{"type":"integer","minimum":1,"maximum":PREVIEW_MAX}
                }),
                &["query_name"],
            ),
        },
        ToolSpec {
            name: "result_read",
            description: "Read stored rows of an earlier query_run by its step without querying the DB again: offset (0-based row, default 0), limit (default 50, max 200) and cols (exact column names; default all). Cells cut at 4,000 characters stay cut.",
            source: false,
            parameters: schema(
                json!({"step":{"type":"integer","minimum":1},"offset":number(),"limit":{"type":"integer","minimum":1,"maximum":READ_MAX},"cols":{"type":"array","items":{"type":"string"}}}),
                &["step"],
            ),
        },
    ]
}


/// Values the model was shown cut short: a bind value equal to one of them
/// is a clipped copy, not the stored value.
#[derive(Default, Clone)]
pub struct Clipped(BTreeSet<String>);
impl Clipped {
    /// Cell lengths values are cut at: driver cells, answer table and chart
    /// cells (and one less when a surrogate pair was not split).
    const LENGTHS: [usize; 6] = [
        crate::oracle::MAX_CELL_LEN,
        crate::oracle::MAX_CELL_LEN - 1,
        120,
        119,
        60,
        59,
    ];

    pub fn from_results(results: &BTreeMap<u64, StoredResult>) -> Self {
        let mut set = BTreeSet::new();
        for result in results.values() {
            for row in result.rows.iter() {
                for value in row.values() {
                    if let Some(text) = value.as_str()
                        && let Some(prefix) = text.strip_suffix(TRUNC_MARK)
                    {
                        set.insert(prefix.to_owned());
                    }
                }
            }
        }
        Self(set)
    }
    /// Adds what conversation texts (answers, restored turns) show cut.
    pub fn learn_text(&mut self, text: &str) {
        let units: Vec<u16> = text.encode_utf16().collect();
        let mark: Vec<u16> = TRUNC_MARK.encode_utf16().collect();
        let mut at = 0;
        while at + mark.len() <= units.len() {
            if units[at..at + mark.len()] != mark[..] {
                at += 1;
                continue;
            }
            for len in Self::LENGTHS {
                if at >= len {
                    self.0.insert(String::from_utf16_lossy(&units[at - len..at]));
                }
            }
            // The table cell the mark ends: from the previous unescaped '|'.
            let mut start = at;
            while start > 0 && !(units[start - 1] == b'|' as u16 && (start < 2 || units[start - 2] != b'\\' as u16)) {
                if units[start - 1] == b'\n' as u16 {
                    break;
                }
                start -= 1;
            }
            let shown = String::from_utf16_lossy(&units[start..at]);
            let shown = shown.strip_prefix(' ').unwrap_or(&shown).to_owned();
            let raw = unescape_cell(&shown);
            if Self::LENGTHS.contains(&utf16_len(&raw)) {
                self.0.insert(raw);
                self.0.insert(shown);
            }
            at += mark.len();
        }
    }
    pub fn contains(&self, value: &str) -> bool {
        self.0.contains(value)
    }
}

/// A Markdown table cell as the value it shows (backslash escapes removed).
fn unescape_cell(cell: &str) -> String {
    let mut out = String::new();
    let mut chars = cell.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(next) = chars.peek()
            && next.is_ascii_punctuation()
        {
            out.push(*next);
            chars.next();
            continue;
        }
        out.push(c);
    }
    out
}

/// What one tool run changes in the conversation once the batch is done.
pub enum Effect {
    None,
    /// Rows to store under a new step; `signature` identifies the call.
    Stored { result: StoredResult, signature: String },
    /// A failed run; it still takes a step number in the trace.
    Failed { signature: String },
    /// A loop-guard refusal (the same run again): told to the model only.
    /// It is not a query failure, so it takes no step and stays out of the
    /// chat_log `steps[].error` count of failed questions.
    Refused,
}

/// The outcome of one knowledge/method/query tool call.
pub struct Run {
    pub result: Result<Value>,
    pub effect: Effect,
    /// search: hits per target (null when the search could not run) and
    /// the targets that could not run.
    pub hits: Option<(Value, Vec<String>)>,
    /// query_run: the public message of a failure (safe for the screen).
    pub public_error: Option<String>,
}
impl Run {
    fn plain(result: Result<Value>) -> Self {
        Self {
            result,
            effect: Effect::None,
            hits: None,
            public_error: None,
        }
    }
}

/// Read access to the conversation for a batch of calls.
pub struct Context<'a> {
    pub app: &'a Arc<App>,
    pub config: &'a Config,
    pub cancel: &'a CancellationToken,
    pub results: &'a BTreeMap<u64, StoredResult>,
    pub executed: &'a HashMap<String, u64>,
    pub clipped: &'a Clipped,
    pub result_tokens: usize,
}

pub async fn run(cx: &Context<'_>, name: &str, args: &Value) -> Run {
    match name {
        "search" => search_tool(cx, args).await,
        "knowledge_read" => Run::plain(knowledge_read(cx, args).await),
        "method_read" => Run::plain(method_read(cx, args).await),
        "query_describe" => Run::plain(query_describe(cx, args).await),
        "query_run" => query_run(cx, args).await,
        "result_read" => Run::plain(result_read(cx, args)),
        _ => Run::plain(Err(anyhow::anyhow!("unsupported_tool: {name}"))),
    }
}

fn limit_arg(args: &Value, key: &str, default: usize, max: usize) -> usize {
    args[key].as_u64().map_or(default, |n| (n as usize).clamp(1, max))
}

fn excerpt(text: &str, max: usize) -> String {
    clip_marked(js_trim(&crate::text::single_line(text)), max)
}

/// A registered query as search and method results list it.
fn query_summary(row: &Row) -> Value {
    let mut item = json!({
        "name":db::text(row, "query_name"),
        "type":db::text(row, "query_type"),
        "description":excerpt(&db::text(row, "query_desc"), 300),
        "inputs":input_bind_names(&db::text(row, "query_type"), &db::text(row, "query_sql"), &db::text(row, "bind_config")),
        "target_dbs":target_db_names(&db::text(row, "target_db_name")),
    });
    let input_desc = db::text(row, "input_desc");
    if !input_desc.trim().is_empty() {
        item["input_desc"] = json!(excerpt(&input_desc, 300));
    }
    item
}

/// One target's vector results as listed, with each one's seq and distance.
struct VectorList {
    items: Vec<Value>,
    near: Vec<(i64, f64)>,
    more: bool,
    beyond: usize,
}

async fn vector_list(cx: &Context<'_>, target: &str, vector: &[f32], offset: usize, limit: usize) -> Result<VectorList> {
    let config = cx.config;
    if target == "knowledge" {
        let page = search::knowledge(&cx.app.db, config, vector, offset, limit).await?;
        return Ok(VectorList {
            items: page
                .items
                .iter()
                .map(|d| {
                    json!({
                        "id":format!("k{}", d.doc_seq),"title":d.title,"chunk_of":d.chunk_of,
                        "matched_chunks":chunk_list(&d.chunks),"best_chunk":d.best_chunk,
                        "distance":round(d.distance),"excerpt":excerpt(&d.excerpt, 300)
                    })
                })
                .collect(),
            near: page.items.iter().map(|d| (d.doc_seq, d.distance)).collect(),
            more: page.more,
            beyond: page.beyond_threshold,
        });
    }
    let table = if target == "qa_method" { "qa_method" } else { "query_registry" };
    let page = search::rows(&cx.app.db, config, table, vector, offset, limit).await?;
    Ok(VectorList {
        items: page
            .items
            .iter()
            .map(|r| {
                let distance = round(db::float(r, "_dist"));
                if target == "qa_method" {
                    json!({
                        "id":format!("m{}", db::int(r, "seq")),"title":db::text(r, "title"),
                        "distance":distance,"excerpt":excerpt(&db::text(r, "method"), 300)
                    })
                } else {
                    let mut item = query_summary(r);
                    item["distance"] = json!(distance);
                    item
                }
            })
            .collect(),
        near: page.items.iter().map(|r| (db::int(r, "seq"), db::float(r, "_dist"))).collect(),
        more: page.more,
        beyond: page.beyond_threshold,
    })
}

/// A title match as search lists it.
fn title_item(target: &str, row: &Row) -> Value {
    let matched = row.get("_matched").cloned().unwrap_or_else(|| json!([]));
    let head = excerpt(&db::text(row, "_head"), 300);
    match target {
        "knowledge" => {
            let chunk_of = match row.get("chunk_of") {
                Some(Value::Number(_)) => db::int(row, "chunk_of"),
                _ => crate::chunk::split_content(&db::text(row, "_whole")).len() as i64,
            };
            json!({
                "id":format!("k{}", db::int(row, "seq")),"title":db::text(row, "title"),"chunk_of":chunk_of,
                "title_match":true,"matched_words":matched,"excerpt":head
            })
        }
        "qa_method" => json!({
            "id":format!("m{}", db::int(row, "seq")),"title":db::text(row, "title"),
            "title_match":true,"matched_words":matched,"excerpt":head
        }),
        _ => {
            let mut item = query_summary(row);
            item["title_match"] = json!(true);
            item["matched_words"] = matched;
            item
        }
    }
}

/// What identifies an item of a target: the ID, or the query name as
/// `name_key` compares it.
fn item_key(item: &Value) -> String {
    match item["id"].as_str() {
        Some(id) => id.to_owned(),
        None => name_key(item["name"].as_str().unwrap_or("")),
    }
}

/// Title matches a first page holds: fewer than `limit` while the vector
/// search runs, so a vector result keeps a place and `next_offset` never
/// names this same call again.
fn title_slots(offset: usize, limit: usize, vector_runs: bool) -> usize {
    match (offset, vector_runs) {
        (0, true) => search::TITLE_MAX.min(limit - 1),
        (0, false) => search::TITLE_MAX.min(limit),
        _ => 0,
    }
}

/// A page of one target: the first `slots` title matches (with the vector
/// result's fields when the vector search found them too), then the vector
/// results not among them in the places left. `next_offset` goes on after
/// the last vector result looked at; one shown as a title match counts as
/// looked at. A last page has no place to keep for the vector results: the
/// title matches held back fill it.
fn merge_page(mut titles: Vec<Value>, slots: usize, vector: &[Value], offset: usize, limit: usize, more: bool) -> (Vec<Value>, Option<usize>) {
    let as_title = |title: Value| match vector.iter().find(|v| item_key(v) == item_key(&title)) {
        Some(found) => {
            let mut item = found.clone();
            item["title_match"] = json!(true);
            item["matched_words"] = title["matched_words"].clone();
            item
        }
        None => title,
    };
    let held = titles.split_off(slots.min(titles.len()));
    let mut items: Vec<Value> = titles.into_iter().map(as_title).collect();
    let shown: BTreeSet<String> = items.iter().map(item_key).collect();
    let room = limit.saturating_sub(items.len());
    let (mut looked, mut taken) = (0, 0);
    while let Some(item) = vector.get(looked) {
        let already = shown.contains(&item_key(item));
        if !already && taken == room {
            break;
        }
        looked += 1;
        if !already {
            items.push(item.clone());
            taken += 1;
        }
    }
    let next = if looked < vector.len() { Some(offset + looked) } else { more.then_some(offset + limit) };
    if next.is_none() {
        for title in held {
            match items.iter().position(|i| item_key(i) == item_key(&title)) {
                Some(at) => {
                    items[at]["title_match"] = json!(true);
                    items[at]["matched_words"] = title["matched_words"].clone();
                }
                None if items.len() < limit => items.push(as_title(title)),
                None => {}
            }
        }
    }
    (items, next)
}

async fn search_tool(cx: &Context<'_>, args: &Value) -> Run {
    let text = js_trim(args["query"].as_str().unwrap_or("")).to_owned();
    if text.is_empty() {
        return Run::plain(Err(anyhow::anyhow!("missing_argument: query must name what to find")));
    }
    let text = clip_utf16(&text, 500).to_owned();
    let mut targets: Vec<String> = args["targets"]
        .as_array()
        .map(|t| t.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    targets.retain(|t| matches!(t.as_str(), "knowledge" | "qa_method" | "query"));
    if targets.is_empty() {
        targets = vec!["knowledge".into(), "qa_method".into(), "query".into()];
    }
    let limit = limit_arg(args, "limit", SEARCH_DEFAULT, SEARCH_MAX);
    let offset = args["offset"].as_u64().unwrap_or(0).min(MAX_OFFSET) as usize;
    let config = cx.config;
    let vector = if config.embedding.enabled() {
        match cx.app.embeddings.embed(&config.embedding, &text, cx.cancel).await {
            Ok(v) => Ok(v),
            Err(e) => {
                eprintln!("[search] embedding failed — vector search unavailable: {e}");
                Err(format!("임베딩 서버 응답 없음: {}", clip_utf16(&e.message, 200)))
            }
        }
    } else {
        Err("임베딩 주소가 설정되지 않아 의미 검색을 쓸 수 없음".into())
    };
    let mut results = Map::new();
    let mut hits = json!({});
    let mut failed = vec![];
    for target in &targets {
        // An exact query name comes before the page, outside its places.
        let mut exact: Vec<Value> = vec![];
        if target == "query" && offset == 0 && utf16_len(&text) <= 200 {
            match db::queries_by_names(&cx.app.db, &config.mariadb, std::slice::from_ref(&text)).await {
                Ok(rows) => {
                    for row in rows {
                        let mut item = query_summary(&row);
                        item["exact"] = json!(true);
                        exact.push(item);
                    }
                }
                Err(e) => eprintln!("[search] exact query lookup failed: {e}"),
            }
        }
        let listed: std::result::Result<VectorList, String> = match &vector {
            Err(reason) => Err(reason.clone()),
            Ok(v) => vector_list(cx, target, v, offset, limit)
                .await
                .map_err(|e| format!("벡터 검색 실패: {}", clip_utf16(&e.to_string(), 200))),
        };
        let slots = title_slots(offset, limit, listed.is_ok());
        let source = match target.as_str() {
            "knowledge" => &search::KNOWLEDGE_TITLES,
            "qa_method" => &search::METHOD_TITLES,
            _ => &search::QUERY_TEXTS,
        };
        let near = listed.as_ref().map(|l| l.near.clone()).unwrap_or_default();
        let titles = if slots == 0 {
            search::TitleMatches::default()
        } else {
            let wanted = title_slots(offset, limit, false) + exact.len();
            match search::title_matches(&cx.app.db, &config.mariadb, source, &text, &near, wanted).await {
                Ok(found) => found,
                Err(e) => {
                    eprintln!("[search] title match failed on {target}: {e}");
                    search::TitleMatches::default()
                }
            }
        };
        let exact_keys: BTreeSet<String> = exact.iter().map(item_key).collect();
        let mut title_items: Vec<Value> = titles.rows.iter().map(|r| title_item(target, r)).collect();
        let found_titles = title_items.len();
        title_items.retain(|i| !exact_keys.contains(&item_key(i)));
        let title_total = titles.total.saturating_sub(found_titles - title_items.len());
        title_items.truncate(title_slots(offset, limit, false));
        let outcome: std::result::Result<Value, String> = match listed {
            Ok(list) => {
                let vector_items: Vec<Value> = list.items.into_iter().filter(|i| !exact_keys.contains(&item_key(i))).collect();
                let (page, next) = merge_page(title_items, slots, &vector_items, offset, limit, list.more);
                let mut items = exact;
                items.extend(page);
                let mut out = json!({"next_offset":next,"beyond_threshold":list.beyond});
                out["items"] = json!(items);
                Ok(out)
            }
            Err(reason) if exact.is_empty() && title_items.is_empty() => Err(reason),
            Err(reason) => {
                let found = if target == "query" { "이름이 정확히 맞거나 이름·설명에 낱말이 든 쿼리만" } else { "제목에 낱말이 든 항목만" };
                let mut items = exact;
                items.extend(title_items);
                Ok(json!({"items":items,"note":format!("{found} 찾았다 ({reason})")}))
            }
        };
        let hit_key = match target.as_str() {
            "knowledge" => "knowledge",
            "qa_method" => "qaMethods",
            _ => "queries",
        };
        match outcome {
            Ok(mut value) => {
                let count = value["items"].as_array().map_or(0, Vec::len);
                hits[hit_key] = json!(count);
                value["status"] = json!("ok");
                if title_total > 0 {
                    value["title_matches"] = json!(title_total);
                    let shown = value["items"].as_array().map_or(0, |i| i.iter().filter(|i| i["title_match"] == true).count());
                    if title_total > shown {
                        let place = if target == "query" { "이름·설명" } else { "제목" };
                        let narrow = format!("{place}에 낱말이 맞는 항목 {title_total}건 중 {shown}건만 실었다. 낱말을 더 붙이면 좁혀진다.");
                        value["note"] = json!(match value["note"].as_str() {
                            Some(note) => format!("{note} {narrow}"),
                            None => narrow,
                        });
                    }
                }
                if count == 0 {
                    value["note"] = json!("관련 항목이 없다. 검색어를 바꿔 볼 수 있다.");
                }
                results.insert(target.clone(), value);
            }
            Err(reason) => {
                hits[hit_key] = Value::Null;
                failed.push(target.clone());
                results.insert(target.clone(), json!({"status":"search_unavailable","reason":reason}));
            }
        }
    }
    let mut data = json!({"text":text,"limit":limit,"offset":offset,"results":results});
    fit_search(&mut data, cx.result_tokens, &config.llm.model);
    Run {
        result: Ok(data),
        effect: Effect::None,
        hits: Some((hits, failed)),
        public_error: None,
    }
}

/// Fits a search result to the result budget: shorter excerpts first, then
/// fewer items (the continuation offset follows what was kept), so the list
/// reaches the model instead of an archive pointer. The tool message is
/// measured as the model receives it, as `bound_result` measures it.
pub(crate) fn fit_search(data: &mut Value, budget: usize, model: &str) {
    let size = |d: &Value| crate::tools::message_tokens(&crate::tools::envelope(Ok(d.clone())), model);
    let fits = |d: &Value| size(d) <= budget;
    if fits(data) {
        return;
    }
    let offset = data["offset"].as_u64().unwrap_or(0);
    for max in [150usize, 60, 0] {
        if let Some(targets) = data["results"].as_object_mut() {
            for target in targets.values_mut() {
                for item in target["items"].as_array_mut().into_iter().flatten() {
                    let shortened = item["excerpt"].as_str().map(|e| {
                        let e = e.strip_suffix(TRUNC_MARK).unwrap_or(e);
                        clip_marked(e, max)
                    });
                    match shortened {
                        Some(_) if max == 0 => {
                            if let Some(fields) = item.as_object_mut() {
                                fields.remove("excerpt");
                            }
                        }
                        Some(e) => item["excerpt"] = json!(e),
                        None => {}
                    }
                }
            }
        }
        data["excerpts_shortened"] = json!(true);
        if fits(data) {
            return;
        }
    }
    // Items leave from the longest list until their own size covers the
    // excess; the whole message is measured again after each round.
    loop {
        let excess = size(data).saturating_sub(budget);
        if excess == 0 {
            return;
        }
        let mut freed = 0;
        while freed < excess {
            let Some(targets) = data["results"].as_object_mut() else {
                return;
            };
            let longest = targets
                .iter()
                .filter_map(|(k, v)| v["items"].as_array().map(|items| (k.clone(), items.len())))
                .filter(|(_, n)| *n > 1)
                .max_by_key(|(_, n)| *n);
            let Some((key, _)) = longest else {
                return;
            };
            let target = &mut targets[&key];
            let items = target["items"].as_array_mut().unwrap();
            if let Some(item) = items.pop() {
                freed += crate::context::tokens(&item.to_string(), model).max(1);
            }
            // An exact query name or a title match comes before the page and
            // is none of its positions: counted, the page would go on past a
            // result unseen.
            let kept = items.iter().filter(|item| item["exact"] != true && item["title_match"] != true).count() as u64;
            target["next_offset"] = json!(offset + kept);
            target["items_cut_for_size"] = json!(true);
        }
    }
}

fn round(d: f64) -> f64 {
    (d * 1000.0).round() / 1000.0
}

/// "3-5, 9" from sorted chunk numbers.
fn chunk_list(chunks: &[i64]) -> String {
    let mut parts: Vec<String> = vec![];
    let mut i = 0;
    while i < chunks.len() {
        let start = chunks[i];
        let mut end = start;
        while i + 1 < chunks.len() && chunks[i + 1] == end + 1 {
            i += 1;
            end = chunks[i];
        }
        parts.push(if start == end { start.to_string() } else { format!("{start}-{end}") });
        i += 1;
    }
    parts.join(", ")
}

fn item_number(id: &str, prefix: char) -> Option<i64> {
    let id = js_trim(id);
    let digits = id.strip_prefix(prefix).or_else(|| id.strip_prefix(prefix.to_ascii_uppercase())).unwrap_or(id);
    digits.parse::<i64>().ok().filter(|n| *n > 0)
}

async fn knowledge_read(cx: &Context<'_>, args: &Value) -> Result<Value> {
    let (doc, cursor_start) = match args["cursor"].as_str() {
        Some(cursor) => {
            let (id, start) = cursor
                .split_once(':')
                .ok_or_else(|| anyhow::anyhow!("invalid_cursor: copy next_cursor exactly"))?;
            (
                item_number(id, 'k').ok_or_else(|| anyhow::anyhow!("invalid_cursor: copy next_cursor exactly"))?,
                start.parse::<i64>().ok(),
            )
        }
        None => {
            let id = args["id"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing_argument: id (k<number> from search) or cursor"))?;
            (
                item_number(id, 'k').ok_or_else(|| {
                    anyhow::anyhow!("unknown_item: {id:?} is not a knowledge ID; copy an id such as k12 from search results")
                })?,
                None,
            )
        }
    };
    let max_chunks = limit_arg(args, "max_chunks", CHUNKS_MAX, CHUNKS_MAX) as i64;
    let start = args["start_chunk"]
        .as_i64()
        .or(cursor_start)
        .unwrap_or(1)
        .clamp(1, MAX_OFFSET as i64);
    let cfg = &cx.config.mariadb;
    let rows = cx
        .app
        .db
        .query(
            cfg,
            "SELECT chunk_no, chunk_of, title, content FROM knowledge_chunk WHERE doc_seq = ? AND chunk_no BETWEEN ? AND ? ORDER BY chunk_no",
            vec![n(doc), n(start), n(start + max_chunks - 1)],
        )
        .await?;
    let model = cx.config.llm.model.as_str();
    let budget = cx.result_tokens;
    if rows.is_empty() {
        // Not chunked yet (the sync runs every minute): read the document.
        let doc_rows = cx
            .app
            .db
            .query(cfg, "SELECT title, content FROM knowledge WHERE seq = ?", vec![n(doc)])
            .await?;
        let Some(row) = doc_rows.first() else {
            bail!("unknown_item: knowledge k{doc} does not exist; search again for current IDs");
        };
        let chunk_count: i64 = cx
            .app
            .db
            .query(cfg, "SELECT COUNT(*) AS n FROM knowledge_chunk WHERE doc_seq = ?", vec![n(doc)])
            .await?
            .first()
            .map_or(0, |r| db::int(r, "n"));
        if chunk_count > 0 {
            bail!("invalid_argument_value: start_chunk {start} is past the end of k{doc} ({chunk_count} chunks)");
        }
        let parts = crate::chunk::split_content(&db::text(row, "content"));
        let total = parts.len() as i64;
        if start > total {
            bail!("invalid_argument_value: start_chunk {start} is past the end of k{doc} ({total} chunks)");
        }
        let chunks: Vec<(i64, String)> = parts
            .into_iter()
            .enumerate()
            .map(|(i, c)| (i as i64 + 1, c))
            .filter(|(no, _)| *no >= start && *no < start + max_chunks)
            .collect();
        return Ok(fit_chunks(doc, &db::text(row, "title"), total, chunks, budget, model));
    }
    let total = db::int(&rows[0], "chunk_of");
    let title = db::text(&rows[0], "title");
    let chunks: Vec<(i64, String)> = rows
        .iter()
        .map(|r| (db::int(r, "chunk_no"), db::text(r, "content")))
        .collect();
    Ok(fit_chunks(doc, &title, total, chunks, budget, model))
}

/// As many whole chunks as fit the result budget, measured as the tool
/// message the model receives (at least one, cut when it alone is larger).
fn fit_chunks(doc: i64, title: &str, total: i64, chunks: Vec<(i64, String)>, budget: usize, model: &str) -> Value {
    let first = chunks.first().map_or(1, |c| c.0);
    // `ends`: where each chunk taken ends in `text`, so a cut beside other
    // results keeps whole chunks (`tools::bound_result`); the model does not
    // see them (`tools::model_result`).
    let build = |taken: usize, (text, ends): (String, Vec<usize>)| {
        let last = chunks.get(taken.saturating_sub(1)).map_or(first, |c| c.0);
        let mut out = json!({
            "id":format!("k{doc}"),"title":title,"chunk_of":total,
            "chunks":if first == last { first.to_string() } else { format!("{first}-{last}") },
            "text":text
        });
        if !ends.is_empty() {
            out["chunk_ends"] = json!(chunks.iter().zip(ends).map(|((no, _), end)| json!([no, end])).collect::<Vec<_>>());
        }
        if last < total {
            out["next_cursor"] = json!(format!("k{doc}:{}", last + 1));
        } else {
            out["complete_to_end"] = json!(true);
        }
        out
    };
    let size = |out: &Value| crate::tools::message_tokens(&crate::tools::envelope(Ok(out.clone())), model);
    let join = |taken: usize| crate::chunk::join_chunks_with_ends(chunks[..taken].iter().map(|(no, c)| (*no, c.as_str())));
    // Each chunk counted once, without the overlap the join removes, to
    // choose how many; the joined message is then measured, and chunks leave
    // from the end until it fits.
    if chunks.is_empty() {
        return build(0, Default::default());
    }
    // Chunks past the budget are not counted: a long document fetches many.
    let mut sizes: Vec<usize> = vec![];
    let mut sum = size(&build(0, Default::default()));
    for (i, (no, content)) in chunks.iter().enumerate() {
        let added = match i.checked_sub(1).map(|p| &chunks[p]) {
            Some((before, previous)) if *before == no - 1 => {
                crate::context::tokens(&crate::chunk::cut_seam(previous, content), model)
            }
            _ => crate::context::tokens(content, model),
        };
        if i > 0 && sum + added > budget {
            break;
        }
        sum += added;
        sizes.push(added);
    }
    let mut taken = sizes.len();
    let fitted = loop {
        let out = build(taken, join(taken));
        let excess = size(&out).saturating_sub(budget);
        if excess == 0 {
            break Some(out);
        }
        if taken == 1 {
            break None;
        }
        let mut freed = 0;
        while taken > 1 && freed < excess {
            taken -= 1;
            freed += sizes[taken].max(1);
        }
    };
    if let Some(mut out) = fitted {
        // Chunks counted apart are not their joined count: one more may fit.
        while taken < chunks.len() {
            let bigger = build(taken + 1, join(taken + 1));
            if size(&bigger) > budget {
                break;
            }
            taken += 1;
            out = bigger;
        }
        return out;
    }
    // One chunk larger than the budget: its start.
    let (whole, _) = join(1);
    let mut room = budget.saturating_sub(size(&build(1, Default::default())));
    loop {
        let (head, _) = crate::context::truncate(&whole, room, model);
        let text = head + TRUNC_MARK;
        let end = text.chars().count();
        let out = build(1, (text, vec![end]));
        if room == 0 || size(&out) <= budget {
            return out;
        }
        room = room * 9 / 10;
    }
}

async fn method_read(cx: &Context<'_>, args: &Value) -> Result<Value> {
    let ids: Vec<String> = args["ids"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    let seqs: Vec<i64> = ids.iter().filter_map(|id| item_number(id, 'm')).collect();
    let missing: Vec<&String> = ids.iter().filter(|id| item_number(id, 'm').is_none()).collect();
    if seqs.is_empty() {
        bail!("unknown_item: ids must be Q&A method IDs such as m3 from search results");
    }
    let cfg = &cx.config.mariadb;
    let rows = cx
        .app
        .db
        .query(
            cfg,
            &format!("SELECT seq, title, method FROM qa_method WHERE seq IN ({})", marks(seqs.len())),
            seqs.iter().map(|s| n(*s)).collect(),
        )
        .await?;
    let mut items = vec![];
    let mut found = BTreeSet::new();
    for seq in &seqs {
        let Some(row) = rows.iter().find(|r| db::int(r, "seq") == *seq) else {
            continue;
        };
        found.insert(*seq);
        let method = db::text(row, "method");
        let queries = db::queries_mentioned_in(&cx.app.db, cfg, &method, 20).await?;
        items.push(json!({
            "id":format!("m{seq}"),"title":db::text(row, "title"),
            "method":method,
            "queries":queries.iter().map(query_summary).collect::<Vec<_>>()
        }));
    }
    let mut out = json!({"items":items});
    let unknown: Vec<String> = seqs
        .iter()
        .filter(|s| !found.contains(*s))
        .map(|s| format!("m{s}"))
        .chain(missing.into_iter().cloned())
        .collect();
    if !unknown.is_empty() {
        out["not_found"] = json!(unknown);
    }
    Ok(out)
}

async fn query_describe(cx: &Context<'_>, args: &Value) -> Result<Value> {
    let names: Vec<String> = args["names"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    let rows = db::queries_by_names(&cx.app.db, &cx.config.mariadb, &names).await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut item = query_summary(row);
            // Whole, as a file read is: the result limit bounds them.
            item["description"] = json!(db::text(row, "query_desc"));
            item["input_desc"] = json!(db::text(row, "input_desc"));
            item["output_desc"] = json!(db::text(row, "output_desc"));
            item["sql"] = json!(db::text(row, "query_sql"));
            let bind_config = db::text(row, "bind_config");
            if !bind_config.trim().is_empty() {
                item["bind_config"] = json!(bind_config);
            }
            item
        })
        .collect();
    let found: BTreeSet<String> = rows.iter().map(|r| name_key(&db::text(r, "query_name"))).collect();
    let mut out = json!({"items":items});
    let missing: Vec<&String> = names.iter().filter(|n| !found.contains(&name_key(n))).collect();
    if !missing.is_empty() {
        out["not_found"] = json!(missing);
        out["guidance"] = json!("등록되지 않은 이름이다. search(targets:[\"query\"])로 등록된 쿼리를 찾아라.");
    }
    Ok(out)
}

/// The params as executed: keys without a leading colon, at most 20.
pub fn clean_params(args: &Value) -> Map<String, Value> {
    args["params"]
        .as_object()
        .map(|params| {
            params
                .iter()
                .map(|(k, v)| (k.trim().trim_start_matches(':').to_owned(), v.clone()))
                .filter(|(k, _)| !k.is_empty() && k.chars().count() <= crate::sql::MAX_BIND_NAME_LEN)
                .take(20)
                .collect()
        })
        .unwrap_or_default()
}

/// Identity of a run for refusing an identical repeat.
pub fn run_signature(query_name: &str, target: Option<&str>, params: &Map<String, Value>) -> String {
    let sorted: BTreeMap<String, &Value> = params.iter().map(|(k, v)| (name_key(k), v)).collect();
    json!([name_key(query_name), target.map(name_key), sorted]).to_string()
}

async fn query_run(cx: &Context<'_>, args: &Value) -> Run {
    let name = js_trim(args["query_name"].as_str().unwrap_or("")).to_owned();
    let params = clean_params(args);
    let chosen = args["target_db"].as_str().map(js_trim).filter(|s| !s.is_empty()).map(str::to_owned);
    let fail = |result: anyhow::Error, public: String, signature: Option<String>| Run {
        result: Err(result),
        effect: signature.map_or(Effect::None, |signature| Effect::Failed { signature }),
        hits: None,
        public_error: Some(public),
    };
    let rows = match db::queries_by_names(&cx.app.db, &cx.config.mariadb, std::slice::from_ref(&name)).await {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("[query_run] registry lookup failed: {e}");
            return fail(
                anyhow::anyhow!("database_unavailable: 관리 DB에서 쿼리를 읽지 못했다"),
                "쿼리 정보를 읽지 못했습니다.".into(),
                None,
            );
        }
    };
    let Some(row) = rows.into_iter().next() else {
        return fail(
            anyhow::anyhow!("query_not_found: 등록되지 않은 쿼리다: {}. search(targets:[\"query\"])로 등록된 이름을 찾아라", clip_utf16(&name, 100)),
            format!("등록되지 않은 쿼리입니다: {}", clip_utf16(&name, 100)),
            None,
        );
    };
    let canonical = db::text(&row, "query_name");
    let resolved = crate::oracle::resolve_target_db(&row, chosen.as_deref()).ok();
    let signature = run_signature(&canonical, resolved.as_deref().or(chosen.as_deref()), &params);
    if let Some(step) = cx.executed.get(&signature) {
        return Run {
            result: Err(anyhow::anyhow!(
                "repeated_call: 같은 쿼리를 같은 값과 대상으로 이미 실행했다 (step {step}). 그 결과를 result_read로 읽어라"
            )),
            effect: Effect::Refused,
            hits: None,
            public_error: Some("같은 조회를 이미 실행했습니다.".into()),
        };
    }
    let clipped = cx.clipped;
    let is_clipped = move |v: &str| clipped.contains(v);
    let outcome = cx
        .app
        .oracle
        .run(&cx.app.db, cx.config, &row, &params, chosen.as_deref(), &is_clipped, cx.cancel)
        .await;
    let preview = limit_arg(args, "preview_rows", PREVIEW_DEFAULT, PREVIEW_MAX);
    match outcome {
        Ok(outcome) => {
            let columns = columns_of(&outcome.rows);
            let bytes = crate::session::serialized_bytes(&outcome.rows);
            let shown: Vec<&Map<String, Value>> = outcome.rows.iter().take(preview).collect();
            let mut data = json!({
                "query_name":canonical,"target_db":outcome.target_db,"columns":columns,
                "row_count":outcome.rows.len(),"capped":outcome.capped,"rows":shown
            });
            if outcome.rows.len() > shown.len() {
                data["omitted_rows"] = json!(outcome.rows.len() - shown.len());
                data["guidance"] = json!("나머지 행은 result_read(step, offset)로 읽어라. 답변 표·차트는 step 참조로 화면이 채운다.");
            }
            if outcome.capped {
                data["capped_note"] = json!(format!("결과가 {}행을 넘어 앞 {}행만 보관했다", crate::oracle::MAX_ROWS, crate::oracle::MAX_ROWS));
            }
            if outcome.rows.is_empty() {
                data["note"] = json!("조회 결과가 0건이다.");
            }
            let result = StoredResult {
                step: 0,
                query_name: canonical,
                target_db: Some(outcome.target_db),
                params: Value::Object(params),
                rows: Arc::new(outcome.rows),
                capped: outcome.capped,
                omitted_column_key: outcome.omitted_column_key,
                bytes,
            };
            Run {
                result: Ok(data),
                effect: Effect::Stored { result, signature },
                hits: None,
                public_error: None,
            }
        }
        Err(e) if e.to_string() == "cancelled" => Run::plain(Err(e)),
        Err(e) => {
            let (public, hint, wasted) = crate::oracle::public_error(&e);
            let driver = e.downcast_ref::<crate::sql::SafeError>().is_none();
            if driver {
                eprintln!("[query_run] {canonical} failed: {e:#}");
            }
            let code = if driver {
                "query_failed"
            } else if wasted {
                "query_unrunnable"
            } else {
                "bind_value_problem"
            };
            let detail = if driver { clip_utf16(&format!("{e:#}"), 300).to_owned() } else { public.clone() };
            let hint = hint.map(|h| format!(" 대응: {h}")).unwrap_or_default();
            fail(anyhow::anyhow!("{code}: {detail}{hint}"), public, Some(signature))
        }
    }
}

/// Column names in first-seen order across rows.
pub fn columns_of(rows: &[Map<String, Value>]) -> Vec<String> {
    let mut columns: Vec<String> = vec![];
    for row in rows {
        for key in row.keys() {
            if !columns.contains(key) {
                columns.push(key.clone());
            }
        }
    }
    columns
}

fn result_read(cx: &Context<'_>, args: &Value) -> Result<Value> {
    let step = args["step"].as_u64().unwrap_or(0);
    let Some(stored) = cx.results.get(&step) else {
        bail!(
            "unknown_step: step {step}의 결과가 없다 (잘못된 번호이거나 오래되어 보관에서 빠졌다). 남아 있는 step: {}",
            cx.results.keys().map(u64::to_string).collect::<Vec<_>>().join(", ")
        );
    };
    let offset = args["offset"].as_u64().unwrap_or(0).min(MAX_OFFSET) as usize;
    let limit = limit_arg(args, "limit", READ_DEFAULT, READ_MAX);
    let all_columns = columns_of(&stored.rows);
    let wanted: Vec<String> = args["cols"]
        .as_array()
        .map(|c| c.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    let (columns, unknown): (Vec<String>, Vec<String>) = if wanted.is_empty() {
        (all_columns.clone(), vec![])
    } else {
        let mut found = vec![];
        let mut unknown = vec![];
        for w in wanted {
            match all_columns.iter().find(|c| **c == w).or_else(|| all_columns.iter().find(|c| name_key(c) == name_key(&w))) {
                Some(c) if !found.contains(c) => found.push(c.clone()),
                Some(_) => {}
                None => unknown.push(w),
            }
        }
        (found, unknown)
    };
    let rows: Vec<Map<String, Value>> = stored
        .rows
        .iter()
        .skip(offset)
        .take(limit)
        .map(|row| {
            columns
                .iter()
                .map(|c| (c.clone(), row.get(c).cloned().unwrap_or(Value::Null)))
                .collect()
        })
        .collect();
    let end = offset + rows.len();
    let mut out = json!({
        "step":step,"query_name":stored.query_name,"total_rows":stored.rows.len(),"capped":stored.capped,
        "offset":offset,"columns":columns,"rows":rows,
        "next_offset":(end < stored.rows.len()).then_some(end)
    });
    if !unknown.is_empty() {
        out["unknown_columns"] = json!(unknown);
        out["available_columns"] = json!(all_columns);
    }
    if offset > stored.rows.len() {
        out["note"] = json!(format!("offset이 전체 행 수({})를 넘는다", stored.rows.len()));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_results_shrink_to_the_budget_as_the_model_receives_them() {
        let item = |i: usize| json!({"id":format!("k{i}"),"title":"제목","excerpt":"근거 문장 ".repeat(60)});
        let base = json!({"text":"q","offset":0,"results":{
            "knowledge":{"status":"ok","items":(0..10).map(item).collect::<Vec<_>>()},
            "qa_method":{"status":"ok","items":(0..10).map(item).collect::<Vec<_>>()}
        }});
        let message = |d: &Value| crate::tools::message_tokens(&crate::tools::envelope(Ok(d.clone())), "gpt-4o");
        let mut data = base.clone();
        fit_search(&mut data, 400, "gpt-4o");
        assert!(message(&data) <= 400, "{}", message(&data));
        assert_eq!(data["excerpts_shortened"], true);
        let k = data["results"]["knowledge"]["items"].as_array().unwrap().len();
        assert!((1..10).contains(&k));
        assert_eq!(data["results"]["knowledge"]["next_offset"], k as u64);
        // A list fitted on its data alone used to cross the budget once
        // delivered and was archived anyway; now it fits as delivered.
        for budget in (400..message(&base)).step_by(397) {
            let mut data = base.clone();
            fit_search(&mut data, budget, "gpt-4o");
            let single = data["results"].as_object().unwrap().values().all(|t| t["items"].as_array().unwrap().len() <= 1);
            assert!(single || message(&data) <= budget, "{budget}: {}", message(&data));
        }
        let mut small = json!({"text":"q","offset":0,"results":{"query":{"items":[item(1)]}}});
        let before = small.clone();
        fit_search(&mut small, 4000, "gpt-4o");
        assert_eq!(small, before);
    }

    /// Random documents split as the sync splits them, read at random
    /// budgets: the delivered message stays within the budget, the text is
    /// the joined chunk range, the continuation is right, and no further
    /// whole chunk would have fitted. FIT_FUZZ sets the number of documents.
    #[test]
    fn random_documents_fit_their_budget_as_delivered() {
        let runs: usize = std::env::var("FIT_FUZZ").ok().and_then(|n| n.parse().ok()).unwrap_or(40);
        let mut seed: u64 = 0x5eed;
        let mut next = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n.max(1)
        };
        let words = ["가상계측", "배치", "재시작", "vLLM", "memory", "\"quoted\"", "back\\slash", "{ \"k\": 1 }", "`code`", "|표|", "줄\n", "\n\n", "  ", "😀", "x".repeat(40).leak() as &str];
        let message = |v: &Value| crate::tools::message_tokens(&crate::tools::envelope(Ok(v.clone())), "gpt-4o");
        let (mut maximal, mut cases) = (0, 0);
        for _ in 0..runs {
            let length = 200 + next(30_000);
            let mut doc = String::new();
            while doc.chars().count() < length {
                doc.push_str(words[next(words.len())]);
                doc.push(' ');
            }
            let parts = crate::chunk::split_content(&doc);
            let total = parts.len() as i64;
            let start = 1 + next(parts.len());
            let chunks: Vec<(i64, String)> = parts.iter().cloned().enumerate().map(|(i, c)| (i as i64 + 1, c)).skip(start - 1).collect();
            let budget = 300 + next(12_000);
            let out = fit_chunks(9, "제목", total, chunks.clone(), budget, "gpt-4o");
            assert!(message(&out) <= budget, "budget {budget}: {}", message(&out));
            let text = out["text"].as_str().unwrap();
            let range = out["chunks"].as_str().unwrap();
            let last: i64 = range.rsplit('-').next().unwrap().parse().unwrap();
            assert_eq!(range.split('-').next().unwrap().parse::<usize>().unwrap(), start);
            let taken = (last - start as i64 + 1) as usize;
            let joined = crate::chunk::join_chunks(chunks[..taken].iter().map(|(no, c)| (*no, c.as_str())));
            if let Some(head) = text.strip_suffix(TRUNC_MARK) {
                assert_eq!(taken, 1);
                assert!(joined.starts_with(head));
            } else {
                assert_eq!(text, joined);
            }
            if last < total {
                assert_eq!(out["next_cursor"], format!("k9:{}", last + 1));
            } else {
                assert_eq!(out["complete_to_end"], true);
            }
            if !text.ends_with(TRUNC_MARK) && taken < chunks.len() {
                cases += 1;
                let more = crate::chunk::join_chunks(chunks[..=taken].iter().map(|(no, c)| (*no, c.as_str())));
                let mut bigger = out.clone();
                bigger["text"] = json!(more);
                bigger["chunks"] = json!(format!("{start}-{}", last + 1));
                if last + 1 < total {
                    bigger["next_cursor"] = json!(format!("k9:{}", last + 2));
                } else {
                    bigger.as_object_mut().unwrap().remove("next_cursor");
                    bigger["complete_to_end"] = json!(true);
                }
                if message(&bigger) > budget {
                    maximal += 1;
                }
            }
        }
        assert_eq!(maximal, cases, "a whole chunk more would have fitted");
    }

    #[test]
    fn random_search_lists_fit_their_budget_as_delivered() {
        let runs: usize = std::env::var("FIT_FUZZ").ok().and_then(|n| n.parse().ok()).unwrap_or(40);
        let mut seed: u64 = 0xfeed;
        let mut next = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n.max(1)
        };
        let message = |d: &Value| crate::tools::message_tokens(&crate::tools::envelope(Ok(d.clone())), "gpt-4o");
        for _ in 0..runs {
            let mut results = Map::new();
            for target in ["knowledge", "qa_method", "query"] {
                let items: Vec<Value> = (0..next(51))
                    .map(|i| json!({"id":format!("k{i}"),"title":"제목 \"따옴표\" \\ 백슬래시","distance":0.3,"excerpt":"근거 문장 \"인용\" \\n ".repeat(next(30))}))
                    .collect();
                results.insert(target.into(), json!({"status":"ok","next_offset":null,"beyond_threshold":0,"items":items}));
            }
            let mut data = json!({"text":"q","limit":50,"offset":0,"results":results});
            let budget = 300 + next(20_000);
            fit_search(&mut data, budget, "gpt-4o");
            let single = data["results"].as_object().unwrap().values().all(|t| t["items"].as_array().unwrap().len() <= 1);
            assert!(single || message(&data) <= budget, "budget {budget}: {}", message(&data));
            for target in data["results"].as_object().unwrap().values() {
                if target["items_cut_for_size"] == true {
                    assert_eq!(target["next_offset"], target["items"].as_array().unwrap().len() as u64);
                }
            }
        }
    }

    /// Context management review, seventh pass: an exact query name comes
    /// before the page of nearest queries and is not one of its positions,
    /// but a list cut for size counted it in its next_offset, so the search
    /// continued past one query the model was never shown.
    #[test]
    fn a_cut_query_list_goes_on_after_the_last_query_it_shows() {
        let item = |name: &str| json!({"name":name,"type":"QUERY","description":"설명 ".repeat(100),"inputs":[],"target_dbs":[],"distance":0.2});
        let mut items = vec![json!({"name":"exact_q","type":"QUERY","description":"설명","inputs":[],"target_dbs":[],"exact":true})];
        items.extend((0..10).map(|i| item(&format!("near_{i}"))));
        let mut data = json!({"text":"exact_q","limit":10,"offset":0,"results":{"query":{"status":"ok","next_offset":10,"beyond_threshold":0,"items":items}}});
        fit_search(&mut data, 1_500, "gpt-4o");
        let target = &data["results"]["query"];
        let shown: Vec<&str> = target["items"].as_array().unwrap().iter().map(|i| i["name"].as_str().unwrap()).collect();
        assert!(target["items_cut_for_size"] == true && shown.len() > 1 && shown.len() < 11, "{shown:?}");
        // The page from next_offset starts at the first near query not shown.
        let near_shown = shown.iter().filter(|name| name.starts_with("near_")).count();
        assert_eq!(target["next_offset"], near_shown as u64, "{shown:?}");
    }

    fn doc(id: &str) -> Value {
        json!({"id":id,"title":id,"distance":0.3,"excerpt":"본문"})
    }
    fn title_hit(id: &str) -> Value {
        json!({"id":id,"title":id,"title_match":true,"matched_words":["낱말"],"excerpt":"제목"})
    }
    fn ids(items: &[Value]) -> Vec<&str> {
        items.iter().map(|i| i["id"].as_str().unwrap()).collect()
    }

    /// Title matches share the places of a page with the vector results,
    /// and the page goes on from the first vector result not looked at.
    #[test]
    fn title_matches_come_first_within_the_limit() {
        let vector: Vec<Value> = ["k1", "k2", "k3", "k4", "k5"].map(doc).to_vec();
        // k3 was found both ways: shown once, first, with its distance; the
        // page goes on past it.
        let (items, next) = merge_page(vec![title_hit("k3"), title_hit("k9")], 3, &vector, 0, 4, true);
        assert_eq!(ids(&items), ["k3", "k9", "k1", "k2"]);
        assert_eq!((items[0]["distance"].clone(), items[0]["title_match"].clone()), (json!(0.3), json!(true)));
        assert_eq!(next, Some(3));
        // One further down the vector list is not reached yet.
        let (items, next) = merge_page(vec![title_hit("k5")], 2, &vector, 0, 3, true);
        assert_eq!(ids(&items), ["k5", "k1", "k2"]);
        assert_eq!(next, Some(2));
        let (items, next) = merge_page(vec![title_hit("k2")], 1, &vector[..2], 0, 2, false);
        assert_eq!(ids(&items), ["k2", "k1"]);
        assert_eq!(next, None);
        // Without title matches the page is the vector page.
        let (items, next) = merge_page(vec![], 0, &vector, 10, 5, true);
        assert_eq!((ids(&items).len(), next), (5, Some(15)));
        // On a last page the matches held back fill the places left, and
        // mark the vector results they repeat.
        let titles: Vec<Value> = ["k1", "k2", "k3", "k4", "k8"].map(title_hit).to_vec();
        let (items, next) = merge_page(titles.clone(), 4, &vector[..3], 0, 5, false);
        assert_eq!((ids(&items), next), (vec!["k1", "k2", "k3", "k4", "k8"], None));
        let (items, _) = merge_page(titles[3..].to_vec(), 1, &vector[..3], 0, 5, false);
        assert_eq!(ids(&items), ["k4", "k1", "k2", "k3", "k8"]);
        let (items, next) = merge_page(titles, 4, &vector, 0, 5, true);
        assert_eq!((ids(&items), next), (vec!["k1", "k2", "k3", "k4", "k5"], Some(5)));
    }

    #[test]
    fn title_matches_leave_a_vector_place_on_first_pages_only() {
        assert_eq!(title_slots(0, 10, true), 5);
        assert_eq!(title_slots(0, 3, true), 2);
        assert_eq!(title_slots(0, 1, true), 0);
        assert_eq!(title_slots(0, 1, false), 1);
        assert_eq!(title_slots(0, 50, false), 5);
        assert_eq!(title_slots(10, 10, true), 0);
        // With a title match in every place it may take, the page still
        // goes on past the current call.
        for limit in 1..=8 {
            let titles: Vec<Value> = (0..title_slots(0, limit, true)).map(|i| title_hit(&format!("t{i}"))).collect();
            let vector: Vec<Value> = (0..limit).map(|i| doc(&format!("k{i}"))).collect();
            let slots = titles.len();
            let (_, next) = merge_page(titles, slots, &vector, 0, limit, true);
            assert!(next.is_some_and(|n| n > 0), "limit {limit}: {next:?}");
        }
    }

    #[test]
    fn a_cut_page_does_not_count_title_matches_as_vector_places() {
        let mut items: Vec<Value> = (0..3).map(|i| title_hit(&format!("t{i}"))).collect();
        items.extend((0..7).map(|i| json!({"id":format!("k{i}"),"title":"문서","distance":0.3,"excerpt":"본문 ".repeat(100)})));
        let mut data = json!({"text":"낱말","limit":10,"offset":0,"results":{"knowledge":{"status":"ok","next_offset":7,"beyond_threshold":0,"items":items}}});
        fit_search(&mut data, 300, "gpt-4o");
        let target = &data["results"]["knowledge"];
        let shown = target["items"].as_array().unwrap();
        assert!(target["items_cut_for_size"] == true && shown.len() < 10, "{target}");
        let vector_shown = shown.iter().filter(|i| i["title_match"] != true).count();
        assert!(vector_shown > 0 && shown.len() - vector_shown == 3, "{target}");
        assert_eq!(target["next_offset"], vector_shown as u64, "{target}");
    }

    #[test]
    fn chunk_lists_compress_runs() {
        assert_eq!(chunk_list(&[1, 2, 3, 5, 7, 8]), "1-3, 5, 7-8");
        assert_eq!(item_number("k12", 'k'), Some(12));
        assert_eq!(item_number("K12", 'k'), Some(12));
        assert_eq!(item_number("12", 'k'), Some(12));
        assert_eq!(item_number("m3", 'k'), None);
    }

    #[test]
    fn params_and_signatures_ignore_colons_case_and_order() {
        let a = clean_params(&json!({"params":{":Job_Id":"B1","x":1}}));
        let b = clean_params(&json!({"params":{"x":1,"job_id":"B1"}}));
        assert_eq!(run_signature("Q", Some("DB"), &a), run_signature("q", Some("db"), &b));
        assert_ne!(run_signature("q", Some("A"), &a), run_signature("q", Some("B"), &a));
    }

    #[test]
    fn clipped_values_are_recognized_from_rows_and_tables() {
        let mut results = BTreeMap::new();
        let long = "x".repeat(200);
        let mut row = Map::new();
        row.insert("NOTE".into(), json!(format!("{long}{TRUNC_MARK}")));
        results.insert(1, StoredResult {
            step: 1, query_name: "q".into(), target_db: None, params: json!({}),
            rows: Arc::new(vec![row]), capped: false, omitted_column_key: None, bytes: 0,
        });
        let mut clipped = Clipped::from_results(&results);
        assert!(clipped.contains(&long));
        // A driver cell cut at its limit and quoted in an answer.
        let quoted = "q".repeat(crate::oracle::MAX_CELL_LEN);
        clipped.learn_text(&format!("비고: {quoted}{TRUNC_MARK} 입니다"));
        assert!(clipped.contains(&quoted));
        let cell = "a\\|b".to_owned() + &"c".repeat(116);
        clipped.learn_text(&format!("| ID | {cell}{TRUNC_MARK} |"));
        assert!(clipped.contains(&("a|b".to_owned() + &"c".repeat(116))));
        assert!(!clipped.contains("BATCH001"));
    }

    #[test]
    fn documents_arrive_whole_or_in_whole_chunks_within_the_budget() {
        let chunks = |n: i64| (1..=n).map(|i| (i, format!("{i}번 ").repeat(200))).collect::<Vec<_>>();
        let message = |v: &Value| crate::tools::message_tokens(&crate::tools::envelope(Ok(v.clone())), "gpt-4o");
        let whole = fit_chunks(7, "제목", 4, chunks(4), 25_000, "gpt-4o");
        assert_eq!((whole["chunks"].clone(), whole["complete_to_end"].clone()), (json!("1-4"), json!(true)));
        let part = fit_chunks(7, "제목", 9, chunks(9), 1_500, "gpt-4o");
        assert!(part["next_cursor"].as_str().unwrap().starts_with("k7:"), "{part}");
        assert!(message(&part) <= 1_500, "{}", message(&part));
        assert!(!part["text"].as_str().unwrap().ends_with(TRUNC_MARK));
        // One chunk larger than the budget shows its start.
        let cut = fit_chunks(7, "제목", 9, chunks(9), 400, "gpt-4o");
        assert_eq!(cut["chunks"], "1");
        assert!(cut["text"].as_str().unwrap().ends_with(TRUNC_MARK));
        assert!(message(&cut) <= 400, "{}", message(&cut));
    }

    // Context management review, sixth pass (2026-10-16): results cut beside
    // the other results of their response (`fit_batch`) kept their own
    // shape and continuation. Each failed before its fix.

    fn workspace() -> crate::tools::Workspace {
        crate::tools::Workspace {
            project: Default::default(),
            config: crate::tools::ToolConfig { model: "gpt-4o".into(), result_tokens: 25_000, tool_timeout_secs: 30 },
            file_cursors: Default::default(),
            list_cursor_scopes: Default::default(),
            history: Default::default(),
        }
    }
    fn tool_call(name: &str) -> crate::llm::ToolCall {
        crate::llm::ToolCall { id: "c1".into(), name: name.into(), arguments: "{}".into() }
    }

    /// A document cut beside other results was cut inside its text: it still
    /// said it held all its chunks ("1-9") and had no next_cursor, so a
    /// continuation by chunk number skipped what was cut.
    #[test]
    fn a_document_cut_beside_other_results_keeps_whole_chunks_and_its_cursor() {
        let chunks: Vec<(i64, String)> = (1..=9).map(|i| (i, format!("{i}번 문단 ").repeat(120))).collect();
        let read = crate::tools::envelope(Ok(fit_chunks(7, "제목", 9, chunks.clone(), 25_000, "gpt-4o")));
        assert_eq!(read["data"]["complete_to_end"], true);
        let call = tool_call("knowledge_read");
        let args = json!({"id":"k7"});
        let full = crate::tools::result_tokens(&call, &read, "gpt-4o");
        let mut ws = workspace();
        for limit in [full / 2, full / 4] {
            let cut = crate::tools::bound_result(&mut ws, &call, &args, read.clone(), limit);
            assert!(crate::tools::result_tokens(&call, &cut, "gpt-4o") <= limit, "{cut}");
            let data = &cut["data"];
            let last: usize = data["chunks"].as_str().unwrap().rsplit('-').next().unwrap().parse().unwrap();
            assert!((1..9).contains(&last), "{cut}");
            assert_eq!(data["chunks"], format!("1-{last}"));
            let joined = crate::chunk::join_chunks(chunks[..last].iter().map(|(no, c)| (*no, c.as_str())));
            assert_eq!(data["text"], joined);
            assert_eq!(data["next_cursor"], format!("k7:{}", last + 1));
            assert!(data.get("complete_to_end").is_none(), "{cut}");
        }
        // Too small for one chunk: nothing of it, read again from its start.
        let none = crate::tools::bound_result(&mut ws, &call, &args, read.clone(), 200);
        assert_eq!((none["data"]["text"].clone(), none["data"]["next_cursor"].clone()), (json!(""), json!("k7:1")), "{none}");
        // The knowledge itself holds the rest: nothing was archived, and the
        // chunk bookkeeping stays off the model's view.
        assert!(ws.history.bundles.is_empty() && none.get("archive_id").is_none());
        assert!(crate::tools::model_result(&read)["data"].get("chunk_ends").is_none());
    }

    /// A search cut beside other results was archived whole, its list shown
    /// as the start of its JSON text, though a search fits itself.
    #[test]
    fn a_search_cut_beside_other_results_still_fits_itself() {
        let item = |i: usize| json!({"id":format!("k{i}"),"title":"제목","excerpt":"근거 문장 ".repeat(60)});
        let data = json!({"text":"q","limit":10,"offset":0,"results":{"knowledge":{"status":"ok","items":(0..10).map(item).collect::<Vec<_>>()}}});
        let result = crate::tools::envelope(Ok(data));
        let call = tool_call("search");
        let limit = crate::tools::result_tokens(&call, &result, "gpt-4o") / 3;
        let mut ws = workspace();
        let cut = crate::tools::bound_result(&mut ws, &call, &json!({"query":"q"}), result, limit);
        assert!(crate::tools::result_tokens(&call, &cut, "gpt-4o") <= limit, "{cut}");
        let items = cut["data"]["results"]["knowledge"]["items"].as_array().expect("still a list");
        assert!(!items.is_empty(), "{cut}");
        assert!(ws.history.bundles.is_empty() && cut.get("archive_id").is_none(), "{cut}");
    }

    /// Query rows cut for size kept the count of rows past the preview, so
    /// the rows cut from the preview itself were nowhere to be read from.
    #[test]
    fn cut_query_rows_say_where_the_unseen_rows_start() {
        let rows: Vec<Value> = (0..20).map(|i| json!({"ID":i,"NOTE":"가나다 ".repeat(40)})).collect();
        let data = json!({"step":3,"query_name":"q","target_db":"DB","columns":["ID","NOTE"],"row_count":100,"capped":false,"rows":rows,
            "omitted_rows":80,"guidance":"나머지 행은 result_read(step, offset)로 읽어라."});
        let result = crate::tools::envelope(Ok(data));
        let call = tool_call("query_run");
        let limit = crate::tools::result_tokens(&call, &result, "gpt-4o") / 3;
        let cut = crate::tools::bound_result(&mut workspace(), &call, &json!({"query_name":"q"}), result, limit);
        let shown = cut["data"]["rows"].as_array().unwrap().len();
        assert!((1..20).contains(&shown), "{cut}");
        assert_eq!(cut["data"]["omitted_rows"], 100 - shown, "{cut}");
        assert!(cut["data"]["guidance"].as_str().unwrap().contains(&format!("offset {shown}")), "{cut}");
    }

    /// Context management review, seventh pass: a result cut at the result
    /// limit and cut again beside the other results of its response said
    /// only what the second cut left out (`paths_omitted` 166 of 406), and
    /// cut query rows said two different counts of unseen rows
    /// (`rows_omitted` 55 beside `omitted_rows` 955).
    #[test]
    fn a_result_cut_twice_counts_what_both_cuts_left_out() {
        let mut ws = workspace();
        let call = tool_call("file_list");
        let paths: Vec<Value> = (0..500).map(|i| json!(format!("src/module_{i}/very/long/path/name/file_{i}.rs"))).collect();
        let list = crate::tools::envelope(Ok(json!({"hash":"h","mode":"paths","total_files":2000,"paths":paths,"next_cursor":"h:500"})));
        let once = crate::tools::bound_result(&mut ws, &call, &json!({}), list, 4000);
        let twice = crate::tools::bound_result(&mut ws, &call, &json!({}), once.clone(), 1500);
        for cut in [&once, &twice] {
            let shown = cut["data"]["paths"].as_array().unwrap().len();
            assert!((1..500).contains(&shown), "{cut}");
            assert_eq!(cut["data"]["paths_omitted"], 500 - shown, "{cut}");
            assert_eq!(cut["data"]["next_cursor"], format!("h:{shown}"), "{cut}");
        }
        let call = tool_call("query_run");
        let rows: Vec<Value> = (0..100).map(|i| json!({"ID":i,"NOTE":"가나다라마바사 ".repeat(20)})).collect();
        let run = crate::tools::envelope(Ok(json!({"step":1,"query_name":"q","target_db":"DB","columns":["ID","NOTE"],"row_count":1000,"capped":false,"rows":rows,
            "omitted_rows":900,"guidance":"나머지 행은 result_read(step, offset)로 읽어라."})));
        let limit = crate::tools::result_tokens(&call, &run, "gpt-4o");
        let once = crate::tools::bound_result(&mut ws, &call, &json!({}), run, limit / 2);
        let twice = crate::tools::bound_result(&mut ws, &call, &json!({}), once.clone(), limit / 5);
        for cut in [&once, &twice] {
            let shown = cut["data"]["rows"].as_array().unwrap().len();
            assert!((1..100).contains(&shown), "{cut}");
            assert_eq!(cut["data"]["omitted_rows"], 1000 - shown, "{cut}");
            assert!(cut["data"].get("rows_omitted").is_none(), "one count of unseen rows: {cut}");
        }
    }
}
