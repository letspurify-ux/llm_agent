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
    /// Drops the oldest evicted bundles until the history fits `limit`
    /// bytes. Active bundles are never dropped here: eviction retires them
    /// first.
    pub fn prune(&mut self, limit: usize) {
        let mut bytes = self.bytes();
        while bytes > limit {
            let Some(index) = self.bundles.iter().position(|b| !b.active) else {
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
            let pruned = self.pruned_through.map_or(String::new(), |id| {
                format!("; ids up to {id} were dropped and cannot be restored")
            });
            anyhow::anyhow!(
                "history_unavailable: history id {id} does not exist; {available}{pruned}. Copy an id from history action=search, or repeat the original call"
            )
        })
    }
    pub fn search(&self, query: &str, after: u64, limit: usize) -> Value {
        let q = query.to_lowercase();
        let rows: Vec<_> = self
            .bundles
            .iter()
            .filter(|b| b.id > after)
            .filter(|b| {
                serde_json::to_string(&*b.messages)
                    .unwrap_or_default()
                    .to_lowercase()
                    .contains(&q)
            })
            .collect();
        let items: Vec<_> = rows
            .iter()
            .take(limit.clamp(1, 50))
            .map(|b| {
                json!({"id":b.id,"active":b.active,"excerpt":serde_json::to_string(&*b.messages).unwrap_or_default().chars().take(240).collect::<String>()})
            })
            .collect();
        json!({"next_cursor":if rows.len()>items.len(){items.last().and_then(|x|x["id"].as_u64())}else{None},"items":items,"pruned_through":self.pruned_through})
    }
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
    /// Best matching chunk per knowledge document in recent searches.
    pub knowledge_hints: HashMap<i64, i64>,
    /// Provider/estimate token ratios for calibration (MnemoArc).
    pub token_ratios: VecDeque<f64>,
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
            knowledge_hints: HashMap::new(),
            token_ratios: VecDeque::new(),
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

/// A run's claim on a conversation, released with `SessionStore::finish`.
pub struct Claim {
    pub conversation: Arc<tokio::sync::Mutex<Conversation>>,
    /// Whether the conversation already existed (its history is current).
    pub existed: bool,
    pub run: u64,
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
        entries.retain(|key, entry| {
            key == id || entry.running.is_some() || now.duration_since(entry.last_used) < idle
        });
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
        h.prune(2500);
        assert_eq!(h.bundles.len(), 2);
        assert_eq!(h.pruned_through, Some(a));
        assert!(h.read(a).unwrap_err().to_string().starts_with("history_unavailable"));
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
}
