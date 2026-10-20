//! What a conversation keeps against its byte limits, and what a source
//! tool holds while it runs, measured as memory, in a process of its own:
//! the heap is measured process-wide, a test at a time.

mod support;

use llm_agent::{
    config::Project,
    session::{Conversation, Held, SessionHistory, StoredResult},
    tools::{self, ToolConfig, Workspace},
};
use serde_json::{Map, Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::*;

/// One test measures at a time.
static MEASURING: Mutex<()> = Mutex::new(());

/// A query's rows of short cells, as the target DB driver gives them.
fn rows(seed: usize) -> Vec<Map<String, Value>> {
    let columns = ["ORDER_ID", "CUSTOMER_NAME", "ORDER_DATE", "STATUS", "AMOUNT", "ITEM_COUNT", "REGION", "CREATED_BY", "UPDATED_AT", "NOTE"];
    (0..1_000)
        .map(|i| {
            let mut row = Map::new();
            for (k, column) in columns.iter().enumerate() {
                let value = if k == 4 { json!((seed * 1_000 + i) as f64 * 1.5) } else { json!(format!("{:08}", seed * 1_000 + i)) };
                row.insert((*column).to_owned(), value);
            }
            row
        })
        .collect()
}

/// Resource review, twenty-fourth pass: the limits counted JSON bytes, a
/// ninth of what rows of short cells hold (an eighth for small messages):
/// 32 MiB of rows kept held about 300 MiB, a conversation of the 200 kept.
#[test]
fn byte_limits_bound_the_memory_a_conversation_holds() {
    let _measuring = MEASURING.lock().unwrap_or_else(|p| p.into_inner());
    let Some(start) = heap_in_use() else {
        return skip("the heap in use is not measured on this platform");
    };
    // The estimate is the memory held.
    let sample = rows(0);
    let held = heap_in_use().unwrap() - start;
    let estimate = sample.held();
    assert!(estimate.abs_diff(held) < held / 5, "estimate {estimate} for {held} bytes held");
    drop(sample);

    let limit = 8 << 20;
    let before = heap_in_use().unwrap();
    let mut conversation = Conversation::new("c".into());
    for seed in 0..60 {
        let rows = rows(seed);
        let bytes = rows.held();
        let result = StoredResult {
            step: 0,
            query_name: "q".into(),
            target_db: None,
            params: json!({}),
            rows: Arc::new(rows),
            capped: false,
            omitted_column_key: None,
            bytes,
        };
        conversation.store_result(result, limit);
    }
    let grown = heap_in_use().unwrap().saturating_sub(before);
    assert!(grown < limit + limit / 4, "{} MiB held for rows kept within {} MiB", grown >> 20, limit >> 20);
    drop(conversation);

    let before = heap_in_use().unwrap();
    let mut history = SessionHistory::default();
    for i in 0..30_000 {
        let text = format!(r#"[{{"role":"assistant","content":null,"tool_calls":[{{"id":"call_{i}","type":"function","function":{{"name":"search","arguments":"{{\"query\":\"abc\"}}"}}}}]}},{{"role":"tool","tool_call_id":"call_{i}","content":"{{\"ok\":true}}"}}]"#);
        history.push(serde_json::from_str(&text).unwrap(), true);
        history.bundles.back_mut().unwrap().active = false;
        if i % 100 == 99 {
            history.prune(limit);
        }
    }
    let grown = heap_in_use().unwrap().saturating_sub(before);
    assert!(grown < limit + limit / 4, "{} MiB held for history kept within {} MiB", grown >> 20, limit >> 20);
}

/// Resource review, twenty-fifth pass: a symbol search held the syntax tree
/// of every file in its scope until it answered, 40 to 130 bytes a source
/// byte — 657 MiB at once for 25 MB of Rust, of the 32 MiB a search may
/// read. It needs of a tree only the declarations and whether it parsed.
#[test]
fn a_symbol_search_holds_one_tree_at_a_time() {
    let _measuring = MEASURING.lock().unwrap_or_else(|p| p.into_inner());
    let Some(before) = heap_in_use() else {
        return skip("the heap in use is not measured on this platform");
    };
    let dir = tempfile::tempdir().unwrap();
    let function = |file: usize, i: usize| format!("pub fn item_{file}_{i}(left: u64, right: &[u8]) -> Option<u64> {{\n    let total = right.iter().map(|b| u64::from(*b)).sum::<u64>();\n    if total > left {{ Some(total - left) }} else {{ None }}\n}}\n");
    for file in 0..400 {
        let source: String = (0..60).map(|i| function(file, i)).collect();
        std::fs::write(dir.path().join(format!("m{file}.rs")), source).unwrap();
    }
    let mut workspace = Workspace {
        project: Project { name: "big".into(), root: dir.path().into(), ..Default::default() },
        config: ToolConfig { model: "gpt-4o".into(), result_tokens: 4000, tool_timeout_secs: 120 },
        file_cursors: Default::default(),
        list_cursor_scopes: Default::default(),
        history: Default::default(),
    };
    let (peak, done) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicBool::new(false)));
    let sampler = {
        let (peak, done) = (peak.clone(), done.clone());
        std::thread::spawn(move || {
            while !done.load(Ordering::Relaxed) {
                peak.fetch_max(heap_in_use().unwrap(), Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };
    let found = tools::execute(&mut workspace, "symbol_search", json!({"query":"item_7_"}), &Default::default()).unwrap();
    done.store(true, Ordering::Relaxed);
    sampler.join().unwrap();
    assert_eq!((found["total_results"].clone(), found["scanned_files"].clone()), (json!(60), json!(400)));
    let grown = peak.load(Ordering::Relaxed).saturating_sub(before);
    assert!(grown < 64 << 20, "{} MiB held at once by a search of 4 MB of source", grown >> 20);
}
