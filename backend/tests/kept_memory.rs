//! What a conversation keeps against its byte limits, measured as the
//! memory it holds, in a process of its own: the heap is measured
//! process-wide.

mod support;

use llm_agent::session::{Conversation, Held, SessionHistory, StoredResult};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use support::*;

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
