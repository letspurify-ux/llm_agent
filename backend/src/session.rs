//! Conversations kept on the server. A conversation's history is a list of
//! bundles as in MnemoArc: one user message, or one model response with the
//! results of its tool calls. Bundles leave the model's context whole (see
//! `context::evict`), and stay readable through the `history` tool until the
//! history byte limit drops the oldest. Kept bytes are those held in memory
//! (`Held`).

use crate::shared::Shared;
use anyhow::Result;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::Arc,
    time::Instant,
};
use tokio_util::sync::CancellationToken;

/// Bytes a value holds in memory, about: its allocations as the allocator
/// rounds them, and the inline size of what they hold. The byte limits a
/// conversation keeps count these: its JSON is far smaller than what holds
/// it — query rows of short cells nine times (a column name and a map entry
/// a cell, an index a row), a history of small messages eight. Counted as
/// JSON, the 32 MiB of rows kept held about 300 MiB, a conversation.
pub trait Held {
    fn held(&self) -> usize;
}

/// An allocation of `n` bytes as the allocator gives it: in 16-byte steps,
/// glibc's with a header of 8 bytes and 32 at least.
fn allocation(n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    if cfg!(all(target_os = "linux", target_env = "gnu")) {
        (n.saturating_add(8 + 15) & !15).max(32)
    } else {
        n.saturating_add(15) & !15
    }
}

impl Held for Value {
    fn held(&self) -> usize {
        match self {
            Value::String(text) => text.held(),
            Value::Array(items) => items.held(),
            Value::Object(fields) => fields.held(),
            Value::Null | Value::Bool(_) | Value::Number(_) => 0,
        }
    }
}

impl Held for String {
    fn held(&self) -> usize {
        allocation(self.capacity())
    }
}

impl<T: Held> Held for Vec<T> {
    fn held(&self) -> usize {
        self.iter().fold(allocation(self.capacity() * std::mem::size_of::<T>()), |total, item| total.saturating_add(item.held()))
    }
}

/// An ordered map (`preserve_order`): a hash table of indices and a vector
/// of entries (hash, key, value), both grown as the table is.
impl Held for Map<String, Value> {
    fn held(&self) -> usize {
        let len = self.len();
        if len == 0 {
            return 0;
        }
        let buckets = if len < 4 {
            4
        } else if len < 8 {
            8
        } else {
            (len * 8 / 7).next_power_of_two()
        };
        let entries = if buckets < 8 { buckets - 1 } else { buckets / 8 * 7 };
        let entry = std::mem::size_of::<u64>() + std::mem::size_of::<String>() + std::mem::size_of::<Value>();
        self.iter().fold(allocation(buckets * 9 + 16) + allocation(entries * entry), |total, (key, value)| {
            total.saturating_add(key.held()).saturating_add(value.held())
        })
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Bundle {
    pub id: u64,
    pub messages: Shared<Vec<Value>>,
    /// In the model's context. Evicted bundles stay readable by the history
    /// tool until the byte limit drops them.
    pub active: bool,
    /// A bundle whose tool calls all have results (an interrupted batch is
    /// not).
    pub complete: bool,
}
impl Bundle {
    fn bytes(&self) -> usize {
        self.messages.bytes().saturating_add(64)
    }
}

#[derive(Clone, Debug, Default)]
pub struct SessionHistory {
    pub bundles: VecDeque<Bundle>,
    pub next_id: u64,
    pub pruned_through: Option<u64>,
}
impl SessionHistory {
    pub fn push(&mut self, messages: Vec<Value>, complete: bool) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        self.bundles.push_back(Bundle {
            id,
            messages: messages.into(),
            active: true,
            complete,
        });
        id
    }
    pub fn bytes(&self) -> usize {
        self.bundles
            .iter()
            .fold(0usize, |total, bundle| total.saturating_add(bundle.bytes()))
    }
    /// Messages of the bundles in the model's context, in order.
    pub fn active(&self) -> Vec<Value> {
        self.bundles
            .iter()
            .filter(|b| b.active)
            .flat_map(|b| b.messages.iter().cloned())
            .collect()
    }
    /// Drops the oldest evicted bundles until they fit `limit` bytes. Active
    /// bundles neither count nor go (the input budget bounds them), and what
    /// a result still in the context continues stays readable: the archive of
    /// a cut result, the bundle a cut history read goes on reading, and the
    /// bundles a history search in the newest bundle found, which the next
    /// response reads (a search's items are many: kept for longer, one small
    /// result could hold many large bundles past the limit).
    pub fn prune(&mut self, limit: usize) {
        let mut bytes = self
            .bundles
            .iter()
            .filter(|b| !b.active)
            .fold(0usize, |total, bundle| total.saturating_add(bundle.bytes()));
        if bytes <= limit {
            return;
        }
        let mut calls = std::collections::BTreeSet::new();
        let mut continued = std::collections::BTreeSet::new();
        let newest = self.bundles.iter().rev().find(|b| b.active).map(|b| b.id);
        for bundle in self.bundles.iter().filter(|b| b.active) {
            let searches: std::collections::BTreeSet<&str> = bundle
                .messages
                .iter()
                .filter(|_| Some(bundle.id) == newest)
                .flat_map(|m| m["tool_calls"].as_array().into_iter().flatten())
                .filter(|call| call["function"]["name"] == "history")
                .filter_map(|call| call["id"].as_str())
                .collect();
            for message in bundle.messages.iter().filter(|m| m["role"] == "tool") {
                let call = message["tool_call_id"].as_str();
                if let Some(id) = call {
                    calls.insert(id.to_owned());
                }
                let Some(result) = message["content"].as_str().and_then(|text| serde_json::from_str::<Value>(text).ok()) else {
                    continue;
                };
                continued.extend(result["archive_id"].as_u64());
                if result["next_cursor"]["tool"] == "history" {
                    continued.extend(result["next_cursor"]["id"].as_u64());
                }
                if call.is_some_and(|id| searches.contains(id)) {
                    continued.extend(result["data"]["items"].as_array().into_iter().flatten().filter_map(|item| item["id"].as_u64()));
                }
            }
        }
        let droppable = |b: &Bundle| {
            !b.active
                && !continued.contains(&b.id)
                && !b.messages.first().is_some_and(|m| {
                    m["role"] == "tool_archive" && m["call_id"].as_str().is_some_and(|id| calls.contains(id))
                })
        };
        while bytes > limit {
            let Some(index) = self.bundles.iter().position(&droppable) else {
                break;
            };
            let removed = self.bundles.remove(index).unwrap();
            bytes = bytes.saturating_sub(removed.bytes());
            self.pruned_through = Some(self.pruned_through.unwrap_or(0).max(removed.id));
        }
    }
    pub fn read(&self, id: u64) -> Result<&Bundle> {
        self.bundles.iter().find(|b| b.id == id).ok_or_else(|| {
            let available = match (self.bundles.front(), self.bundles.back()) {
                (Some(first), Some(last)) => format!("retained ids are {} to {}", first.id, last.id),
                _ => "no history is retained".into(),
            };
            // Ids are given in order, so one at or below the last was given
            // and has been dropped (older history beyond its size, or the
            // pieces of an answer once it was whole).
            let state = if (1..=self.next_id).contains(&id) {
                "was dropped and cannot be restored"
            } else {
                "does not exist"
            };
            anyhow::anyhow!(
                "history_unavailable: history id {id} {state}; {available}. Copy an id from history action=search, or repeat the original call"
            )
        })
    }
    pub fn search(&self, query: &str, after: u64, limit: usize) -> Value {
        let q: String = query.chars().flat_map(fold).collect();
        // The messages are searched as JSON text, where quotes, backslashes
        // and line breaks are escaped: the query is found as JSON writes it,
        // or as sent (copied from a history read).
        let escaped = serde_json::to_string(&q).map_or_else(|_| q.clone(), |s| s[1..s.len() - 1].to_owned());
        let needles: Vec<&str> = if escaped == q { vec![&q] } else { vec![&escaped, &q] };
        let rows: Vec<(&Bundle, String, &str, bool)> = self
            .bundles
            .iter()
            .filter(|b| b.id > after)
            .filter_map(|b| {
                let (messages, whole) = without_history_calls(&b.messages[..]);
                let text = serde_json::to_string(&crate::context::shown_messages(&messages)).unwrap_or_default();
                let lowered: String = text.chars().flat_map(fold).collect();
                let needle = needles.iter().copied().find(|needle| lowered.contains(needle))?;
                Some((b, text, needle, whole))
            })
            .collect();
        let items: Vec<_> = rows
            .iter()
            .take(limit.clamp(1, 50))
            .map(|(b, text, needle, whole)| {
                let (excerpt, start) = excerpt_around(text, needle);
                let mut item = json!({"id":b.id,"active":b.active,"excerpt":excerpt});
                // Where a read of the bundle shows the excerpt: its text is
                // the one searched unless history calls were left out.
                if *whole {
                    item["offset"] = json!(start);
                }
                item
            })
            .collect();
        json!({"next_cursor":if rows.len()>items.len(){items.last().and_then(|x|x["id"].as_u64())}else{None},"items":items,"pruned_through":self.pruned_through})
    }
}

/// A bundle's messages without its history tool calls and their results,
/// and whether that is all of them. What a search or read showed is found
/// where it came from: searched as well, an earlier search for the same
/// words (its query, its excerpts) and every read copy would come back as
/// matches of their own.
fn without_history_calls(messages: &[Value]) -> (Vec<Value>, bool) {
    let calls: std::collections::BTreeSet<String> = messages
        .iter()
        .flat_map(|m| m["tool_calls"].as_array().into_iter().flatten())
        .filter(|call| call["function"]["name"] == "history")
        .filter_map(|call| call["id"].as_str().map(str::to_owned))
        .collect();
    if calls.is_empty() {
        return (messages.to_vec(), true);
    }
    let kept = messages
        .iter()
        .filter(|m| !(m["role"] == "tool" && m["tool_call_id"].as_str().is_some_and(|id| calls.contains(id))))
        .map(|m| {
            let mut m = m.clone();
            if let Some(tool_calls) = m["tool_calls"].as_array_mut() {
                tool_calls.retain(|call| call["function"]["name"] != "history");
            }
            m
        })
        .collect();
    (kept, false)
}

/// A character as history search compares it: lower case, letter by letter
/// (a match in the folded text maps back to the letters it came from), with
/// the word-final sigma as σ — lower-casing a whole text gives ς at the end
/// of a word, so a word and its folded query could otherwise differ.
fn fold(ch: char) -> impl Iterator<Item = char> {
    ch.to_lowercase().map(|c| if c == 'ς' { 'σ' } else { c })
}

/// About 240 characters of `text` around the first match of `query` (folded
/// as `fold` does), so a search shows where a bundle matched rather than its
/// opening tool call (the start when the match cannot be placed), and the
/// character of `text` it starts at.
fn excerpt_around(text: &str, query: &str) -> (String, usize) {
    const BEFORE: usize = 80;
    const LENGTH: usize = 240;
    let chars: Vec<char> = text.chars().collect();
    // Folded character by character, as the search matched it, so a byte
    // of the match maps back to the character it came from.
    let mut lowered = String::new();
    let mut origin = vec![];
    for (index, ch) in chars.iter().enumerate() {
        let start = lowered.len();
        lowered.extend(fold(*ch));
        origin.extend(std::iter::repeat_n(index, lowered.len() - start));
    }
    let at = (!query.is_empty())
        .then(|| lowered.find(query))
        .flatten()
        .map_or(0, |byte| origin[byte]);
    let start = at.saturating_sub(BEFORE);
    let end = (start + LENGTH).min(chars.len());
    let mut out: String = chars[start..end].iter().collect();
    if start > 0 {
        out.insert(0, '…');
    }
    if end < chars.len() {
        out.push('…');
    }
    (out, start)
}

/// Rows of one executed query, kept for result_read and the answer's
/// `table`/`chart` references.
#[derive(Clone, Debug)]
pub struct StoredResult {
    pub step: u64,
    pub query_name: String,
    pub target_db: Option<String>,
    pub params: Value,
    pub rows: Arc<Vec<Map<String, Value>>>,
    pub capped: bool,
    /// Key of the column-omission note in wide rows (see oracle).
    pub omitted_column_key: Option<String>,
    pub bytes: usize,
}

/// One conversation.
pub struct Conversation {
    pub id: String,
    pub history: SessionHistory,
    pub file_cursors: BTreeMap<String, crate::tools::FileCursor>,
    pub list_cursor_scopes: VecDeque<(String, Value)>,
    /// Query results by step number. Steps are numbered across the whole
    /// conversation so a later answer can refer to an earlier result.
    pub results: BTreeMap<u64, StoredResult>,
    pub next_step: u64,
    /// Provider/estimate token ratios for calibration (MnemoArc), measured
    /// with `token_ratio_model`.
    pub token_ratios: VecDeque<f64>,
    pub token_ratio_model: String,
    pub last_used: Instant,
}
impl Conversation {
    pub fn new(id: String) -> Self {
        Self {
            id,
            history: SessionHistory::default(),
            file_cursors: BTreeMap::new(),
            list_cursor_scopes: VecDeque::new(),
            results: BTreeMap::new(),
            next_step: 1,
            token_ratios: VecDeque::new(),
            token_ratio_model: String::new(),
            last_used: Instant::now(),
        }
    }

    /// Stores rows under a new step; the oldest results' rows are dropped
    /// once the conversation keeps more than `limit` bytes of them.
    pub fn store_result(&mut self, mut result: StoredResult, limit: usize) -> u64 {
        let step = self.next_step;
        self.next_step += 1;
        result.step = step;
        self.results.insert(step, result);
        let mut total: usize = self.results.values().map(|r| r.bytes).sum();
        while total > limit && self.results.len() > 1 {
            let oldest = *self.results.keys().next().unwrap();
            if oldest == step {
                break;
            }
            total -= self.results.remove(&oldest).map_or(0, |r| r.bytes);
        }
        step
    }
    /// Reserves a step number for a query that failed, so step numbers in the
    /// trace stay unique.
    pub fn reserve_step(&mut self) -> u64 {
        let step = self.next_step;
        self.next_step += 1;
        step
    }
}

struct Entry {
    conversation: Arc<tokio::sync::Mutex<Conversation>>,
    /// The run that holds the conversation now: its number and how to
    /// cancel it, so a new question does not wait behind a stopped one.
    running: Option<(u64, CancellationToken)>,
    last_used: Instant,
}

/// A run's claim on a conversation, released with `SessionStore::finish`
/// (or `SessionStore::release_on_drop`).
pub struct Claim {
    pub conversation: Arc<tokio::sync::Mutex<Conversation>>,
    /// Whether the conversation already existed (its history is current).
    pub existed: bool,
    pub run: u64,
}

/// Releases a run's claim when dropped, however the run ends: returned,
/// failed, dropped mid-await or panicked. A claim left behind keeps its
/// conversation "running", which neither expiry nor the count limit removes.
/// A one-shot conversation (nothing can continue it) is removed instead.
pub struct Release<'a> {
    store: &'a SessionStore,
    id: String,
    run: u64,
    one_shot: bool,
}
impl Drop for Release<'_> {
    fn drop(&mut self) {
        if self.one_shot {
            self.store.close(&self.id, self.run);
        } else {
            self.store.finish(&self.id, self.run);
        }
    }
}

fn expired(entry: &Entry, now: Instant, idle: std::time::Duration) -> bool {
    entry.running.is_none() && now.duration_since(entry.last_used) >= idle
}

/// Conversations by the id the browser sends. Idle conversations expire and
/// the least recently used one is dropped beyond the configured count.
#[derive(Default)]
pub struct SessionStore {
    entries: std::sync::Mutex<HashMap<String, Entry>>,
    next_run: std::sync::atomic::AtomicU64,
}
impl SessionStore {
    /// Claims the conversation for a new run. A run still holding it is
    /// cancelled; the caller then waits for the conversation's lock.
    pub fn open(
        &self,
        id: &str,
        idle: std::time::Duration,
        max: usize,
        cancel: CancellationToken,
    ) -> Claim {
        let run = self
            .next_run
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        entries.retain(|key, entry| key == id || !expired(entry, now, idle));
        let existed = entries.contains_key(id);
        if !existed {
            while entries.len() >= max.max(1) {
                let Some(oldest) = entries
                    .iter()
                    .filter(|(_, entry)| entry.running.is_none())
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(key, _)| key.clone())
                else {
                    break;
                };
                entries.remove(&oldest);
            }
        }
        let entry = entries.entry(id.to_owned()).or_insert_with(|| Entry {
            conversation: Arc::new(tokio::sync::Mutex::new(Conversation::new(id.to_owned()))),
            running: None,
            last_used: now,
        });
        if let Some((_, previous)) = entry.running.replace((run, cancel)) {
            previous.cancel();
        }
        entry.last_used = now;
        Claim {
            conversation: entry.conversation.clone(),
            existed,
            run,
        }
    }

    /// Releases a run's claim unless a newer run took the conversation.
    pub fn finish(&self, id: &str, run: u64) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = entries.get_mut(id) {
            if entry.running.as_ref().is_some_and(|(owner, _)| *owner == run) {
                entry.running = None;
            }
            entry.last_used = Instant::now();
        }
    }

    /// Removes the conversation unless a newer run took it.
    pub fn close(&self, id: &str, run: u64) {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if entries
            .get(id)
            .is_some_and(|entry| entry.running.as_ref().is_none_or(|(owner, _)| *owner == run))
        {
            entries.remove(id);
        }
    }

    /// A guard that releases the claim when dropped (see `Release`).
    pub fn release_on_drop(&self, id: &str, run: u64, one_shot: bool) -> Release<'_> {
        Release {
            store: self,
            id: id.to_owned(),
            run,
            one_shot,
        }
    }

    /// Drops the conversations idle for `idle`. `open` does the same when a
    /// question arrives; this runs on a timer so a quiet server does not keep
    /// every conversation's history and rows past the retention time.
    pub fn sweep(&self, idle: std::time::Duration) -> usize {
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        let before = entries.len();
        let now = Instant::now();
        entries.retain(|_, entry| !expired(entry, now, idle));
        before - entries.len()
    }

    pub fn len(&self) -> usize {
        self.entries.lock().map_or(0, |entries| entries.len())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_drops_only_evicted_bundles_oldest_first() {
        let mut h = SessionHistory::default();
        let a = h.push(vec![json!({"role":"user","content":"a".repeat(1000)})], true);
        h.push(vec![json!({"role":"user","content":"b".repeat(1000)})], true);
        h.push(vec![json!({"role":"user","content":"c".repeat(1000)})], true);
        h.prune(100);
        assert_eq!(h.bundles.len(), 3, "active bundles stay");
        h.bundles[0].active = false;
        h.bundles[1].active = false;
        // Only the evicted bundles count toward the limit: one and a half.
        let one = h.bundles[0].bytes();
        h.prune(one + one / 2);
        assert_eq!(h.bundles.len(), 2);
        assert_eq!(h.pruned_through, Some(a));
        let gone = h.read(a).unwrap_err().to_string();
        assert!(gone.starts_with(&format!("history_unavailable: history id {a} was dropped")), "{gone}");
        assert!(h.read(99).unwrap_err().to_string().contains("does not exist"));
        // An archive whose result is still in the context is kept.
        let mut h = SessionHistory::default();
        h.push(vec![json!({"role":"tool_archive","call_id":"c1","result":{"data":"x".repeat(2000)}})], true);
        h.bundles[0].active = false;
        h.push(vec![json!({"role":"assistant","tool_calls":[]}), json!({"role":"tool","tool_call_id":"c1","content":"cut"})], true);
        h.prune(100);
        assert_eq!(h.bundles.len(), 2, "the archive the active result names stays");
        h.bundles[1].active = false;
        h.prune(100);
        assert!(h.bundles.iter().all(|b| b.messages[0]["role"] != "tool_archive"), "dropped once its result left");
    }

    #[test]
    fn prune_keeps_what_a_history_read_in_the_context_goes_on_reading() {
        // A cut history read continues its bundle by id: an evicted bundle,
        // or an archive made for an earlier call that has left the context.
        let mut h = SessionHistory::default();
        let evicted = h.push(vec![json!({"role":"user","content":"x".repeat(5000)})], true);
        h.bundles[0].active = false;
        let archive = h.push(vec![json!({"role":"tool_archive","call_id":"c1","result":{"status":"ok","data":{"text":"y".repeat(5000)}}})], true);
        h.bundles[1].active = false;
        let read = |call: &str, id: u64| {
            vec![
                json!({"role":"assistant","content":null,"tool_calls":[{"id":call,"type":"function","function":{"name":"history","arguments":json!({"action":"read","id":id}).to_string()}}]}),
                json!({"role":"tool","tool_call_id":call,"content":json!({"status":"ok","data":{"text":"…","truncated":true,"next_offset":100},"truncated":true,"next_cursor":{"tool":"history","action":"read","id":id,"offset":100}}).to_string()}),
            ]
        };
        h.push(read("c2", evicted), true);
        h.push(read("c3", archive), true);
        h.prune(100);
        assert!(h.read(evicted).is_ok() && h.read(archive).is_ok());
        // Once the reads leave the context, the bundles they read may go.
        h.bundles[2].active = false;
        h.bundles[3].active = false;
        h.prune(100);
        assert!(h.read(evicted).is_err() && h.read(archive).is_err());
    }

    #[test]
    fn a_history_search_does_not_find_the_history_tool_again() {
        // An earlier search for the same words (its query and excerpts), and
        // a read copy of a bundle, came back as matches of their own.
        let mut h = SessionHistory::default();
        let found = h.push(vec![json!({"role":"user","content":"the needle is here"})], true);
        let history_call = |id: &str, args: Value| json!({"id":id,"type":"function","function":{"name":"history","arguments":args.to_string()}});
        let search = h.search("needle", 0, 10);
        let read = json!({"status":"ok","data":{"text":serde_json::to_string(&crate::context::shown_messages(&h.bundles[0].messages[..])).unwrap()}});
        h.push(
            vec![
                json!({"role":"assistant","content":null,"tool_calls":[history_call("s", json!({"action":"search","query":"needle"})), history_call("r", json!({"action":"read","id":found})), {"id":"f","type":"function","function":{"name":"file_read","arguments":"{\"path\":\"needle.txt\"}"}}]}),
                json!({"role":"tool","tool_call_id":"s","content":json!({"status":"ok","data":search}).to_string()}),
                json!({"role":"tool","tool_call_id":"r","content":read.to_string()}),
                json!({"role":"tool","tool_call_id":"f","content":json!({"status":"ok","data":{"text":"no match"}}).to_string()}),
            ],
            true,
        );
        let both = h.push(
            vec![
                json!({"role":"assistant","content":null,"tool_calls":[history_call("s2", json!({"action":"search","query":"haystack"}))]}),
                json!({"role":"tool","tool_call_id":"s2","content":json!({"status":"ok","data":{"items":[{"id":1,"excerpt":"needle"}]}}).to_string()}),
            ],
            true,
        );
        let ids: Vec<u64> = h.search("needle", 0, 10)["items"].as_array().unwrap().iter().map(|i| i["id"].as_u64().unwrap()).collect();
        // The bundle with the history calls is still found by its other call.
        assert_eq!(ids, [found, 2], "{both}");
        let excerpt = h.search("needle", found, 10)["items"][0]["excerpt"].as_str().unwrap().to_owned();
        assert!(excerpt.contains("needle.txt") && !excerpt.contains("\"query\""), "{excerpt}");
    }

    /// Context management review, sixth pass: past the history size, the
    /// bundles a search in the context had just found were dropped at the
    /// next request, before the model could read them.
    #[test]
    fn prune_keeps_what_a_history_search_in_the_context_found() {
        let mut h = SessionHistory::default();
        let found = h.push(vec![json!({"role":"user","content":format!("needle {}", "x".repeat(5000))})], true);
        h.bundles[0].active = false;
        let search = h.search("needle", 0, 10);
        h.push(
            vec![
                json!({"role":"assistant","content":null,"tool_calls":[{"id":"s","type":"function","function":{"name":"history","arguments":json!({"action":"search","query":"needle"}).to_string()}}]}),
                json!({"role":"tool","tool_call_id":"s","content":json!({"status":"ok","data":search,"truncated":false,"next_cursor":null}).to_string()}),
            ],
            true,
        );
        h.prune(100);
        assert!(h.read(found).is_ok(), "what the search the model just made found stays readable");
        // Once a later response follows the search, what it found may go:
        // the response after the search reads it.
        h.push(vec![json!({"role":"assistant","content":"답"})], true);
        h.prune(100);
        assert!(h.read(found).is_err());
    }

    /// Context management review, sixth pass: a search named the bundle and
    /// showed an excerpt, but not where in the bundle the match is, so a
    /// large archive was read page by page from its start to reach it (as
    /// the archive told the model to "find a part with history search").
    #[test]
    fn a_history_search_says_where_to_read_its_match_from() {
        let mut h = SessionHistory::default();
        let text = format!("{}찾을 말 바로 여기{}", "앞 문장. ".repeat(20_000), "뒤 문장. ".repeat(100));
        h.push(vec![json!({"role":"tool_archive","call_id":"c","result":{"status":"ok","data":{"text":text}}})], true);
        let item = h.search("찾을 말", 0, 10)["items"][0].clone();
        let offset = item["offset"].as_u64().expect("an offset") as usize;
        // Read as the history tool reads: the bundle's shown messages from
        // that character on.
        let read = serde_json::to_string(&crate::context::shown_messages(&h.bundles[0].messages[..])).unwrap();
        let from: String = read.chars().skip(offset).take(200).collect();
        assert!(from.contains("찾을 말 바로 여기"), "{from}");
        let excerpt = item["excerpt"].as_str().unwrap().trim_start_matches('…');
        assert!(from.starts_with(&excerpt.chars().take(40).collect::<String>()), "{from} / {excerpt}");
    }

    /// Context management review, eighth pass: a bundle was matched in text
    /// lower-cased as a whole, where a word-final capital sigma becomes ς,
    /// but its excerpt and offset were placed in text lower-cased letter by
    /// letter (σ): the match was not found there, and the item pointed to the
    /// start of the bundle.
    #[test]
    fn a_match_is_placed_where_it_was_found() {
        let mut h = SessionHistory::default();
        let text = format!("{} ΟΔΟΣ 7 마감", "앞 문장. ".repeat(200));
        h.push(vec![json!({"role":"user","content":text})], true);
        let read = serde_json::to_string(&crate::context::shown_messages(&h.bundles[0].messages[..])).unwrap();
        for query in ["ΟΔΟΣ 7", "οδος 7", "οδοσ 7"] {
            let item = h.search(query, 0, 10)["items"][0].clone();
            let offset = item["offset"].as_u64().expect("an offset") as usize;
            let from: String = read.chars().skip(offset).collect();
            assert!(offset > 0 && from.contains("ΟΔΟΣ 7"), "{query}: {item}");
        }
    }

    #[test]
    fn a_new_run_cancels_the_previous_one_and_expired_conversations_go() {
        let store = SessionStore::default();
        let first = CancellationToken::new();
        let a = store.open("c1", std::time::Duration::from_secs(60), 2, first.clone());
        assert!(!a.existed);
        let b = store.open("c1", std::time::Duration::from_secs(60), 2, CancellationToken::new());
        assert!(b.existed);
        assert!(first.is_cancelled());
        store.finish("c1", a.run);
        store.finish("c1", b.run);
        store.open("c2", std::time::Duration::from_secs(60), 2, CancellationToken::new());
        let c = store.open("c3", std::time::Duration::from_secs(60), 2, CancellationToken::new());
        assert!(!c.existed);
        assert_eq!(store.len(), 2, "the idle c1 was dropped for c3; c2 is still running");
    }

    #[test]
    fn results_keep_steps_and_drop_oldest_rows_past_the_limit() {
        let mut c = Conversation::new("x".into());
        let result = |bytes| StoredResult {
            step: 0,
            query_name: "q".into(),
            target_db: None,
            params: json!({}),
            rows: Arc::new(vec![]),
            capped: false,
            omitted_column_key: None,
            bytes,
        };
        assert_eq!(c.store_result(result(60), 100), 1);
        assert_eq!(c.reserve_step(), 2);
        assert_eq!(c.store_result(result(60), 100), 3);
        assert!(!c.results.contains_key(&1));
        assert!(c.results.contains_key(&3));
    }

    #[test]
    fn claims_are_released_however_the_run_ends() {
        let store = SessionStore::default();
        let hour = std::time::Duration::from_secs(3600);
        // A run dropped mid-way (its guard dropped, finish never called)
        // no longer pins its conversation as running.
        let claim = store.open("c1", hour, 10, CancellationToken::new());
        drop(store.release_on_drop("c1", claim.run, false));
        assert_eq!(store.sweep(std::time::Duration::ZERO), 1);
        // A run still in progress keeps its conversation through a sweep.
        let running = store.open("c2", hour, 10, CancellationToken::new());
        assert_eq!(store.sweep(std::time::Duration::ZERO), 0);
        // A newer run's claim survives the older run's release.
        let newer = store.open("c2", hour, 10, CancellationToken::new());
        drop(store.release_on_drop("c2", running.run, false));
        assert_eq!(store.sweep(std::time::Duration::ZERO), 0);
        drop(store.release_on_drop("c2", newer.run, false));
        assert_eq!(store.sweep(hour), 0, "kept until idle");
        assert_eq!(store.len(), 1);
        // A one-shot conversation goes as soon as its run ends.
        let once = store.open("once:1", hour, 10, CancellationToken::new());
        assert_eq!(store.len(), 2);
        drop(store.release_on_drop("once:1", once.run, true));
        assert_eq!(store.len(), 1);
    }
}
