//! The driver's process-wide buffers, in a process of their own: the cap
//! applies from the driver's first use.

mod support;

use support::*;

/// Resource review, twenty-second pass: the driver kept up to 128 buffers
/// of up to 4 MiB each for later, for good — a buffer that took a large row
/// came back cut to 4 MiB and stayed (44 MB after 8 connections read 10 MB
/// rows, 512 MiB at most). With the cap set at start, rows read and gone
/// leave about nothing behind.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_rows_read_leave_no_buffers_behind() {
    llm_agent::db::cap_driver_buffers();
    let Some(before) = heap_in_use() else {
        return skip("the heap in use is not measured on this platform");
    };
    let Some(test_db) = TestDb::create("driver_buffers") else {
        return skip("LLM_AGENT_TEST_MARIADB is not set");
    };
    let connections = 8;
    test_db.sql_in("INSERT INTO knowledge (title, content) VALUES ('large', REPEAT('x', 10000000))");
    let mut config = test_db.config();
    config.mariadb.pool_size = connections;
    let (app, _dir) = app(config, Scripted::new(vec![]));
    let config = app.config();
    for _ in 0..2 {
        let reads: Vec<_> = (0..connections)
            .map(|_| {
                let (app, config) = (app.clone(), config.clone());
                // Held a moment, so each read takes a connection of its own.
                tokio::spawn(async move {
                    let rows = app
                        .db
                        .query(&config.mariadb, "SELECT content FROM knowledge WHERE title = 'large' AND SLEEP(0.2) = 0", vec![])
                        .await
                        .unwrap();
                    llm_agent::db::text(&rows[0], "content").len()
                })
            })
            .collect();
        for read in reads {
            assert_eq!(read.await.unwrap(), 10_000_000);
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let grown = heap_in_use().unwrap().saturating_sub(before);
    assert!(grown < 24 << 20, "{} MiB more after {connections} connections read 10 MB rows", grown >> 20);
}
