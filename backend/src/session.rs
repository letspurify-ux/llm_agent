//! Conversations kept on the server. A conversation's history is a list of
//! bundles as in MnemoArc: one user message, or one model response with the
//! results of its tool calls. Bundles leave the model's context whole (see
//! `context::evict`), and stay readable through the `history` tool until the
//! history byte limit drops the oldest.

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

pub(crate) fn serialized_bytes(value: &(impl Serialize + ?Sized)) -> usize {
    #[derive(Default)]
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(bytes.len());
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter::default();
    serde_json::to_writer(&mut counter, value).map_or(usize::MAX, |()| counter.0)
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
    /// a cut result, the bundle a cut history read goes on reading.
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
        for message in self
            .bundles
            .iter()
            .filter(|b| b.active)
            .flat_map(|b| b.messages.iter())
            .filter(|m| m["role"] == "tool")
        {
            if let Some(id) = message["tool_call_id"].as_str() {
                calls.insert(id.to_owned());
            }
            let Some(result) = message["content"].as_str().and_then(|text| serde_json::from_str::<Value>(text).ok()) else {
                continue;
            };
            continued.extend(result["archive_id"].as_u64());
            if result["next_cursor"]["tool"] == "history" {
                continued.extend(result["next_cursor"]["id"].as_u64());
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
        let q = query.to_lowercase();
        // The messages are searched as JSON text, where quotes, backslashes
        // and line breaks are escaped: the query is found as JSON writes it,
        // or as sent (copied from a history read).
        let escaped = serde_json::to_string(&q).map_or_else(|_| q.clone(), |s| s[1..s.len() - 1].to_owned());
        let needles: Vec<&str> = if escaped == q { vec![&q] } else { vec![&escaped, &q] };
        let rows: Vec<(&Bundle, String, &str)> = self
            .bundles
            .iter()
            .filter(|b| b.id > after)
            .filter_map(|b| {
                let text = serde_json::to_string(&crate::context::shown_messages(&b.messages[..])).unwrap_or_default();
                let lowered = text.to_lowercase();
                let needle = needles.iter().copied().find(|needle| lowered.contains(needle))?;
                Some((b, text, needle))
            })
            .collect();
        let items: Vec<_> = rows
            .iter()
            .take(limit.clamp(1, 50))
            .map(|(b, text, needle)| json!({"id":b.id,"active":b.active,"excerpt":excerpt_around(text, needle)}))
            .collect();
        json!({"next_cursor":if rows.len()>items.len(){items.last().and_then(|x|x["id"].as_u64())}else{None},"items":items,"pruned_through":self.pruned_through})
    }
}

/// About 240 characters of `text` around the first match of `query` (in
/// lower case), so a search shows where a bundle matched rather than its
/// opening tool call; the start when the match cannot be placed.
fn excerpt_around(text: &str, query: &str) -> String {
    const BEFORE: usize = 80;
    const LENGTH: usize = 240;
    let chars: Vec<char> = text.chars().collect();
    // Lower-cased character by character, so a byte of the match maps back
    // to the character it came from.
    let mut lowered = String::new();
    let mut origin = vec![];
    for (index, ch) in chars.iter().enumerate() {
        let start = lowered.len();
        lowered.extend(ch.to_lowercase());
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
    out
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
    /// Executed query calls (name, target, params) → step, to refuse an
    /// identical repeat.
    pub executed: HashMap<String, u64>,
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
            executed: HashMap::new(),
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
        // A repeat is refused in favour of result_read on the earlier step;
        // once that step's rows are gone the query must be allowed to run
        // again (and the map stays as small as the results it points to).
        self.executed.retain(|_, kept| self.results.contains_key(kept));
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
        // Only the evicted bundles count toward the limit.
        h.prune(1500);
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
        c.executed.insert("q-a".into(), 1);
        assert_eq!(c.reserve_step(), 2);
        assert_eq!(c.store_result(result(60), 100), 3);
        c.executed.insert("q-b".into(), 3);
        assert!(!c.results.contains_key(&1));
        assert!(c.results.contains_key(&3));
        // The dropped step's call may run again; the kept one is still refused.
        assert_eq!(c.executed.keys().collect::<Vec<_>>(), ["q-b"]);
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
