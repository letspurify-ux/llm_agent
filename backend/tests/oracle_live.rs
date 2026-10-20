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

/// A run stopped while it waited for a session (the pool's eight in use)
/// had nothing to break: once a session came free, its statement ran to its
/// end, up to the call timeout, the question waiting. It now returns as soon
/// as it has the session, running nothing, and the pool goes on.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_run_stopped_while_waiting_for_a_session_runs_nothing() {
    if std::env::var("LLM_AGENT_TEST_ORACLE").ok().as_deref() != Some("1") {
        return skip("LLM_AGENT_TEST_ORACLE is not set");
    }
    let Some(test_db) = TestDb::create("oracle_wait") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in("INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES ('slow_probe', 'SELECT COUNT(*) AS N FROM all_objects a, all_objects b, all_objects c', 'ORDER_DB')");
    let mut config = test_db.config();
    config.oracle.mock = false;
    config.oracle.timeout_ms = 15_000;
    config.oracle.client_lib_dir = std::env::var("ORACLE_CLIENT_LIB_DIR").unwrap_or_default();
    let (app, _dir) = app(config, Scripted::new(vec![]));
    let config = app.config();
    let row = |name: &str| {
        let (app, config, name) = (app.clone(), config.clone(), name.to_owned());
        async move { db::queries_by_names(&app.db, &config.mariadb, &[name]).await.unwrap().remove(0) }
    };
    let run = |row: db::Row, cancel: CancellationToken| {
        let (app, config) = (app.clone(), config.clone());
        tokio::spawn(async move {
            let started = std::time::Instant::now();
            let never = |_: &str| false;
            let result = app.oracle.run(&app.db, &config, &row, &Map::new(), None, &never, &cancel).await.map_err(|e| e.to_string());
            (result.map(|o| o.rows), started.elapsed())
        })
    };
    let slow = row("slow_probe").await;
    let busy = CancellationToken::new();
    let holders: Vec<_> = (0..8).map(|_| run(slow.clone(), busy.clone())).collect();
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let stop = CancellationToken::new();
    let waiting = run(slow, stop.clone());
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    stop.cancel();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    busy.cancel();
    for holder in holders {
        assert_eq!(holder.await.unwrap().0.unwrap_err(), "cancelled");
    }
    let (result, took) = waiting.await.unwrap();
    assert_eq!(result.unwrap_err(), "cancelled");
    assert!(took < std::time::Duration::from_secs(5), "the stopped run returned after {took:?}");
    let out = run(row("today_date").await, CancellationToken::new()).await.unwrap().0.unwrap();
    assert!(out[0]["TODAY"].is_string());
}

/// A routine that opened its REF CURSOR and then raised left the cursor open
/// in its session (the caller never receives it), and the pool handed the
/// session out again: one more open cursor per failure, until every
/// statement on it failed with ORA-01000 (open_cursors, 300 by default),
/// other questions' routines too. Such a session is closed instead; one
/// whose routine succeeded, or whose plain query failed, goes on.
#[tokio::test]
async fn a_failed_cursor_routine_does_not_pool_its_session() {
    if std::env::var("LLM_AGENT_TEST_ORACLE").ok().as_deref() != Some("1") {
        return skip("LLM_AGENT_TEST_ORACLE is not set");
    }
    let Some(test_db) = TestDb::create("oracle_cursor") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    test_db.sql_in(
        r#"INSERT INTO query_registry (query_name, query_type, bind_config, query_sql, target_db_name) VALUES
         ('strict_orders', 'PROCEDURE', '{"customer_id":{"dir":"IN","type":"STRING"},"rows":{"dir":"OUT","type":"CURSOR"}}',
          'BEGIN APP_USER.GET_CUSTOMER_ORDERS_STRICT(:customer_id, :rows); END;', 'ORDER_DB'),
         ('session_probe', 'QUERY', NULL, 'SELECT SYS_CONTEXT(''USERENV'', ''SESSIONID'') AS SESSION_ID FROM DUAL', 'ORDER_DB'),
         ('number_probe', 'QUERY', NULL, 'SELECT TO_NUMBER(:v) AS N FROM DUAL', 'ORDER_DB')"#,
    );
    let mut config = test_db.config();
    config.oracle.mock = false;
    config.oracle.client_lib_dir = std::env::var("ORACLE_CLIENT_LIB_DIR").unwrap_or_default();
    let (app, _dir) = app(config, Scripted::new(vec![]));
    let config = app.config();
    let names = ["strict_orders", "session_probe", "number_probe"].map(str::to_owned);
    let rows = db::queries_by_names(&app.db, &config.mariadb, &names).await.unwrap();
    let registry = |name: &str| rows.iter().find(|r| db::text(r, "query_name") == name).unwrap().clone();
    let run = |name: &str, p: Value| {
        let (app, config, row) = (app.clone(), config.clone(), registry(name));
        async move {
            let never = |_: &str| false;
            app.oracle.run(&app.db, &config, &row, &params(p), None, &never, &CancellationToken::new()).await
        }
    };
    // Runs one after another take the pool's one session.
    let session = || async { run("session_probe", json!({})).await.unwrap().rows[0]["SESSION_ID"].clone() };
    let first = session().await;
    let out = run("strict_orders", json!({"customer_id":"C-1001"})).await.unwrap();
    assert!(out.rows[0].contains_key("ORDER_ID"), "{:?}", out.rows);
    let error = run("number_probe", json!({"v":"x"})).await.unwrap_err();
    assert!(error.to_string().contains("ORA-01722"), "{error}");
    assert_eq!(session().await, first, "kept after a routine that succeeded and a query that failed");
    let error = run("strict_orders", json!({"customer_id":"C-404"})).await.unwrap_err();
    assert!(error.to_string().contains("ORA-20001"), "{error}");
    assert_ne!(session().await, first, "closed after the routine failed with its cursor open");
}

/// A proxy to `upstream` that counts the bytes the server sends.
async fn byte_counter(upstream: String) -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let sent = std::sync::Arc::new(AtomicUsize::new(0));
    let counted = sent.clone();
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let (counted, upstream) = (counted.clone(), upstream.clone());
            tokio::spawn(async move {
                let server = tokio::net::TcpStream::connect(upstream).await.unwrap();
                let (mut client_in, mut client_out) = client.into_split();
                let (mut server_in, mut server_out) = server.into_split();
                tokio::spawn(async move { tokio::io::copy(&mut client_in, &mut server_out).await });
                let mut buffer = vec![0u8; 65536];
                while let Ok(n @ 1..) = server_in.read(&mut buffer).await {
                    counted.fetch_add(n, Ordering::AcqRel);
                    if client_out.write_all(&buffer[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    (port, sent)
}

/// LOB cells were fetched as values: each read whole, the fetch's every row
/// at once, to keep 4,000 characters of a CLOB and the size of a BLOB (200
/// rows of a 1 MB CLOB: 206 MiB). They are read as locators up to the cell's
/// limit, a BLOB only measured, and come out as before.
// The proxy runs beside the test: the sessions say goodbye through it when
// the app ends.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lob_cells_are_read_only_as_far_as_a_cell_keeps() {
    if std::env::var("LLM_AGENT_TEST_ORACLE").ok().as_deref() != Some("1") {
        return skip("LLM_AGENT_TEST_ORACLE is not set");
    }
    let Some(test_db) = TestDb::create("oracle_lob") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let emoji = "UNISTR(CHR(92) || ''D83D'' || CHR(92) || ''DE00'')";
    test_db.sql_in(&format!(
        "INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES
         ('lob_rows', 'SELECT RPAD(TO_CLOB(''x''), 1000000, ''y'') AS BODY, ZZ.N FROM (SELECT LEVEL AS N FROM DUAL CONNECT BY LEVEL <= 40) ZZ', 'ORDER_DB'),
         ('lob_cells', 'SELECT RPAD(TO_CLOB(''가''), 10000, ''나'') AS BODY, RPAD(TO_CLOB(''x''), 4000, ''x'') AS E4000,
            RPAD(TO_CLOB(''x''), 4001, ''x'') AS E4001, TO_CLOB({emoji}) || RPAD(TO_CLOB(''y''), 3998, ''y'') || TO_CLOB({emoji}) AS EMOJI,
            TO_CLOB(NULL) AS NUL, EMPTY_CLOB() AS EMP, TO_NCLOB(''짧다'') AS NC, TO_BLOB(HEXTORAW(RPAD(''A'', 4000, ''A''))) AS BIN FROM DUAL', 'ORDER_DB')"
    ));
    // The registration's server, through a proxy that counts what it sends.
    let address = test_db.scalar("SELECT connection_info FROM target_db WHERE db_name = 'ORDER_DB'");
    let (server, service) = address.split_once('/').unwrap();
    let (port, sent) = byte_counter(server.to_owned()).await;
    test_db.sql_in(&format!("UPDATE target_db SET connection_info = '127.0.0.1:{port}/{service}' WHERE db_name = 'ORDER_DB'"));
    let mut config = test_db.config();
    config.oracle.mock = false;
    config.oracle.client_lib_dir = std::env::var("ORACLE_CLIENT_LIB_DIR").unwrap_or_default();
    let (app, _dir) = app(config, Scripted::new(vec![]));
    let config = app.config();
    let run = |name: &str| {
        let (app, config, name) = (app.clone(), config.clone(), name.to_owned());
        async move {
            let row = db::queries_by_names(&app.db, &config.mariadb, &[name]).await.unwrap().remove(0);
            let never = |_: &str| false;
            app.oracle.run(&app.db, &config, &row, &Map::new(), None, &never, &CancellationToken::new()).await.unwrap()
        }
    };
    let mark = llm_agent::text::TRUNC_MARK;
    let cut = |text: &str| format!("{text}{mark}");

    let before = sent.load(std::sync::atomic::Ordering::Acquire);
    let out = run("lob_rows").await;
    let read = sent.load(std::sync::atomic::Ordering::Acquire) - before;
    assert_eq!(out.rows.len(), 40);
    assert!(out.rows.iter().all(|r| r["BODY"] == cut(&format!("x{}", "y".repeat(3999)))));
    assert!(read < 4_000_000, "{read} bytes read for 40 cells of 4,000 characters, of 1 MB CLOBs");

    let out = run("lob_cells").await;
    let row = &out.rows[0];
    assert_eq!(row["BODY"], cut(&format!("가{}", "나".repeat(3999))));
    assert_eq!(row["E4000"], "x".repeat(4000));
    assert_eq!(row["E4001"], cut(&"x".repeat(4000)));
    // 4,002 UTF-16 units: the second emoji is past the cell.
    assert_eq!(row["EMOJI"], cut(&format!("😀{}", "y".repeat(3998))));
    assert_eq!((&row["NUL"], &row["EMP"]), (&Value::Null, &Value::Null));
    assert_eq!(row["NC"], "짧다");
    assert_eq!(row["BIN"], "<binary 2000 bytes>");
}

/// A query's rows, once read, stay with its session no longer. The client
/// library caches a session's statements, and a cached query kept the rows
/// it prefetched (a result's thousand rows come in one round trip): each
/// registered query a session ran held its last result's size, twenty of
/// them a session, eight sessions a target DB, as long as the sessions were
/// in use (1,000 rows of 4,000 characters: 4 MB a query, 78 MB a session).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_query_keeps_no_rows_on_its_session_once_read() {
    if std::env::var("LLM_AGENT_TEST_ORACLE").ok().as_deref() != Some("1") {
        return skip("LLM_AGENT_TEST_ORACLE is not set");
    }
    if heap_in_use().is_none() {
        return skip("the heap in use is not measured on this platform");
    }
    let Some(test_db) = TestDb::create("oracle_cache") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let queries = 16;
    let values: Vec<String> = (0..queries)
        .map(|i| format!("('wide_{i}', 'SELECT RPAD(''x'', 4000, ''y'') AS BODY, {i} AS Q, LEVEL AS N FROM DUAL CONNECT BY LEVEL <= 1000', 'ORDER_DB')"))
        .collect();
    test_db.sql_in(&format!("INSERT INTO query_registry (query_name, query_sql, target_db_name) VALUES {}", values.join(",")));
    let mut config = test_db.config();
    config.oracle.mock = false;
    config.oracle.client_lib_dir = std::env::var("ORACLE_CLIENT_LIB_DIR").unwrap_or_default();
    let (app, _dir) = app(config, Scripted::new(vec![]));
    let config = app.config();
    let names: Vec<String> = (0..queries).map(|i| format!("wide_{i}")).collect();
    let rows = db::queries_by_names(&app.db, &config.mariadb, &names).await.unwrap();
    let never = |_: &str| false;
    // One after another, so one session runs them all.
    let mut first = None;
    for row in &rows {
        let out = app.oracle.run(&app.db, &config, row, &Map::new(), None, &never, &CancellationToken::new()).await.unwrap();
        assert_eq!(out.rows.len(), 1000);
        drop(out);
        first.get_or_insert_with(|| heap_in_use().unwrap());
    }
    let grown = heap_in_use().unwrap().saturating_sub(first.unwrap());
    assert!(grown < 20 << 20, "{} MiB more after {} more queries on one session", grown >> 20, queries - 1);
}
