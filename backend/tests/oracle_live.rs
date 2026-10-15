//! Registered queries against a real Oracle (sql/oracle-init.sql loaded):
//! runs when LLM_AGENT_TEST_ORACLE=1 and LLM_AGENT_TEST_MARIADB are set,
//! with ORDER_DB_PASSWORD in the environment and the Instant Client
//! reachable (ORACLE_CLIENT_LIB_DIR or the OS search path).

mod support;

use llm_agent::db;
use serde_json::{Map, Value, json};
use support::*;
use tokio_util::sync::CancellationToken;

fn params(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap()
}

#[tokio::test]
async fn queries_routines_types_and_cancellation() {
    if std::env::var("LLM_AGENT_TEST_ORACLE").ok().as_deref() != Some("1") {
        return skip("LLM_AGENT_TEST_ORACLE is not set");
    }
    let Some(test_db) = TestDb::create("oracle") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in(
        "INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES
         ('type_probe', 'SELECT SYSDATE AS D, CAST(TIMESTAMP ''2026-09-06 12:34:56.789'' AS TIMESTAMP) AS TS, 1/4 AS QUARTER, 12345678901234567890 AS BIG, NUMTODSINTERVAL(1.5, ''DAY'') AS IV, ''x'' AS S FROM DUAL', 'ORDER_DB'),
         ('slow_probe', 'SELECT COUNT(*) AS N FROM all_objects a, all_objects b, all_objects c', 'ORDER_DB')",
    );
    let mut config = test_db.config();
    config.oracle.mock = false;
    config.oracle.client_lib_dir = std::env::var("ORACLE_CLIENT_LIB_DIR").unwrap_or_default();
    let (app, _dir) = app(config, Scripted::new(vec![]));
    let config = app.config();
    let registry = |name: &str| {
        let app = app.clone();
        let config = config.clone();
        let name = name.to_owned();
        async move {
            db::queries_by_names(&app.db, &config.mariadb, &[name]).await.unwrap().remove(0)
        }
    };
    let never = |_: &str| false;
    let run = |row: db::Row, p: Value, cancel: CancellationToken| {
        let app = app.clone();
        let config = config.clone();
        async move {
            app.oracle
                .run(&app.db, &config, &row, &params(p), None, &never, &cancel)
                .await
        }
    };

    let out = run(registry("batch_job_status").await, json!({"job_id":"BATCH001"}), CancellationToken::new()).await.unwrap();
    assert_eq!(out.rows.len(), 1);
    assert_eq!(out.rows[0]["JOB_ID"], "BATCH001");
    assert_eq!(out.target_db, "ORDER_DB");

    let out = run(registry("get_customer_orders_proc").await, json!({"customer_id":"C-1001"}), CancellationToken::new()).await.unwrap();
    assert!(!out.rows.is_empty(), "REF CURSOR rows");
    assert!(out.rows[0].contains_key("ORDER_ID"), "{:?}", out.rows[0]);

    let out = run(registry("get_customer_order_total_fn").await, json!({"customer_id":"C-1001"}), CancellationToken::new()).await.unwrap();
    assert!(out.rows[0]["total_amount"].is_number(), "NUMBER OUT is a number: {:?}", out.rows[0]);

    let out = run(registry("type_probe").await, json!({}), CancellationToken::new()).await.unwrap();
    let row = &out.rows[0];
    assert!(row["D"].as_str().unwrap().len() == 19, "DATE as YYYY-MM-DD HH:MM:SS: {row:?}");
    assert_eq!(row["TS"], "2026-09-06 12:34:56.789");
    assert_eq!(row["QUARTER"], json!(0.25));
    assert_eq!(row["BIG"], "12345678901234567890", "big numbers stay exact text");
    assert_eq!(row["IV"], "1 12:00:00");
    assert_eq!(row["S"], "x");

    let missing = run(registry("batch_job_status").await, json!({}), CancellationToken::new()).await.unwrap_err();
    assert!(missing.to_string().contains("값 없음"), "{missing}");

    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        trigger.cancel();
    });
    let started = std::time::Instant::now();
    let cancelled = run(registry("slow_probe").await, json!({}), cancel).await.unwrap_err();
    assert_eq!(cancelled.to_string(), "cancelled");
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
    // The pool still works after a break.
    let out = run(registry("today_date").await, json!({}), CancellationToken::new()).await.unwrap();
    assert!(out.rows[0]["TODAY"].is_string());

    // A pool in use is kept; an idle one is closed, and the next run opens
    // a new one.
    assert_eq!(app.oracle.pool_count(), 1);
    assert_eq!(app.oracle.close_idle(llm_agent::oracle::POOL_IDLE), 0);
    assert_eq!(app.oracle.close_idle(std::time::Duration::ZERO), 1);
    assert_eq!(app.oracle.pool_count(), 0);
    let out = run(registry("today_date").await, json!({}), CancellationToken::new()).await.unwrap();
    assert!(out.rows[0]["TODAY"].is_string());
    assert_eq!(app.oracle.pool_count(), 1);
}
