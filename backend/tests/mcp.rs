//! MCP tool servers against a fake server (tests/fixtures/fake_mcp_server.mjs,
//! run with Node): connection, tools, calls, failures and recovery, process
//! cleanup, HTTP, and the answer loop with a scripted model.

mod support;

use llm_agent::{
    agent::{self, Events, Question},
    config::{Config, McpServer, Secret},
    mcp::{McpHub, probe},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use support::*;
use tokio_util::sync::CancellationToken;

const MODEL: &str = "gpt-4o";

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_mcp_server.mjs")
}

/// Whether the fake server cannot run. CI sets REQUIRE_NODE=1, where a
/// missing node fails instead of passing these tests unseen.
fn node_missing() -> bool {
    let missing = Command::new("node").arg("--version").output().is_err();
    if missing {
        assert!(std::env::var("REQUIRE_NODE").as_deref() != Ok("1"), "node is required (REQUIRE_NODE=1)");
        skip("node is not installed");
    }
    missing
}

fn fake(name: &str, tools: &[&str], env: &[(&str, &str)]) -> McpServer {
    McpServer {
        name: name.into(),
        description: format!("가짜 MCP 서버 {name}"),
        command: "node".into(),
        args: vec![fixture().display().to_string()],
        tools: tools.iter().map(|t| (*t).to_owned()).collect(),
        env: env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
        ..Default::default()
    }
}

fn config(servers: Vec<McpServer>) -> Config {
    let mut config = Config::default();
    config.mariadb.port = 9;
    config.llm.base_url = "http://127.0.0.1:9/v1".into();
    config.llm.model = MODEL.into();
    config.mcp_servers = servers;
    config
}

/// The server's status once `done` holds, within ten seconds.
async fn wait_for(hub: &McpHub, name: &str, done: impl Fn(&Value) -> bool) -> Value {
    let started = Instant::now();
    loop {
        let status = hub.server_status(name, MODEL).expect("server is configured");
        if done(&status) {
            return status;
        }
        assert!(started.elapsed() < Duration::from_secs(10), "timed out waiting for {name}: {status:#}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn ready(hub: &McpHub, name: &str) -> Value {
    wait_for(hub, name, |s| s["state"] == "ready").await
}

fn log_text(status: &Value) -> String {
    status["log"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap_or("").to_owned()).collect::<Vec<_>>().join("\n")
}

async fn call(hub: &McpHub, config: &Config, name: &str, args: Value) -> anyhow::Result<Value> {
    let snapshot = hub.snapshot(config);
    let tool = snapshot.find(name).unwrap_or_else(|| panic!("{name} is not offered: {:?}", snapshot.names().collect::<Vec<_>>()));
    tool.check(&args)?;
    tool.call(args, &CancellationToken::new()).await
}

#[tokio::test]
async fn tools_are_listed_offered_and_called() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("fake", &["echo", "add", "structured_only", "mixed", "weird.name"], &[])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    let status = ready(&hub, "fake").await;
    // Listed across pages (three tools a page), every tool, allowed or not.
    assert_eq!(status["tools"].as_array().unwrap().len(), 21, "{status:#}");
    assert_eq!(status["server_info"]["name"], "fake-mcp");
    assert_eq!(status["server_info"]["version"], "1.2.3");
    let echo = status["tools"].as_array().unwrap().iter().find(|t| t["name"] == "echo").unwrap();
    assert_eq!(echo["allowed"], true);
    assert_eq!(echo["annotations"]["readOnlyHint"], true);
    assert!(echo["tokens"].as_u64().unwrap() > 10);
    let crash = status["tools"].as_array().unwrap().iter().find(|t| t["name"] == "crash").unwrap();
    assert_eq!(crash["allowed"], false);

    let snapshot = hub.snapshot(&config);
    let names: Vec<&str> = snapshot.names().collect();
    assert_eq!(names, ["fake__echo", "fake__add", "fake__structured_only", "fake__mixed", "fake__weird_name"]);
    let definitions = snapshot.definitions();
    // Another tool named in a description is named as the model sees it.
    let structured = definitions.iter().find(|d| d["function"]["name"] == "fake__structured_only").unwrap();
    assert_eq!(structured["function"]["description"], "Structured content without text; for text use fake__add_tool or fake__weird_name, or call echo.");
    let weird = definitions.iter().find(|d| d["function"]["name"] == "fake__weird_name").unwrap();
    let parameters = &weird["function"]["parameters"];
    assert!(parameters.get("anyOf").is_none() && parameters.get("$defs").is_none(), "{parameters}");
    assert_eq!(parameters["properties"]["item"]["properties"]["id"]["type"], "integer");
    assert!(snapshot.prompt().contains("- fake: 가짜 MCP 서버 fake"), "{}", snapshot.prompt());

    assert_eq!(call(&hub, &config, "fake__echo", json!({"text":"안녕"})).await.unwrap(), json!({"text":"echo: 안녕"}));
    assert_eq!(call(&hub, &config, "fake__add", json!({"a":2,"b":3})).await.unwrap(), json!({"text":"{\"sum\":5}"}));
    assert_eq!(call(&hub, &config, "fake__structured_only", json!({})).await.unwrap()["text"], "{\"ok\":true,\"items\":[1,2]}");
    let mixed = call(&hub, &config, "fake__mixed", json!({})).await.unwrap();
    assert!(mixed["text"].as_str().unwrap().contains("resource body"), "{mixed}");
    assert_eq!(mixed["omitted_content"].as_array().unwrap().len(), 3);
    let missing = call(&hub, &config, "fake__add", json!({"a":2})).await.unwrap_err();
    assert!(missing.to_string().starts_with("missing_argument: b"), "{missing}");
    // A call's statistics.
    let status = hub.server_status("fake", MODEL).unwrap();
    let echo = status["tools"].as_array().unwrap().iter().find(|t| t["name"] == "echo").unwrap();
    assert_eq!(echo["calls"], 1);
    assert_eq!(echo["failures"], 0);
    assert!(log_text(&status).contains("fake server ready"), "the server's log notification is kept");
    hub.shutdown().await;
}

#[tokio::test]
async fn an_empty_allow_list_offers_nothing() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("quiet", &[], &[])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "quiet").await;
    let snapshot = hub.snapshot(&config);
    assert!(snapshot.is_empty());
    assert_eq!(snapshot.prompt(), "");
    hub.shutdown().await;
}

#[tokio::test]
async fn tool_errors_bad_arguments_and_large_results() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("fake", &["*"], &[])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "fake").await;
    let failed = call(&hub, &config, "fake__fail", json!({})).await.unwrap_err();
    assert_eq!(failed.to_string(), "mcp_tool_error: boom: the tool failed");
    let refused = call(&hub, &config, "fake__strict", json!({})).await.unwrap_err();
    assert!(refused.to_string().starts_with("invalid_tool_arguments:"), "{refused}");
    let big = call(&hub, &config, "fake__big", json!({"chars":250_000})).await.unwrap();
    assert_eq!(big["text"].as_str().unwrap().len(), llm_agent::mcp::MAX_RESULT_CHARS);
    assert_eq!(big["text_cut_chars"], 50_000);
    let status = hub.server_status("fake", MODEL).unwrap();
    let fail = status["tools"].as_array().unwrap().iter().find(|t| t["name"] == "fail").unwrap();
    assert_eq!(fail["failures"], 1);
    assert!(fail["last_error"].as_str().unwrap().contains("boom"));
    hub.shutdown().await;
}

#[tokio::test]
async fn a_slow_call_times_out_or_is_cancelled_and_the_server_is_told() {
    if node_missing() {
        return;
    }
    let mut server = fake("slow", &["slow", "echo"], &[]);
    server.timeout_secs = Some(1);
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "slow").await;
    let started = Instant::now();
    let timed_out = call(&hub, &config, "slow__slow", json!({"ms":5000})).await.unwrap_err();
    assert!(timed_out.to_string().starts_with("mcp_timeout:"), "{timed_out}");
    // Told to stop, the server may have done the work anyway: no blind retry.
    assert!(timed_out.to_string().contains("may still have taken effect"), "{timed_out}");
    assert!(started.elapsed() < Duration::from_secs(3));
    wait_for(&hub, "slow", |s| log_text(s).contains("cancelled")).await;

    let snapshot = hub.snapshot(&config);
    let tool = snapshot.find("slow__slow").unwrap();
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        stopper.cancel();
    });
    let stopped = tool.call(json!({"ms":5000}), &cancel).await.unwrap_err();
    // Sent, it may have done its work all the same (seventeenth pass): said
    // so, under the code a stop has.
    assert!(stopped.to_string().starts_with("cancelled: slow__slow was sent"), "{stopped}");
    assert!(stopped.to_string().contains("may still have taken effect"), "{stopped}");
    wait_for(&hub, "slow", |s| log_text(s).matches("cancelled").count() >= 2).await;
    // The connection still serves.
    assert_eq!(call(&hub, &config, "slow__echo", json!({"text":"x"})).await.unwrap()["text"], "echo: x");
    let status = hub.server_status("slow", MODEL).unwrap();
    let slow = status["tools"].as_array().unwrap().iter().find(|t| t["name"] == "slow").unwrap();
    assert_eq!((slow["calls"].as_u64(), slow["failures"].as_u64(), slow["cancelled"].as_u64()), (Some(2), Some(1), Some(1)));
    hub.shutdown().await;
}

#[tokio::test]
async fn calls_to_a_server_that_stopped_reading_end_at_their_timeout() {
    if node_missing() {
        return;
    }
    let mut server = fake("stuck", &["stall_input", "echo"], &[]);
    server.timeout_secs = Some(1);
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "stuck").await;
    call(&hub, &config, "stuck__stall_input", json!({})).await.unwrap();
    // More than the pipe and the SDK's queue hold: later calls wait to be
    // sent, and every one still ends at its timeout.
    let snapshot = hub.snapshot(&config);
    let tool = snapshot.find("stuck__echo").unwrap();
    let started = Instant::now();
    let calls = (0..1_200).map(|_| {
        let tool = tool.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let outcome = tool.call(json!({"text":"x".repeat(1_000)}), &CancellationToken::new()).await;
            (outcome, started.elapsed())
        })
    });
    let outcomes = futures_util::future::join_all(calls).await;
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    for outcome in outcomes {
        let (outcome, took) = outcome.unwrap();
        let error = outcome.unwrap_err().to_string();
        assert!(error.starts_with("mcp_timeout:"), "{error}");
        // The timeout, and the second given to a notice stuck behind it.
        assert!(took < Duration::from_millis(2_600), "one call took {took:?}");
    }
    // A stop does not wait on it either.
    let cancel = CancellationToken::new();
    cancel.cancel();
    let started = Instant::now();
    assert_eq!(tool.call(json!({"text":"x"}), &cancel).await.unwrap_err().to_string(), "cancelled");
    let stopper = CancellationToken::new();
    let stop = stopper.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        stop.cancel();
    });
    // Stopped while it waits to be sent ("cancelled": not sent), or once
    // handed to the connection (the server may read it yet, so the stop
    // says it may take effect).
    let stopped = tool.call(json!({"text":"x"}), &stopper).await.unwrap_err().to_string();
    assert!(stopped == "cancelled" || (stopped.starts_with("cancelled: stuck__echo") && stopped.contains("may still have taken effect")), "{stopped}");
    assert!(started.elapsed() < Duration::from_millis(900));
    // Closing it does not wait on the input it no longer reads: a second
    // for the input, the grace to exit, then the kill (on Windows the only
    // thing that ends it before the backend exits). Unix asks it to stop
    // after the grace, which ends it; Windows has no such request and waits
    // the grace again before the kill (5 s in all, within shutdown's 6 s).
    let closing = Instant::now();
    hub.shutdown().await;
    let limit = Duration::from_millis(if cfg!(windows) { 5_800 } else { 4_800 });
    assert!(closing.elapsed() < limit, "closed in {:?}", closing.elapsed());
}

#[tokio::test]
async fn calls_in_flight_end_promptly_when_the_backend_stops() {
    if node_missing() {
        return;
    }
    let mut server = fake("busy", &["slow"], &[]);
    server.timeout_secs = Some(60);
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "busy").await;
    let snapshot = hub.snapshot(&config);
    let tool = snapshot.find("busy__slow").unwrap();
    let calls: Vec<_> = (0..5)
        .map(|_| {
            let tool = tool.clone();
            tokio::spawn(async move { tool.call(json!({"ms":30_000}), &CancellationToken::new()).await })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    hub.shutdown().await;
    for call in calls {
        let outcome = tokio::time::timeout(Duration::from_secs(5), call).await.expect("the call ended").unwrap();
        let error = outcome.unwrap_err().to_string();
        assert!(error.starts_with("mcp_server_unavailable:"), "{error}");
    }
    assert!(started.elapsed() < Duration::from_secs(7), "{:?}", started.elapsed());
}

#[tokio::test]
async fn calls_racing_edits_and_restarts_neither_hang_nor_panic() {
    if node_missing() {
        return;
    }
    let mut server = fake("churn", &["echo", "slow"], &[]);
    server.timeout_secs = Some(3);
    let mut config = config(vec![server.clone()]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "churn").await;
    let snapshot = hub.snapshot(&config);
    let started = Instant::now();
    let callers: Vec<_> = (0..8)
        .map(|i| {
            let echo = snapshot.find("churn__echo").unwrap();
            let slow = snapshot.find("churn__slow").unwrap();
            tokio::spawn(async move {
                let mut outcomes = (0, 0);
                for n in 0..40 {
                    let outcome = if (i + n) % 5 == 0 {
                        slow.call(json!({"ms":200}), &CancellationToken::new()).await
                    } else {
                        echo.call(json!({"text":format!("{i}-{n}")}), &CancellationToken::new()).await
                    };
                    match outcome {
                        Ok(_) => outcomes.0 += 1,
                        Err(error) => {
                            let text = error.to_string();
                            assert!(text.starts_with("mcp_server_unavailable:") || text.starts_with("unsupported_tool:") || text.starts_with("mcp_timeout:"), "{text}");
                            outcomes.1 += 1;
                        }
                    }
                }
                outcomes
            })
        })
        .collect();
    // Meanwhile: allowed tools change in place, the connection changes,
    // restarts are asked for, the server is turned off and on.
    for round in 0..6 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        match round % 3 {
            0 => server.tools = if server.tools.len() == 2 { vec!["echo".into()] } else { vec!["echo".into(), "slow".into()] },
            1 => {
                server.env.insert("ROUND".into(), round.to_string());
            }
            _ => {
                hub.restart("churn");
            }
        }
        config.mcp_servers = vec![server.clone()];
        hub.apply(&config.mcp_servers);
    }
    server.enabled = false;
    hub.apply(std::slice::from_ref(&server));
    server.enabled = true;
    hub.apply(std::slice::from_ref(&server));
    let mut total = (0, 0);
    for caller in callers {
        let (ok, failed) = tokio::time::timeout(Duration::from_secs(60), caller).await.expect("no caller hangs").expect("no caller panics");
        total = (total.0 + ok, total.1 + failed);
    }
    assert_eq!(total.0 + total.1, 320);
    assert!(total.0 > 0, "some calls went through: {total:?}");
    // The server settles connected, and serves.
    let settled = ready(&hub, "churn").await;
    assert_eq!(settled["state"], "ready");
    let config = config_after(&server);
    assert_eq!(call(&hub, &config, "churn__echo", json!({"text":"끝"})).await.unwrap()["text"], "echo: 끝");
    eprintln!("churn: {total:?} in {:?}", started.elapsed());
    hub.shutdown().await;
}

fn config_after(server: &McpServer) -> Config {
    config(vec![server.clone()])
}

#[tokio::test]
async fn a_line_without_end_cuts_the_connection_instead_of_filling_memory() {
    if node_missing() {
        return;
    }
    let mut server = fake("flood", &["flood_line", "echo"], &[]);
    server.timeout_secs = Some(30);
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    let first = ready(&hub, "flood").await;
    let started = Instant::now();
    let error = call(&hub, &config, "flood__flood_line", json!({})).await.unwrap_err().to_string();
    assert!(error.starts_with("mcp_server_unavailable:"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(10), "cut when the line passed the limit, not at the timeout: {:?}", started.elapsed());
    let failed = wait_for(&hub, "flood", |s| log_text(s).contains("16 MiB를 넘는 한 줄")).await;
    assert_ne!(failed["state"], "ready");
    let again = wait_for(&hub, "flood", |s| s["state"] == "ready" && s["pid"] != first["pid"]).await;
    assert!(again["restarts"].as_u64().unwrap() >= 1);
    assert_eq!(call(&hub, &config, "flood__echo", json!({"text":"다시"})).await.unwrap()["text"], "echo: 다시");
    hub.shutdown().await;
}

#[tokio::test]
async fn a_save_during_shutdown_starts_nothing() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("late", &["echo"], &[])]);
    let hub = McpHub::default();
    hub.shutdown().await;
    // The admin API still answers during the connections' grace.
    hub.apply(&config.mcp_servers);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let status = hub.server_status("late", MODEL);
    assert!(status.is_none() || status.as_ref().unwrap()["pid"].is_null(), "no process after shutdown: {status:?}");
    assert!(!hub.restart("late"));
    assert!(hub.snapshot(&config).is_empty());
    // Nor does a connection check: shutdown would not wait for it.
    let refused = hub.probe(&config.mcp_servers[0], MODEL).await.unwrap_err().to_string();
    assert!(refused.contains("멈추는 중"), "{refused}");
}

#[tokio::test]
async fn a_server_that_exits_mid_call_is_reconnected() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("crashy", &["crash", "echo"], &[])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    let first = ready(&hub, "crashy").await;
    let error = call(&hub, &config, "crashy__crash", json!({})).await.unwrap_err();
    assert!(error.to_string().starts_with("mcp_server_unavailable:"), "{error}");
    // On the server when its connection ended, the call may have done its work.
    assert!(error.to_string().ends_with("it may have taken effect on the server"), "{error}");
    let failed = wait_for(&hub, "crashy", |s| s["state"] == "failed").await;
    assert!(failed["error"].as_str().unwrap().contains("crashing on purpose"), "the last output explains it: {failed:#}");
    assert!(failed["retry_at"].is_string());
    // While it is down, a new question is not offered its tools.
    assert!(hub.snapshot(&config).find("crashy__echo").is_none());
    let again = wait_for(&hub, "crashy", |s| s["state"] == "ready" && s["restarts"].as_u64() >= Some(1)).await;
    assert_ne!(first["pid"], again["pid"]);
    assert_eq!(call(&hub, &config, "crashy__echo", json!({"text":"x"})).await.unwrap()["text"], "echo: x");
    hub.shutdown().await;
}

/// A server gone while a process it started holds its output open (a
/// Python server's `subprocess.Popen` inherits its standard streams): the
/// output never ended, and the server showed ready while each call waited
/// out its timeout. Its end is seen, and one that does not answer then is
/// reconnected.
#[tokio::test]
async fn a_server_gone_is_seen_though_a_process_it_started_holds_its_output() {
    if node_missing() {
        return;
    }
    let mut server = fake("heir", &["spawn_heir", "crash", "echo"], &[("FAKE_MCP_HEIR", "1")]);
    server.timeout_secs = Some(30);
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    let first = ready(&hub, "heir").await;
    let heir: i32 = call(&hub, &config, "heir__spawn_heir", json!({})).await.unwrap()["text"].as_str().unwrap().parse().unwrap();
    let started = Instant::now();
    let error = call(&hub, &config, "heir__crash", json!({})).await.unwrap_err().to_string();
    assert!(started.elapsed() < Duration::from_secs(12), "the call waited {:?}: {error}", started.elapsed());
    assert!(error.starts_with("mcp_server_unavailable:") && error.ends_with("it may have taken effect on the server"), "{error}");
    let again = wait_for(&hub, "heir", |s| s["state"] == "ready" && s["pid"] != first["pid"]).await;
    // On Windows the output ends with the server's process here (the
    // process it started does not keep it, CI shows): its end is a closed
    // connection, not an output still open.
    #[cfg(unix)]
    assert!(log_text(&again).contains("서버 프로세스가 끝났는데"), "{again:#}");
    #[cfg(not(unix))]
    let _ = again;
    assert_eq!(call(&hub, &config, "heir__echo", json!({"text":"x"})).await.unwrap()["text"], "echo: x");
    // Closed with its server's process group.
    #[cfg(unix)]
    {
        let started = Instant::now();
        while alive(heir) && started.elapsed() < Duration::from_secs(5) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(!alive(heir), "the process holding the output is gone");
    }
    #[cfg(not(unix))]
    let _ = heir;
    hub.shutdown().await;
}

/// A server whose process hands its streams to another and exits (a
/// launcher) still answers: it stays connected. Unix only: on Windows the
/// output ends with the process that started the other (CI shows), so the
/// hand-over is a closed connection and the server is connected again.
#[cfg(unix)]
#[tokio::test]
async fn a_server_handed_over_to_another_process_stays_connected() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("relay", &["hand_over", "echo"], &[("FAKE_MCP_HEIR", "1")])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "relay").await;
    call(&hub, &config, "relay__hand_over", json!({})).await.unwrap();
    // Past the drain and a ping's limit.
    tokio::time::sleep(Duration::from_secs(8)).await;
    let status = hub.server_status("relay", MODEL).unwrap();
    assert_eq!((status["state"].clone(), status["restarts"].clone()), (json!("ready"), json!(0)), "{status:#}");
    // Its process's end was looked into, and the one now serving answered.
    assert!(log_text(&status).contains("살아 있는지 묻습니다"), "{status:#}");
    assert_eq!(call(&hub, &config, "relay__echo", json!({"text":"x"})).await.unwrap()["text"], "echo: x");
    hub.shutdown().await;
}

/// MCP review, twenty-eighth pass: the end of a server's process was seen
/// by reaping it. Handed over to a process in a session of its own, its
/// group was left empty and its ID free while the connection went on, and
/// the group's kill at the close reached whatever came to have the ID (a
/// process leading its own group, found among ~99,000 started meanwhile,
/// was killed). The ended process now holds its ID until the close.
#[cfg(unix)]
#[tokio::test]
async fn a_server_gone_out_of_its_group_holds_its_id_until_closed() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("relay", &["hand_over", "echo"], &[("FAKE_MCP_HEIR", "1")])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    let first: i32 = ready(&hub, "relay").await["pid"].as_i64().unwrap().try_into().unwrap();
    let next: i32 = call(&hub, &config, "relay__hand_over", json!({"detached":true})).await.unwrap()["text"].as_str().unwrap().parse().unwrap();
    // Its end seen, and the one now serving asked.
    let status = wait_for(&hub, "relay", |s| log_text(s).contains("살아 있는지 묻습니다")).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert_eq!(hub.server_status("relay", MODEL).unwrap()["state"], "ready", "{status:#}");
    assert!(alive(first), "the ended process {first} holds its ID");
    assert_eq!(call(&hub, &config, "relay__echo", json!({"text":"x"})).await.unwrap()["text"], "echo: x");
    hub.shutdown().await;
    assert!(!alive(first), "reaped at the close");
    // The one it handed over to, outside the group, ends with its input.
    let started = Instant::now();
    while alive(next) && started.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!alive(next));
}

#[tokio::test]
async fn noisy_output_and_failing_servers_stay_apart() {
    if node_missing() {
        return;
    }
    let config = config(vec![
        fake("noisy", &["echo"], &[("FAKE_MCP_GARBAGE", "1"), ("FAKE_MCP_STDERR", "500")]),
        fake("broken", &["*"], &[("FAKE_MCP_EXIT_BEFORE_INIT", "1")]),
        McpServer { name: "missing".into(), command: "llm-agent-no-such-command".into(), tools: vec!["*".into()], ..Default::default() },
    ]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    let noisy = ready(&hub, "noisy").await;
    // Non-JSON lines on stdout are skipped; stderr is drained and its last
    // lines kept.
    assert_eq!(call(&hub, &config, "noisy__echo", json!({"text":"ok"})).await.unwrap()["text"], "echo: ok");
    let log = noisy["log"].as_array().unwrap();
    assert!(log.len() <= 200);
    assert!(log_text(&noisy).contains("stderr line 499"));
    let broken = wait_for(&hub, "broken", |s| s["state"] == "failed").await;
    assert!(broken["error"].as_str().unwrap().contains("fatal: missing configuration"), "{broken:#}");
    let missing = wait_for(&hub, "missing", |s| s["state"] == "failed").await;
    assert!(missing["error"].as_str().unwrap().contains("PATH에서 찾지 못했습니다"), "{missing:#}");
    let snapshot = hub.snapshot(&config);
    assert_eq!(snapshot.names().collect::<Vec<_>>(), ["noisy__echo"]);
    hub.shutdown().await;
}

#[tokio::test]
async fn a_reconnect_asked_while_connecting_reconnects_once() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("slowstart", &["echo"], &[("FAKE_MCP_SLOW_INIT_MS", "3000")])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(hub.server_status("slowstart", MODEL).unwrap()["state"], "connecting");
    let asked = Instant::now();
    assert!(hub.restart("slowstart"));
    let first = ready(&hub, "slowstart").await;
    assert_eq!(first["restarts"], 1);
    // The slow start under way was dropped for the new one, not waited out
    // and then done again (about 3.2 s against 6 s; wide margins for a busy
    // machine).
    assert!(asked.elapsed() < Duration::from_millis(4_800), "took {:?}", asked.elapsed());
    // No second reconnection follows the one asked for.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let later = hub.server_status("slowstart", MODEL).unwrap();
    assert_eq!((later["state"].clone(), later["pid"].clone(), later["restarts"].clone()), (json!("ready"), first["pid"].clone(), json!(1)));
    hub.shutdown().await;
}

#[tokio::test]
async fn a_server_stuck_listing_its_tools_still_stops_at_once() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("stuck", &["*"], &[("FAKE_MCP_HANG_LIST", "1")])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    let listing = wait_for(&hub, "stuck", |s| s["pid"].is_number() && log_text(s).contains("fake server ready")).await;
    let pid = listing["pid"].as_i64().unwrap() as i32;
    let started = Instant::now();
    hub.shutdown().await;
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    let gone = Instant::now();
    while alive(pid) && gone.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!alive(pid));
}

#[cfg(unix)]
#[tokio::test]
async fn a_command_is_found_in_the_path_its_own_env_sets() {
    use std::os::unix::fs::PermissionsExt;
    if node_missing() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("llm-agent-fake-mcp");
    std::fs::write(&script, format!("#!/bin/sh\nexec node {}\n", fixture().display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut server = McpServer { name: "pathed".into(), command: "llm-agent-fake-mcp".into(), tools: vec!["echo".into()], ..Default::default() };
    let path = format!("{}:{}", dir.path().display(), std::env::var("PATH").unwrap());
    server.env.insert("PATH".into(), path);
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "pathed").await;
    assert_eq!(call(&hub, &config, "pathed__echo", json!({"text":"찾음"})).await.unwrap()["text"], "echo: 찾음");
    hub.shutdown().await;
}

/// A batch file found in PATH, as npx.cmd is: found with PATHEXT, run
/// through cmd.exe, and the whole tree (cmd, node, its child) ended by the
/// Job Object.
#[cfg(windows)]
#[tokio::test]
async fn a_batch_file_in_the_path_runs_like_npx_and_its_tree_ends_with_it() {
    if node_missing() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("llm-agent-fake-mcp.cmd"), format!("@echo off\r\nnode \"{}\" %*\r\n", fixture().display())).unwrap();
    let mut server = McpServer { name: "batch".into(), command: "llm-agent-fake-mcp".into(), tools: vec!["echo".into(), "spawn_child".into()], ..Default::default() };
    server.env.insert("PATH".into(), format!("{};{}", dir.path().display(), std::env::var("PATH").unwrap()));
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "batch").await;
    assert_eq!(call(&hub, &config, "batch__echo", json!({"text":"배치"})).await.unwrap()["text"], "echo: 배치");
    let child: i32 = call(&hub, &config, "batch__spawn_child", json!({})).await.unwrap()["text"].as_str().unwrap().parse().unwrap();
    assert!(alive(child));
    hub.shutdown().await;
    let gone = Instant::now();
    while alive(child) && gone.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!alive(child), "the server's child ended with the job");
}

/// A relative command is the working folder's, on every system.
#[tokio::test]
async fn a_relative_command_runs_from_the_working_folder() {
    if node_missing() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let tools = dir.path().join("tools");
    std::fs::create_dir_all(&tools).unwrap();
    #[cfg(unix)]
    let command = {
        use std::os::unix::fs::PermissionsExt;
        let script = tools.join("server.sh");
        std::fs::write(&script, format!("#!/bin/sh\nexec node {}\n", fixture().display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        "tools/server.sh"
    };
    #[cfg(windows)]
    let command = {
        std::fs::write(tools.join("server.cmd"), format!("@echo off\r\nnode \"{}\" %*\r\n", fixture().display())).unwrap();
        "tools\\server.cmd"
    };
    let server = McpServer { name: "relative".into(), command: command.into(), cwd: dir.path().display().to_string(), tools: vec!["echo".into()], ..Default::default() };
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "relative").await;
    assert_eq!(call(&hub, &config, "relative__echo", json!({"text":"상대"})).await.unwrap()["text"], "echo: 상대");
    hub.shutdown().await;
}

#[tokio::test]
async fn a_missing_working_folder_is_named() {
    if node_missing() {
        return;
    }
    let mut server = fake("nowhere", &["*"], &[]);
    server.cwd = "/llm-agent-no-such-folder".into();
    let hub = McpHub::default();
    hub.apply(&[server]);
    let failed = wait_for(&hub, "nowhere", |s| s["state"] == "failed").await;
    assert!(failed["error"].as_str().unwrap().contains("작업 폴더"), "{failed:#}");
    hub.shutdown().await;
}

/// MCP review, seventeenth pass: a failure was told with the last line the
/// server ever wrote — that of a process gone before this attempt (its
/// startup banner, its last words), beside a cause it had no part in.
/// Unix only: it removes the working folder of a server still running, which
/// Windows does not allow (the folder stayed, the next attempt started in
/// it, and the test waited for a missing folder in vain).
#[cfg(unix)]
#[tokio::test]
async fn a_failure_is_told_with_the_output_of_its_own_attempt() {
    if node_missing() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut server = fake("stale", &["crash"], &[]);
    server.cwd = dir.path().display().to_string();
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "stale").await;
    // Its folder gone, the server exits mid-call ("crashing on purpose").
    drop(dir);
    assert!(call(&hub, &config, "stale__crash", json!({})).await.is_err());
    let failed = wait_for(&hub, "stale", |s| s["error"].as_str().is_some_and(|e| e.contains("작업 폴더"))).await;
    let error = failed["error"].as_str().unwrap();
    assert!(!error.contains("서버 출력"), "the reconnection started no process to speak: {error}");
    // The process that crashed is still told with its own words.
    assert!(log_text(&failed).contains("연결이 끊겼습니다 (서버 출력: crashing on purpose)"), "{}", log_text(&failed));
    hub.shutdown().await;
}

#[tokio::test]
async fn results_and_server_requests_outside_the_types_are_read_leniently() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("edge", &["*"], &[])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "edge").await;
    // A block of an unknown type or a text block without text does not lose
    // the whole result.
    assert_eq!(call(&hub, &config, "edge__bad_content", json!({})).await.unwrap(), json!({"text":"","omitted_content":["weird"]}));
    assert_eq!(call(&hub, &config, "edge__bad_text", json!({})).await.unwrap(), json!({"text":""}));
    // What the server asks the client mid-call is answered (not supported,
    // no roots, declined), and the call completes.
    let asked = call(&hub, &config, "edge__ask_client", json!({})).await.unwrap();
    assert_eq!(asked["text"], "sampling: error -32601; roots: {\"roots\":[]}; elicitation: {\"action\":\"decline\"}");
    assert_eq!(call(&hub, &config, "edge__progress", json!({})).await.unwrap()["text"], "progressed");
    assert_eq!(call(&hub, &config, "edge__stray_reply", json!({})).await.unwrap()["text"], "real");
    assert_eq!(call(&hub, &config, "edge__echo", json!({"text":"after"})).await.unwrap()["text"], "echo: after");
    hub.shutdown().await;
}

#[tokio::test]
async fn a_sloppy_tool_list_still_connects() {
    if node_missing() {
        return;
    }
    let servers = vec![
        fake("sloppy", &["*"], &[("FAKE_MCP_BAD_LIST", "1"), ("FAKE_MCP_DUPLICATE", "1")]),
        fake("looping", &["echo"], &[("FAKE_MCP_CURSOR_LOOP", "1")]),
    ];
    let config = config(servers);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    // One tool without a schema does not fail the server: it takes no
    // arguments; a repeated name keeps the first.
    let sloppy = ready(&hub, "sloppy").await;
    let names: Vec<&str> = sloppy["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(names.iter().filter(|n| **n == "echo").count(), 1);
    assert!(names.contains(&"no_schema") && names.contains(&"string_schema"), "{names:?}");
    let log = log_text(&sloppy);
    assert!(log.contains("no_schema의 입력 스키마") && log.contains("echo이(가) 두 번"), "{log}");
    let definitions = hub.snapshot(&config).definitions();
    let no_schema = definitions.iter().find(|d| d["function"]["name"] == "sloppy__no_schema").unwrap();
    assert_eq!(no_schema["function"]["parameters"], json!({"type":"object","properties":{}}));
    assert_eq!(call(&hub, &config, "sloppy__echo", json!({"text":"first"})).await.unwrap()["text"], "echo: first");
    let mut misspelt = fake("misspelt", &["ech0"], &[]);
    misspelt.description.clear();
    hub.apply(&[config.mcp_servers[0].clone(), config.mcp_servers[1].clone(), misspelt]);
    let warned = wait_for(&hub, "misspelt", |s| log_text(s).contains("허용 목록의 ech0")).await;
    assert_eq!(warned["state"], "ready");
    // A server repeating its cursor is listed once, not until the timeout.
    let looping = ready(&hub, "looping").await;
    assert!(log_text(&looping).contains("같은 커서 반복"), "{looping:#}");
    hub.shutdown().await;
}

#[tokio::test]
async fn what_a_server_sends_is_bounded() {
    if node_missing() {
        return;
    }
    let config = config(vec![
        fake("huge", &["*"], &[("FAKE_MCP_HUGE_META", "1")]),
        fake("many", &["*"], &[("FAKE_MCP_MANY", "1500"), ("FAKE_MCP_PAGE", "5000")]),
        fake("storm", &["echo"], &[("FAKE_MCP_LIST_STORM", "1"), ("FAKE_MCP_PAGE", "1000")]),
        fake("paged", &["*"], &[("FAKE_MCP_MANY", "1500"), ("FAKE_MCP_PAGE", "100"), ("FAKE_MCP_LOG_LISTS", "1")]),
        fake("faulty", &["*"], &[("FAKE_MCP_MANY_BAD", "500"), ("FAKE_MCP_PAGE", "1000")]),
    ]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    for name in ["huge", "many", "storm", "paged", "faulty"] {
        ready(&hub, name).await;
    }
    // A server announcing a changed list after every listing is listed
    // about once a second, not in a loop.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let storm = hub.server_status("storm", MODEL).unwrap();
    let lists = log_text(&storm).lines().filter(|l| l.starts_with("listed")).count();
    assert!(lists <= 5, "listed {lists} times in 3 s");
    // What it says about itself is cut; a schema too large leaves its tool out.
    let huge = hub.server_status("huge", MODEL).unwrap();
    assert!(huge["server_info"]["instructions"].as_str().unwrap().chars().count() <= 8_001);
    assert!(huge["server_info"]["name"].as_str().unwrap().chars().count() <= 201);
    let tools = huge["tools"].as_array().unwrap();
    let meta = tools.iter().find(|t| t["name"] == "huge_meta").unwrap();
    assert_eq!(meta["annotations"], json!({"readOnlyHint":true}));
    assert!(meta["title"].as_str().unwrap().chars().count() <= 201);
    assert!(!tools.iter().any(|t| t["name"] == "huge_schema"));
    assert!(log_text(&huge).contains("huge_schema의 입력 스키마가"), "{}", log_text(&huge));
    let many = hub.server_status("many", MODEL).unwrap();
    assert_eq!(many["tools"].as_array().unwrap().len(), 1_000);
    assert!(log_text(&many).contains("앞의 1000개만"));
    // Past them, the pages after are not read (review, eleventh pass: all
    // 100 pages were, each up to a message's 16 MiB).
    let paged = hub.server_status("paged", MODEL).unwrap();
    assert_eq!(paged["tools"].as_array().unwrap().len(), 1_000);
    let pages = log_text(&paged).lines().filter(|l| l.starts_with("listed")).count();
    assert_eq!(pages, 11, "1,100 tools read of 1,521");
    // Five hundred faulty tools say so in a few lines: the log keeps the
    // rest, the console is not flooded at every reconnection.
    let faulty = hub.server_status("faulty", MODEL).unwrap();
    assert_eq!(faulty["tools"].as_array().unwrap().len(), 521, "taken without arguments");
    let lines = log_text(&faulty).lines().count();
    assert!(lines <= 23, "{lines} lines: {}", log_text(&faulty));
    assert!(log_text(&faulty).contains("480건은 줄였습니다"), "{}", log_text(&faulty));
    // The admin screen's status stays small however much they send.
    let status = hub.status(MODEL).to_string().len();
    assert!(status < 1_500_000, "status {status} bytes");
    hub.shutdown().await;
}

#[tokio::test]
async fn a_changed_tool_list_is_read_again() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("grow", &["*"], &[])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "grow").await;
    assert!(hub.snapshot(&config).find("grow__extra").is_none());
    call(&hub, &config, "grow__add_tool", json!({})).await.unwrap();
    wait_for(&hub, "grow", |s| s["tools"].as_array().unwrap().iter().any(|t| t["name"] == "extra")).await;
    assert_eq!(call(&hub, &config, "grow__extra", json!({})).await.unwrap()["text"], "extra ran");
    hub.shutdown().await;
}

#[tokio::test]
async fn a_reconnect_is_not_held_up_by_a_changed_list_never_answered() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("relist", &["*"], &[("FAKE_MCP_HANG_RELIST", "1"), ("FAKE_MCP_PAGE", "100")])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "relist").await;
    call(&hub, &config, "relist__add_tool", json!({})).await.unwrap();
    // The changed list is asked for after a second, and never answered.
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let asked = Instant::now();
    assert!(hub.restart("relist"));
    // Reconnected now, not once the listing gives up (30 seconds).
    let back = wait_for(&hub, "relist", |s| s["state"] == "ready" && s["restarts"] == 1).await;
    assert!(asked.elapsed() < Duration::from_secs(8), "took {:?}", asked.elapsed());
    assert!(!back["tools"].as_array().unwrap().iter().any(|t| t["name"] == "extra"), "a new process, its own list");
    hub.shutdown().await;
}

/// Resource leak review, 36th pass: a changed list not read within its
/// limit was only logged. A server that stopped reading its input, and went
/// on announcing changes, stayed ready for good and was read again at each
/// announcement; once its input was full, each reading's request and its
/// cancellation waited in the SDK to be written, two tasks more every half
/// minute for as long as the backend ran. It is now asked whether it still
/// answers, as after a call past its limit.
#[tokio::test]
async fn a_server_that_stops_reading_while_its_list_changes_is_reconnected() {
    if node_missing() {
        return;
    }
    let stalled = fake("stalled", &["*"], &[("FAKE_MCP_STALL_RELIST", "1"), ("FAKE_MCP_PAGE", "100")]);
    // One that only takes as long to list stays as it is: it answers a ping.
    let slow = fake("slowlist", &["*"], &[("FAKE_MCP_HANG_RELIST", "1"), ("FAKE_MCP_PAGE", "100")]);
    let config = config(vec![stalled, slow]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "stalled").await;
    ready(&hub, "slowlist").await;
    call(&hub, &config, "stalled__add_tool", json!({})).await.unwrap();
    call(&hub, &config, "slowlist__add_tool", json!({})).await.unwrap();
    // Read again after a second, its limit 30 seconds, the ping's 5.
    let started = Instant::now();
    let back = loop {
        let status = hub.server_status("stalled", MODEL).unwrap();
        if status["state"] == "ready" && status["restarts"] == 1 {
            break status;
        }
        assert!(started.elapsed() < Duration::from_secs(50), "not reconnected: {status:#}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let log = log_text(&back);
    assert!(log.contains("바뀐 도구 목록 읽기가 30초 한도를 넘었고, 살아 있는지 묻는 ping에도"), "{log}");
    let slow = hub.server_status("slowlist", MODEL).unwrap();
    assert_eq!((slow["state"].clone(), slow["restarts"].clone()), (json!("ready"), json!(0)), "{slow:#}");
    assert!(log_text(&slow).contains("바뀐 도구 목록을 제때 받지 못했습니다"), "{slow:#}");
    hub.shutdown().await;
}

/// Resource leak review, 36th pass: a call stopped before its answer (a
/// stop, the question's final reserve) asked nothing of its server. One that
/// stopped reading its input stayed ready for good, and each stopped call's
/// request and cancellation waited in the SDK to be written, its arguments
/// with them (40 stopped calls: 3 tasks to 69, measured) — for good where
/// the server's timeout outlasts a question. The check its timeout would
/// have made is now made when it would have made it.
#[tokio::test]
async fn a_stopped_call_checks_its_server_when_its_timeout_would_have() {
    if node_missing() {
        return;
    }
    let mut stuck = fake("stuck", &["stall_input", "echo"], &[]);
    stuck.timeout_secs = Some(2);
    // One only slow answers the ping: it stays as it is.
    let mut slow = fake("slow", &["slow"], &[]);
    slow.timeout_secs = Some(2);
    let config = config(vec![stuck, slow]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "stuck").await;
    ready(&hub, "slow").await;
    call(&hub, &config, "stuck__stall_input", json!({})).await.unwrap();
    let snapshot = hub.snapshot(&config);
    let stopped = |name: &str, args: Value| {
        let tool = snapshot.find(name).unwrap();
        async move {
            let cancel = CancellationToken::new();
            let stop = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                stop.cancel();
            });
            tool.call(args, &cancel).await.unwrap_err().to_string()
        }
    };
    let (stuck, slowed) = tokio::join!(stopped("stuck__echo", json!({"text":"x"})), stopped("slow__slow", json!({"ms":4_000})));
    for error in [stuck, slowed] {
        assert!(error.starts_with("cancelled:"), "{error}");
    }
    // Not before its timeout (2 s and a second), then the ping's 5 seconds.
    let stopped_at = Instant::now();
    tokio::time::sleep(Duration::from_millis(2_500)).await;
    assert_eq!(hub.server_status("stuck", MODEL).unwrap()["restarts"], 0, "checked before its timeout");
    let back = loop {
        let status = hub.server_status("stuck", MODEL).unwrap();
        if status["state"] == "ready" && status["restarts"] == 1 {
            break status;
        }
        assert!(stopped_at.elapsed() < Duration::from_secs(20), "not reconnected: {status:#}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(log_text(&back).contains("멈춘 호출의 2초 한도가 지나도록 서버가 아무 답도 하지 않았고, 살아 있는지 묻는 ping에도"), "{back:#}");
    assert_eq!(call(&hub, &config, "stuck__echo", json!({"text":"다시"})).await.unwrap()["text"], "echo: 다시");
    let slow = hub.server_status("slow", MODEL).unwrap();
    assert_eq!((slow["state"].clone(), slow["restarts"].clone()), (json!("ready"), json!(0)), "{slow:#}");
    hub.shutdown().await;
}

#[tokio::test]
async fn commands_get_their_environment_but_not_the_backends_secrets() {
    if node_missing() {
        return;
    }
    // SAFETY: no other test reads these variables.
    unsafe {
        std::env::set_var("LLM_AGENT_MCP_FLOW_SECRET", "from-backend");
        std::env::set_var("MARIADB_PASSWORD_MCP_FLOW", "db-secret");
    }
    let mut server = fake("envy", &["env"], &[("PLAIN", "visible"), ("REF", "ENV:LLM_AGENT_MCP_FLOW_SECRET")]);
    server.secret_env.insert("HIDDEN".into(), Secret("kept-secret".into()));
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "envy").await;
    for (name, expected) in [
        ("PLAIN", "visible"),
        ("REF", "from-backend"),
        ("HIDDEN", "kept-secret"),
        ("MARIADB_PASSWORD_MCP_FLOW", "<unset>"),
        ("LLM_AGENT_MCP_FLOW_SECRET", "<unset>"),
    ] {
        assert_eq!(call(&hub, &config, "envy__env", json!({"name":name})).await.unwrap()["text"], expected, "{name}");
    }
    assert_ne!(call(&hub, &config, "envy__env", json!({"name":"PATH"})).await.unwrap()["text"], "<unset>");
    hub.shutdown().await;
}

#[cfg(unix)]
fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(windows)]
fn alive(pid: i32) -> bool {
    let listed = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]).output().unwrap();
    String::from_utf8_lossy(&listed.stdout).contains(&format!("\"{pid}\""))
}

#[tokio::test]
async fn stopping_kills_the_children_a_server_started() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("parent", &["spawn_child"], &[])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    let status = ready(&hub, "parent").await;
    let server = status["pid"].as_i64().unwrap() as i32;
    let child: i32 = call(&hub, &config, "parent__spawn_child", json!({})).await.unwrap()["text"].as_str().unwrap().parse().unwrap();
    assert!(alive(child));
    hub.shutdown().await;
    let started = Instant::now();
    while (alive(child) || alive(server)) && started.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!alive(server), "the server process is gone");
    assert!(!alive(child), "the server's own child is gone too");
}

/// The descriptors past stderr that process `pid` holds, as lsof lists
/// them (`3:PIPE`); None without lsof.
#[cfg(unix)]
fn held_descriptors(pid: u32) -> Option<Vec<String>> {
    let listed = Command::new("lsof").args(["-a", "-p", &pid.to_string(), "-d", "3-4096", "-F", "ft"]).output().ok()?;
    let mut held = vec![];
    let mut fd = "";
    for line in std::str::from_utf8(&listed.stdout).ok()?.lines() {
        if let Some(number) = line.strip_prefix('f') {
            fd = number;
        } else if let Some(kind) = line.strip_prefix('t') {
            held.push(format!("{fd}:{kind}"));
        }
    }
    Some(held)
}

/// MCP review (leaks, panics, deadlocks, context), twenty-third pass:
/// macOS marks a new pipe close-on-exec only after making it, and a server
/// started meanwhile on another thread kept the pipes of the one starting
/// beside it — one in six to fifteen of eight servers started at once. A
/// server that exited was then not seen to go (its output still open in the
/// other), and each call to it waited out its timeout.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn servers_started_together_hold_nothing_of_each_other() {
    if Command::new("lsof").arg("-v").output().is_err() {
        skip("lsof is not installed");
        return;
    }
    let hub = McpHub::default();
    let (mut checked, mut holding) = (0, vec![]);
    for round in 0..16 {
        // Servers that never answer: each stays starting, its process up.
        let servers: Vec<McpServer> = (0..8)
            .map(|i| McpServer { name: format!("t{round}x{i}"), command: "/bin/sleep".into(), args: vec!["60".into()], tools: vec!["*".into()], ..Default::default() })
            .collect();
        hub.apply(&servers);
        for server in &servers {
            let status = wait_for(&hub, &server.name, |s| s["pid"].is_u64()).await;
            let pid = status["pid"].as_u64().unwrap() as u32;
            let held = held_descriptors(pid).expect("lsof lists the server's descriptors");
            checked += 1;
            if !held.is_empty() {
                holding.push(format!("{} (pid {pid}): {held:?}", server.name));
            }
        }
        hub.apply(&[]);
    }
    hub.shutdown().await;
    assert_eq!(checked, 128);
    assert!(holding.is_empty(), "servers holding descriptors of the backend (or of each other): {holding:#?}");
}

#[tokio::test]
async fn settings_apply_in_place_or_reconnect() {
    if node_missing() {
        return;
    }
    let mut server = fake("live", &["echo"], &[]);
    let mut config = config(vec![server.clone()]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    let first = ready(&hub, "live").await;
    // Description, allowed tools and timeout change without a new connection.
    server.description = "바뀐 설명".into();
    server.tools = vec!["echo".into(), "add".into()];
    config.mcp_servers = vec![server.clone()];
    hub.apply(&config.mcp_servers);
    let same = hub.server_status("live", MODEL).unwrap();
    assert_eq!(same["pid"], first["pid"]);
    assert_eq!(hub.snapshot(&config).names().collect::<Vec<_>>(), ["live__echo", "live__add"]);
    assert!(hub.snapshot(&config).prompt().contains("바뀐 설명"));
    // An entry may name the tool as the model sees it; one naming no tool
    // is reported when the tools are listed.
    server.tools = vec!["live__echo".into(), "add".into(), "ech0".into()];
    config.mcp_servers = vec![server.clone()];
    hub.apply(&config.mcp_servers);
    assert_eq!(hub.snapshot(&config).names().collect::<Vec<_>>(), ["live__echo", "live__add"]);
    let listed = probe(&server, MODEL).await.unwrap();
    assert_eq!(listed["tools"].as_array().unwrap().iter().filter(|t| t["allowed"] == true).count(), 2);
    // A question's tools follow the edits made while it runs: a tool no
    // longer allowed is refused, a new connection serves the old snapshot.
    let question = hub.snapshot(&config);
    server.tools = vec!["add".into()];
    config.mcp_servers = vec![server.clone()];
    hub.apply(&config.mcp_servers);
    let refused = question.find("live__echo").unwrap().call(json!({"text":"x"}), &CancellationToken::new()).await.unwrap_err();
    assert!(refused.to_string().starts_with("unsupported_tool:"), "{refused}");
    // The environment is the connection: a new process.
    server.env.insert("X".into(), "1".into());
    config.mcp_servers = vec![server.clone()];
    hub.apply(&config.mcp_servers);
    let renewed = wait_for(&hub, "live", |s| s["state"] == "ready" && s["pid"] != first["pid"]).await;
    assert!(renewed["pid"].is_number());
    let added = question.find("live__add").unwrap().call(json!({"a":1,"b":2}), &CancellationToken::new()).await.unwrap();
    assert_eq!(added["text"], "{\"sum\":3}", "the old snapshot calls through the new connection");
    server.tools = vec!["echo".into(), "add".into()];
    config.mcp_servers = vec![server.clone()];
    hub.apply(&config.mcp_servers);
    // A restart request reconnects at once.
    assert!(hub.restart("live"));
    let restarted = wait_for(&hub, "live", |s| s["state"] == "ready" && s["pid"] != renewed["pid"]).await;
    // The name starts the tool names: renamed in its case alone, the
    // server is listed again under it (review, eleventh pass: its tools
    // kept "live__" under "Live", and an entry "Live__echo" allowed none).
    server.name = "Live".into();
    server.tools = vec!["Live__echo".into(), "add".into()];
    config.mcp_servers = vec![server.clone()];
    hub.apply(&config.mcp_servers);
    wait_for(&hub, "Live", |s| s["state"] == "ready" && s["pid"] != restarted["pid"]).await;
    assert_eq!(hub.snapshot(&config).names().collect::<Vec<_>>(), ["Live__echo", "Live__add"]);
    assert!(hub.snapshot(&config).prompt().ends_with("- Live: 바뀐 설명"));
    server.name = "live".into();
    config.mcp_servers = vec![server.clone()];
    hub.apply(&config.mcp_servers);
    // Disabled: no process, no tools.
    server.enabled = false;
    config.mcp_servers = vec![server.clone()];
    hub.apply(&config.mcp_servers);
    let off = hub.server_status("live", MODEL).unwrap();
    assert_eq!(off["state"], "disabled");
    assert!(!hub.restart("live"));
    assert!(hub.snapshot(&config).is_empty());
    // Removed.
    config.mcp_servers.clear();
    hub.apply(&config.mcp_servers);
    assert!(hub.server_status("live", MODEL).is_none());
    hub.shutdown().await;
}

#[tokio::test]
async fn a_probe_lists_the_tools_or_says_why_not() {
    if node_missing() {
        return;
    }
    let result = probe(&fake("try", &["echo"], &[]), MODEL).await.unwrap();
    assert_eq!(result["ok"], true, "{result:#}");
    assert_eq!(result["tools"].as_array().unwrap().len(), 21);
    assert!(result["message"].as_str().unwrap().contains("fake-mcp 1.2.3"));
    let failed = probe(&fake("try", &[], &[("FAKE_MCP_EXIT_BEFORE_INIT", "1")]), MODEL).await.unwrap();
    assert_eq!(failed["ok"], false);
    assert!(failed["message"].as_str().unwrap().contains("fatal: missing configuration"), "{failed:#}");
    let invalid = probe(&McpServer { name: "a__b".into(), command: "node".into(), ..Default::default() }, MODEL).await;
    assert!(invalid.is_err());
}

/// A fake server over Streamable HTTP; killed when dropped.
struct HttpServer {
    child: Child,
    url: String,
}
impl HttpServer {
    fn start(env: &[(&str, &str)]) -> Self {
        Self::start_on(env, 0)
    }
    fn start_on(env: &[(&str, &str)], port: u16) -> Self {
        let mut command = Command::new("node");
        command.arg(fixture()).arg("--http").arg("--port").arg(port.to_string()).stdout(Stdio::piped()).stderr(Stdio::null());
        for (k, v) in env {
            command.env(k, v);
        }
        // Started as the backend starts its servers: without the pipes of a
        // stdio server another test starts meanwhile, which would then not
        // be seen to exit (see servers_started_together_hold_nothing_of_each_other).
        #[cfg(unix)]
        // SAFETY: the child only calls fcntl and close before its program runs.
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(|| {
                for fd in 3..4096 {
                    let flags = libc::fcntl(fd, libc::F_GETFD);
                    if flags >= 0 && flags & libc::FD_CLOEXEC == 0 {
                        libc::close(fd);
                    }
                }
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let port = line.trim().strip_prefix("listening ").unwrap().to_owned();
        Self { child, url: format!("http://127.0.0.1:{port}/mcp") }
    }
}
impl Drop for HttpServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// MCP review, seventeenth pass: an error for no request (`"id": null`)
/// answering the initialization — sent before there is a session — was told
/// as a session the server no longer knows, "restarted maybe". A server that
/// takes one initialization (a TypeScript-SDK server built on one transport)
/// refuses the next so; so does one refusing a token or protocol version.
#[tokio::test]
async fn a_refused_initialization_is_not_told_as_a_lost_session() {
    if node_missing() {
        return;
    }
    let remote = HttpServer::start(&[("FAKE_MCP_SINGLE_INIT", "1")]);
    let server = McpServer { name: "single".into(), url: remote.url.clone(), tools: vec!["echo".into()], ..Default::default() };
    let hub = McpHub::default();
    hub.apply(std::slice::from_ref(&server));
    ready(&hub, "single").await;
    // Reconnected, it is initialized again and refused at once.
    let started = Instant::now();
    assert!(hub.restart("single"));
    let failed = wait_for(&hub, "single", |s| s["state"] == "failed").await;
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    let error = failed["error"].as_str().unwrap();
    assert!(error.contains("Server already initialized"), "{error}");
    assert!(!error.contains("세션을 더는 모릅니다"), "{error}");
    hub.shutdown().await;
    let checked = probe(&server, MODEL).await.unwrap();
    let message = checked["message"].as_str().unwrap();
    assert!(checked["ok"] == false && message.contains("Server already initialized") && !message.contains("세션을 더는 모릅니다"), "{checked:#}");
}

#[tokio::test]
async fn http_servers_connect_with_their_headers() {
    if node_missing() {
        return;
    }
    // JSON or SSE answers; with a session, or without one (a stateless
    // server: the session ID is the server's choice).
    for (sse, stateless) in [(false, false), (true, false), (false, true), (true, true)] {
        let mut env = vec![("FAKE_MCP_AUTH", "Bearer t0k")];
        if sse {
            env.push(("FAKE_MCP_SSE", "1"));
        }
        if stateless {
            env.push(("FAKE_MCP_STATELESS", "1"));
        }
        let remote = HttpServer::start(&env);
        let mut server = McpServer { name: "web".into(), url: remote.url.clone(), tools: vec!["echo".into(), "headers".into()], ..Default::default() };
        server.secret_headers.insert("Authorization".into(), Secret("Bearer t0k".into()));
        let mut refused = McpServer { name: "nokey".into(), url: remote.url.clone(), tools: vec!["*".into()], ..Default::default() };
        refused.headers.insert("Authorization".into(), "Bearer wrong".into());
        let config = config(vec![server, refused]);
        let hub = McpHub::default();
        hub.apply(&config.mcp_servers);
        let status = ready(&hub, "web").await;
        assert_eq!(status["transport"], "http");
        assert_eq!(call(&hub, &config, "web__echo", json!({"text":"원격"})).await.unwrap()["text"], "echo: 원격", "sse {sse}, stateless {stateless}");
        assert_eq!(call(&hub, &config, "web__headers", json!({})).await.unwrap()["text"], "Bearer t0k");
        if !sse && !stateless {
            // Addresses that are not the endpoint say what to fix.
            let base = remote.url.trim_end_matches("/mcp").to_owned();
            let wrong: Vec<McpServer> = [("moved", "/moved"), ("page", "/page"), ("nope", "/nope")]
                .iter()
                .map(|(name, path)| McpServer { name: (*name).into(), url: format!("{base}{path}"), tools: vec!["*".into()], ..Default::default() })
                .collect();
            let probes = McpHub::default();
            probes.apply(&wrong);
            for (name, hint) in [("moved", "리디렉션"), ("page", "MCP 서버가 아닌 응답"), ("nope", "MCP 엔드포인트가 없습니다")] {
                let failed = wait_for(&probes, name, |s| s["state"] == "failed").await;
                assert!(failed["error"].as_str().unwrap().contains(hint), "{name}: {failed:#}");
            }
            probes.shutdown().await;
        }
        let nokey = wait_for(&hub, "nokey", |s| s["state"] == "failed").await;
        let error = nokey["error"].as_str().unwrap();
        assert!(error.starts_with("초기화하지 못했습니다: 서버가 인증을 거절했습니다") && error.contains("HTTP 401"), "{error}");
        assert!(!error.contains("rmcp::transport"), "no SDK type names: {error}");
        hub.shutdown().await;
    }
}

#[tokio::test]
async fn an_http_server_that_goes_away_is_marked_failed_and_reconnected() {
    if node_missing() {
        return;
    }
    let remote = HttpServer::start(&[]);
    let port: u16 = remote.url.rsplit(':').next().unwrap().trim_end_matches("/mcp").parse().unwrap();
    let server = McpServer { name: "web".into(), url: remote.url.clone(), tools: vec!["echo".into()], ..Default::default() };
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "web").await;
    drop(remote);
    // The call says why, and the server stops being shown (and offered) as
    // connected instead of failing every call while it looks ready.
    let error = call(&hub, &config, "web__echo", json!({"text":"x"})).await.unwrap_err().to_string();
    assert!(error.starts_with("mcp_server_unavailable:"), "{error}");
    assert!(error.len() > "mcp_server_unavailable: the connection to MCP server web closed during the call".len(), "the cause is kept: {error}");
    let failed = wait_for(&hub, "web", |s| s["state"] == "failed").await;
    assert!(failed["error"].as_str().unwrap().contains("연결이 거부되었습니다"), "{failed:#}");
    assert!(error.contains("연결이 거부되었습니다"), "{error}");
    assert!(!error.contains("may have taken effect"), "refused, it reached no server: {error}");
    assert!(hub.snapshot(&config).is_empty());
    let back = HttpServer::start_on(&[], port);
    wait_for(&hub, "web", |s| s["state"] == "ready").await;
    assert_eq!(call(&hub, &config, "web__echo", json!({"text":"돌아옴"})).await.unwrap()["text"], "echo: 돌아옴");
    drop(back);
    hub.shutdown().await;
}

#[tokio::test]
async fn a_rate_limit_or_a_proxy_error_is_not_a_lost_connection() {
    if node_missing() {
        return;
    }
    // A rate limit, a proxy error, a body or content the server refuses:
    // about that one request.
    for (status, code, said) in [
        ("429", "mcp_rate_limited:", "요청 수를 제한"),
        ("502", "mcp_request_failed:", "서버 쪽 오류"),
        ("413", "mcp_request_failed:", "HTTP 413 Payload Too Large"),
        ("422", "mcp_request_failed:", "HTTP 422"),
        ("504", "mcp_request_failed:", "HTTP 504"),
    ] {
        let remote = HttpServer::start(&[("FAKE_MCP_CALL_STATUS", status), ("FAKE_MCP_CALL_STATUS_TOOL", "echo")]);
        let server = McpServer { name: "limited".into(), url: remote.url.clone(), tools: vec!["echo".into(), "slow".into()], ..Default::default() };
        let config = config(vec![server]);
        let hub = McpHub::default();
        hub.apply(&config.mcp_servers);
        ready(&hub, "limited").await;
        // Another call on the session, under way meanwhile, is not ended.
        let slow = hub.snapshot(&config).find("limited__slow").unwrap();
        let under_way = tokio::spawn(async move { slow.call(json!({"ms":1_000}), &CancellationToken::new()).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        let error = call(&hub, &config, "limited__echo", json!({"text":"x"})).await.unwrap_err().to_string();
        assert!(error.starts_with(code), "{status}: {error}");
        assert!(error.contains(said), "{error}");
        // A server's or a proxy's error (a proxy's 504 for a long call) does
        // not say whether the tool ran; a refusal (4xx) does (twenty-fourth pass).
        assert_eq!(error.contains("may have taken effect"), status.starts_with('5'), "{status}: {error}");
        assert_eq!(under_way.await.unwrap().unwrap()["text"], "slept", "{status}");
        if status == "429" {
            assert_eq!(llm_agent::tools::recovery::describe(&error)["class"], "transient");
        }
        // The session stays: no reconnection, the tools stay offered, and
        // the next call goes through it.
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        let status_now = hub.server_status("limited", MODEL).unwrap();
        assert_eq!((status_now["state"].clone(), status_now["restarts"].clone()), (json!("ready"), json!(0)), "{status}: {status_now:#}");
        assert!(!hub.snapshot(&config).is_empty());
        let again = call(&hub, &config, "limited__echo", json!({"text":"다시"})).await;
        assert_eq!(again.unwrap()["text"], "echo: 다시", "{status}");
        assert_eq!(hub.server_status("limited", MODEL).unwrap()["restarts"], 0);
        hub.shutdown().await;
    }
}

#[tokio::test]
async fn a_server_that_forgot_the_session_is_reconnected_at_once() {
    if node_missing() {
        return;
    }
    // A restarted server built on the TypeScript SDK's example answers a
    // session it no longer knows with HTTP 400 and an error for no request
    // (id null): the call waited out its timeout, and every one after it.
    for sse in [false, true] {
        let mut env = vec![("FAKE_MCP_FORGET", "1")];
        if sse {
            env.push(("FAKE_MCP_SSE", "1"));
        }
        let remote = HttpServer::start(&env);
        let server = McpServer { name: "ts".into(), url: remote.url.clone(), tools: vec!["echo".into(), "forget".into()], timeout_secs: Some(30), ..Default::default() };
        let config = config(vec![server]);
        let hub = McpHub::default();
        hub.apply(&config.mcp_servers);
        ready(&hub, "ts").await;
        call(&hub, &config, "ts__forget", json!({})).await.unwrap();
        let started = Instant::now();
        let error = call(&hub, &config, "ts__echo", json!({"text":"x"})).await.unwrap_err().to_string();
        assert!(started.elapsed() < Duration::from_secs(3), "sse {sse}: took {:?}", started.elapsed());
        assert!(error.starts_with("mcp_server_unavailable:") && error.contains("세션을 더는 모릅니다"), "{error}");
        wait_for(&hub, "ts", |s| s["state"] == "ready" && s["restarts"] == 1).await;
        assert_eq!(call(&hub, &config, "ts__echo", json!({"text":"새 세션"})).await.unwrap()["text"], "echo: 새 세션");
        hub.shutdown().await;
    }
}

/// The fake HTTP server's counts: event streams opened, sessions initialized.
async fn counts(remote: &HttpServer) -> Value {
    reqwest::get(format!("{}/counts", remote.url.trim_end_matches("/mcp"))).await.unwrap().json().await.unwrap()
}

#[tokio::test]
async fn event_streams_that_break_as_they_open_are_opened_again_at_a_pace() {
    if node_missing() {
        return;
    }
    // Twenty-fifth pass: the SDK opens the server's event stream (GET)
    // again at once when it breaks, and when it ends asking for no wait
    // ("retry: 0") — some fourteen thousand GETs a second, for as long as
    // the connection lasted, the server shown ready.
    for mode in ["break", "retry0"] {
        let remote = HttpServer::start(&[("FAKE_MCP_GET", mode)]);
        let server = McpServer { name: "streams".into(), url: remote.url.clone(), tools: vec!["echo".into()], ..Default::default() };
        let config = config(vec![server]);
        let hub = McpHub::default();
        hub.apply(&config.mcp_servers);
        ready(&hub, "streams").await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        // Eight at once, then one a second (eleven by now; tens of thousands before).
        let opened = counts(&remote).await["streams"].as_u64().unwrap();
        assert!((2..=20).contains(&opened), "{mode}: {opened} streams in about three seconds");
        assert_eq!(call(&hub, &config, "streams__echo", json!({"text":"x"})).await.unwrap()["text"], "echo: x", "{mode}");
        assert_eq!(hub.server_status("streams", MODEL).unwrap()["restarts"], 0, "{mode}");
        hub.shutdown().await;
    }
}

#[tokio::test]
async fn a_session_the_server_forgot_is_listed_again() {
    if node_missing() {
        return;
    }
    // A server following the specification answers a session it forgot
    // with HTTP 404, and the SDK makes a new one by itself, without a word
    // to its handler. Deployed again with other tools, the server was still
    // offered with its old ones (twenty-fifth pass): one removed, called in
    // vain, and the new one never offered.
    let remote = HttpServer::start(&[("FAKE_MCP_SPEC_SESSIONS", "1")]);
    let server = McpServer { name: "spec".into(), url: remote.url.clone(), tools: vec!["*".into()], ..Default::default() };
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "spec").await;
    let offered = |hub: &McpHub| hub.snapshot(&config).names().map(str::to_owned).collect::<Vec<_>>();
    assert!(offered(&hub).contains(&"spec__fail".to_owned()) && !offered(&hub).contains(&"spec__fresh".to_owned()));
    reqwest::get(format!("{}/redeploy", remote.url.trim_end_matches("/mcp"))).await.unwrap();
    // The call goes through the new session, and the tools are read again
    // on the same connection.
    assert_eq!(call(&hub, &config, "spec__echo", json!({"text":"x"})).await.unwrap()["text"], "echo: x");
    let status = wait_for(&hub, "spec", |s| s["tools"].as_array().unwrap().iter().any(|t| t["name"] == "fresh")).await;
    assert!(!status["tools"].as_array().unwrap().iter().any(|t| t["name"] == "fail"), "{status:#}");
    assert!(offered(&hub).contains(&"spec__fresh".to_owned()) && !offered(&hub).contains(&"spec__fail".to_owned()));
    assert_eq!((status["state"].clone(), status["restarts"].clone()), (json!("ready"), json!(0)), "{status:#}");
    assert!(log_text(&status).contains("세션을 잊어"), "{}", log_text(&status));
    assert_eq!(counts(&remote).await["initializations"], 2);
    hub.shutdown().await;
}

#[tokio::test]
async fn a_server_forgetting_each_new_session_is_not_listed_without_end() {
    if node_missing() {
        return;
    }
    // Behind a load balancer without sticky sessions each listing finds its
    // session forgotten: read again for each session made anew, the list
    // would be read, and a session made, every second for good.
    let remote = HttpServer::start(&[("FAKE_MCP_SPEC_SESSIONS", "1"), ("FAKE_MCP_FORGET_LISTS", "1")]);
    let server = McpServer { name: "balanced".into(), url: remote.url.clone(), tools: vec!["echo".into()], ..Default::default() };
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "balanced").await;
    reqwest::get(format!("{}/redeploy", remote.url.trim_end_matches("/mcp"))).await.unwrap();
    assert_eq!(call(&hub, &config, "balanced__echo", json!({"text":"x"})).await.unwrap()["text"], "echo: x");
    tokio::time::sleep(Duration::from_secs(3)).await;
    let settled = counts(&remote).await["initializations"].as_u64().unwrap();
    assert!(settled >= 3, "the list was read again once: {settled}");
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(counts(&remote).await["initializations"].as_u64().unwrap(), settled, "no listing without end");
    assert_eq!(hub.server_status("balanced", MODEL).unwrap()["state"], "ready");
    hub.shutdown().await;
}

#[tokio::test]
async fn a_server_that_stops_answering_is_reconnected() {
    if node_missing() {
        return;
    }
    // One server only slow, one that stops answering anything (a handler
    // deadlocked) while it still reads its input: each call times out.
    let mut slow = fake("slow", &["slow"], &[]);
    slow.timeout_secs = Some(1);
    let mut wedged = fake("wedged", &["wedge", "echo"], &[("FAKE_MCP_WEDGE", "1")]);
    wedged.timeout_secs = Some(1);
    let config = config(vec![slow, wedged]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "slow").await;
    ready(&hub, "wedged").await;
    let (slowed, stopped) = tokio::join!(
        call(&hub, &config, "slow__slow", json!({"ms":3_000})),
        call(&hub, &config, "wedged__wedge", json!({}))
    );
    for outcome in [slowed, stopped] {
        assert!(outcome.unwrap_err().to_string().starts_with("mcp_timeout:"));
    }
    // The stopped one does not answer a ping either: it is taken for
    // stopped and started again, rather than left ready with every call
    // waiting out its timeout.
    let started = Instant::now();
    let back = loop {
        let status = hub.server_status("wedged", MODEL).unwrap();
        if status["state"] == "ready" && status["restarts"] == 1 {
            break status;
        }
        assert!(started.elapsed() < Duration::from_secs(20), "not reconnected: {status:#}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(log_text(&back).contains("ping에도 5초 안에 답하지 않아"), "{back:#}");
    assert_eq!(call(&hub, &config, "wedged__echo", json!({"text":"다시"})).await.unwrap()["text"], "echo: 다시");
    // The slow one answered its ping meanwhile: it stays as it is.
    let slow = hub.server_status("slow", MODEL).unwrap();
    assert_eq!((slow["state"].clone(), slow["restarts"].clone()), (json!("ready"), json!(0)), "{slow:#}");
    hub.shutdown().await;
}

/// `slow` calls of `ms` each, started `at` seconds after `start`: each
/// call's tag and outcome (Ok, or its error).
async fn slow_calls(tool: &std::sync::Arc<llm_agent::mcp::Offered>, start: Instant, plan: &[(&str, f64, u64)]) -> Vec<(String, Result<(), String>)> {
    let tasks: Vec<_> = plan
        .iter()
        .map(|(tag, at, ms)| {
            let (tool, tag, at, ms) = (tool.clone(), (*tag).to_owned(), *at, *ms);
            tokio::spawn(async move {
                tokio::time::sleep_until((start + Duration::from_secs_f64(at)).into()).await;
                let outcome = tool.call(json!({"ms": ms}), &CancellationToken::new()).await;
                (tag, outcome.map(|_| ()).map_err(|e| e.to_string()))
            })
        })
        .collect();
    let mut outcomes = vec![];
    for task in tasks {
        outcomes.push(task.await.unwrap());
    }
    outcomes
}

/// Several conversations, one HTTP server answering in plain JSON: one call
/// times out while fifteen others' run within their limit and one more
/// comes. The SDK carried 16 such requests and queued the rest, the ping
/// after the timeout too: unanswered in five seconds, the busy server was
/// taken for stopped and reconnected, the sixteen others failing two
/// seconds before they would have ended.
#[tokio::test]
async fn many_conversations_on_one_http_server_do_not_take_it_for_stopped() {
    if node_missing() {
        return;
    }
    let remote = HttpServer::start(&[]);
    let server = McpServer { name: "web".into(), url: remote.url.clone(), tools: vec!["slow".into()], timeout_secs: Some(10), ..Default::default() };
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "web").await;
    let tool = hub.snapshot(&config).find("web__slow").unwrap();
    let mut plan = vec![("stuck", 0.0, 60_000)];
    plan.extend(std::iter::repeat_n(("running", 7.0, 9_000), 15));
    plan.push(("later", 7.5, 8_000));
    let outcomes = slow_calls(&tool, Instant::now(), &plan).await;
    for (tag, outcome) in &outcomes {
        if tag == "stuck" {
            assert!(outcome.as_ref().unwrap_err().starts_with("mcp_timeout:"), "{outcome:?}");
        } else {
            assert!(outcome.is_ok(), "{tag}: {outcome:?}");
        }
    }
    let status = hub.server_status("web", MODEL).unwrap();
    assert!(!log_text(&status).contains("ping에도"), "{}", log_text(&status));
    assert_eq!((status["state"].clone(), status["restarts"].clone()), (json!("ready"), json!(0)), "{status:#}");
    hub.shutdown().await;
}

/// A server that handles one message at a time, a ping too: the ping after
/// a timeout waits behind other conversations' calls, which it answers one
/// by one meanwhile. An answer while the ping waits says it is alive; it
/// was reconnected, the calls still in its queue failing.
#[tokio::test]
async fn a_server_answering_calls_while_its_ping_waits_is_not_reconnected() {
    if node_missing() {
        return;
    }
    let mut server = fake("serial", &["slow"], &[("FAKE_MCP_SERIAL", "1")]);
    server.timeout_secs = Some(8);
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "serial").await;
    let tool = hub.snapshot(&config).find("serial__slow").unwrap();
    // Run from 0 to 8.5 s (timed out at 8, the ping then behind the queue),
    // then the queue from 8.5 to 14.1 s, each within its limit at 15.
    let mut plan = vec![("stuck", 0.0, 8_500)];
    plan.extend(std::iter::repeat_n(("queued", 7.0, 800), 7));
    let outcomes = slow_calls(&tool, Instant::now(), &plan).await;
    for (tag, outcome) in &outcomes {
        if tag == "stuck" {
            assert!(outcome.as_ref().unwrap_err().starts_with("mcp_timeout:"), "{outcome:?}");
        } else {
            assert!(outcome.is_ok(), "{tag}: {outcome:?}");
        }
    }
    let status = hub.server_status("serial", MODEL).unwrap();
    assert!(!log_text(&status).contains("ping에도"), "{}", log_text(&status));
    assert_eq!(status["restarts"], 0, "{status:#}");
    hub.shutdown().await;
}

async fn ask(app: &std::sync::Arc<llm_agent::app::App>, message: &str) -> (anyhow::Result<agent::Answer>, Vec<Value>) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let result = agent::answer(
        app,
        Question { conversation_id: "mcp".into(), message: message.into(), history: vec![] },
        Events::new(Some(tx)),
        CancellationToken::new(),
    )
    .await;
    let mut events = vec![];
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    (result, events)
}

#[tokio::test]
async fn the_model_calls_mcp_tools_like_its_own() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("fake", &["echo", "fail", "big"], &[])]);
    let llm = Scripted::new(vec![
        calls(vec![
            support::call("m1", "fake__echo", json!({"text":"이슈 123"})),
            support::call("m2", "fake__fail", json!({})),
            support::call("m3", "fake__big", json!({"chars":180_000})),
            support::call("m4", "fake__echo", json!({})),
            // The server's own name for the tool, as its descriptions say.
            support::call("m5", "echo", json!({"text":"원래 이름"})),
            support::call("m6", "echo", json!({})),
        ]),
        text("끝"),
    ]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "fake").await;
    let (result, events) = ask(&app, "이슈 123 상태 알려줘").await;
    let answer = result.unwrap();
    assert_eq!(answer.answer, "끝");
    let requests = llm.requests();
    let first = &requests[0];
    let tools: Vec<&str> = first["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap()).collect();
    for name in ["fake__echo", "fake__fail", "fake__big", "search"] {
        assert!(tools.contains(&name), "{name} in {tools:?}");
    }
    let system = first["messages"][0]["content"].as_str().unwrap();
    assert!(system.ends_with("- fake: 가짜 MCP 서버 fake"), "{system}");
    let second = &requests[1];
    assert_eq!(tool_result(second, "m1")["data"]["text"], "echo: 이슈 123");
    let failed = tool_result(second, "m2");
    assert_eq!(failed["status"], "error");
    assert_eq!(failed["error"], "mcp_tool_error: boom: the tool failed");
    // A result past the budget is cut to its start, the rest archived.
    let big = tool_result(second, "m3");
    assert_eq!(big["truncated"], true);
    assert_eq!(big["next_cursor"]["tool"], "history");
    assert!(big["data"]["text"].as_str().unwrap().len() < 180_000);
    let renamed = tool_result(second, "m5");
    assert_eq!(renamed["data"]["text"], "echo: 원래 이름");
    assert_eq!(renamed["data"]["adjusted_arguments"], json!(["tool name echo was taken as fake__echo; call it fake__echo"]));
    let refused = tool_result(second, "m4");
    assert!(refused["error"].as_str().unwrap().starts_with("missing_argument: text"), "{refused}");
    let refused = tool_result(second, "m6");
    assert_eq!(refused["error"], "missing_argument: text is required by fake__echo", "the refusal names the tool to call");
    // Progress lines and the trace name the server and tool.
    let started = ev(&events, "tool");
    assert_eq!(started[0]["summary"], "fake · echo \"이슈 123\"");
    assert_eq!(started[3]["summary"], "fake · echo", "a call refused before it ran is named alike");
    assert_eq!(answer.trace[3]["summary"], "fake · echo");
    assert_eq!(started[5]["summary"], "fake · echo", "by the server's name for it too");
    let done = ev(&events, "tool_done");
    assert_eq!(done.len(), 6);
    // Under the name the model sees, whichever name it called.
    for started in &started[4..] {
        let done = done.iter().find(|d| d["id"] == started["id"]).unwrap();
        assert_eq!((started["name"].clone(), done["name"].clone()), (json!("fake__echo"), json!("fake__echo")));
    }
    assert_eq!((answer.trace[4]["tool"].clone(), answer.trace[5]["tool"].clone()), (json!("fake__echo"), json!("fake__echo")));
    assert_eq!(answer.trace[0]["tool"], "fake__echo");
    assert_eq!(answer.trace[0]["summary"], "fake · echo \"이슈 123\"");
    assert_eq!(answer.trace[1]["status"], "error");
    app.mcp.shutdown().await;
}

#[tokio::test]
async fn many_large_mcp_results_are_cut_to_fit_and_read_back_from_history() {
    if node_missing() {
        return;
    }
    let mut config = config(vec![fake("fake", &["big"], &[])]);
    config.llm.context_tokens = 40_000;
    config.llm.output_tokens = 4_000;
    let calls_made: Vec<_> = (0..8).map(|i| support::call(&format!("b{i}"), "fake__big", json!({"chars":60_000 + i}))).collect();
    let llm = Scripted::new(vec![calls(calls_made), text("끝")]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "fake").await;
    let (result, _) = ask(&app, "크게 여러 번").await;
    assert_eq!(result.unwrap().answer, "끝");
    let second = &llm.requests()[1];
    let budget = config.result_budget();
    let mut archives = vec![];
    for i in 0..8 {
        let shown = tool_result(second, &format!("b{i}"));
        assert_eq!(shown["status"], "ok");
        assert_eq!(shown["truncated"], true, "{i}");
        assert_eq!(shown["next_cursor"]["tool"], "history");
        archives.push(shown["next_cursor"]["id"].as_u64().unwrap());
    }
    let messages: Vec<_> = messages(second, "tool");
    let total: usize = messages.iter().map(|m| llm_agent::context::count(m, MODEL)).sum();
    assert!(total <= 8 * (budget + 200), "each result within its budget: {total}");
    assert!(llm_agent::context::count(second, MODEL) < config.llm.context_tokens - config.llm.output_tokens, "the request fits the context");
    assert_eq!(archives.iter().collect::<std::collections::BTreeSet<_>>().len(), 8, "one archive per result");
    // The rest of a cut result is read from the history where it was
    // archived, the next question in the same conversation too: from where
    // the cut text stopped, as its next_cursor says.
    let cut = tool_result(second, "b3");
    let shown = cut["data"]["text"].as_str().unwrap().chars().count();
    llm.push(vec![
        calls(vec![
            support::call("h1", "history", json!({"action":"read","id":archives[3],"offset":cut["next_cursor"]["offset"]})),
            support::call("h2", "history", json!({"action":"read","id":archives[3],"offset":50_000})),
        ]),
        text("다 읽음"),
    ]);
    let (result, _) = ask(&app, "잘린 결과 이어 읽어").await;
    assert_eq!(result.unwrap().answer, "다 읽음");
    let requests = llm.requests();
    let tools: Vec<&str> = requests[2]["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap()).collect();
    assert!(tools.contains(&"history") && tools.contains(&"fake__big"), "{tools:?}");
    for id in ["h1", "h2"] {
        let read = tool_result(&requests[3], id);
        assert_eq!(read["status"], "ok", "{read}");
        assert!(read["data"]["text"].as_str().unwrap().contains("0123456789"), "{id}: {read}");
    }
    // The first read goes on with the next character, not the shown start.
    let first = tool_result(&requests[3], "h1")["data"]["text"].as_str().unwrap().to_owned();
    assert!(!first.contains("tool_archive") && first.starts_with(char::from(b'0' + (shown % 10) as u8)), "{}", first.chars().take(80).collect::<String>());
    app.mcp.shutdown().await;
}

#[tokio::test]
async fn too_many_allowed_mcp_tools_are_named_as_what_does_not_fit() {
    if node_missing() {
        return;
    }
    // Long descriptions over the minimum context: the frame fits without the
    // MCP tools and not with them — past the context (counted with the
    // request) and past twice the context (refused before that).
    for (wide, range) in [("20", 12_000..24_000), ("40", 24_000..60_000)] {
        let mut config = config(vec![fake("wide", &["*"], &[("FAKE_MCP_WIDE", wide)])]);
        config.llm.context_tokens = 12_000;
        config.llm.output_tokens = 2_000;
        let llm = Scripted::new(vec![text("끝")]);
        let (app, _dir) = app(config.clone(), llm.clone());
        app.mcp.apply(&config.mcp_servers);
        ready(&app.mcp, "wide").await;
        let tokens: u64 = app.mcp.server_status("wide", MODEL).unwrap()["tools"].as_array().unwrap().iter().map(|t| t["tokens"].as_u64().unwrap()).sum();
        assert!(range.contains(&tokens), "the fixture is as wide as meant: {tokens}");
        // Asked on and on meanwhile, the conversation keeps no more in its
        // context than one question.
        for _ in 0..3 {
            let (result, _) = ask(&app, "안녕").await;
            let Err(error) = result else { panic!("the question was answered") };
            let shown = error.downcast_ref::<agent::UserFacing>().map(|e| e.0.clone()).unwrap_or_else(|| error.to_string());
            assert!(shown.contains("MCP 탭에서 허용 도구를 줄여주세요"), "{wide}: {shown}");
        }
        assert!(llm.requests().is_empty(), "nothing was sent");
        let claim = app.sessions.open("mcp", Duration::from_secs(60), 10, CancellationToken::new());
        let active = claim.conversation.lock().await.history.bundles.iter().filter(|b| b.active).count();
        app.sessions.finish("mcp", claim.run);
        assert!(active <= 1, "{wide}: {active} questions in the context");
        app.mcp.shutdown().await;
    }
}

#[tokio::test]
async fn mcp_calls_stop_at_the_final_reserve() {
    if node_missing() {
        return;
    }
    let mut server = fake("fake", &["slow"], &[]);
    server.timeout_secs = Some(120);
    let mut config = config(vec![server]);
    config.agent.run_seconds = 49;
    let llm = Scripted::new(vec![calls(vec![support::call("s1", "fake__slow", json!({"ms":30_000}))]), text("끝")]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "fake").await;
    let started = Instant::now();
    let (result, events) = ask(&app, "느린 도구").await;
    assert_eq!(result.unwrap().answer, "끝");
    assert!(started.elapsed() < Duration::from_secs(10), "stopped at the reserve, not after 30 s: {:?}", started.elapsed());
    let second = &llm.requests()[1];
    assert_eq!(tool_result(second, "s1")["status"], "cancelled");
    assert_eq!(second["tool_choice"], "none", "the final answer is asked without tools");
    assert_eq!(ev(&events, "tool_done")[0]["status"], "cancelled");
    let status = wait_for(&app.mcp, "fake", |s| log_text(s).contains("cancelled")).await;
    assert_eq!(status["tools"].as_array().unwrap().iter().find(|t| t["name"] == "slow").unwrap()["cancelled"], 1);
    app.mcp.shutdown().await;
}

/// The calls a server's tool shows in its status.
fn tool_calls(app: &llm_agent::app::App, server: &str, tool: &str) -> u64 {
    let status = app.mcp.server_status(server, MODEL).unwrap();
    status["tools"].as_array().unwrap().iter().find(|t| t["name"] == tool).unwrap()["calls"].as_u64().unwrap()
}

/// Mcp and context review, thirteenth pass: a response whose own calls left
/// no room for their results was run anyway — an MCP tool's arguments (a
/// document to file) can be that large — and the question then ended as one
/// whose material did not fit, after the tool had taken effect, to take it
/// again when asked again.
#[tokio::test]
async fn calls_that_leave_no_room_for_their_results_are_not_run() {
    if node_missing() {
        return;
    }
    let mut config = config(vec![fake("fake", &["echo"], &[])]);
    config.llm.context_tokens = 24_000;
    config.llm.output_tokens = 2_000;
    let huge = json!({"text":"이슈 본문 ".repeat(6_000)});
    let llm = Scripted::new(vec![
        calls(vec![support::call("h1", "fake__echo", huge.clone())]),
        calls(vec![support::call("s1", "fake__echo", json!({"text":"짧게"}))]),
        text("끝"),
    ]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "fake").await;
    let (result, _) = ask(&app, "긴 이슈를 만들어줘").await;
    assert_eq!(result.unwrap().answer, "끝");
    let requests = llm.requests();
    assert!(!requests[1].to_string().contains("\"h1\""), "the large call is not in the conversation");
    let state = requests[1]["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().to_owned();
    assert!(state.contains("하나도 실행하지 않았다"), "{state}");
    assert_eq!(tool_result(&requests[2], "s1")["data"]["text"], "echo: 짧게");
    assert_eq!(tool_calls(&app, "fake", "echo"), 1, "only the call that fits ran");
    // Asked for again and again, nothing runs and the question ends as one
    // whose material does not fit.
    llm.push((0..3).map(|i| calls(vec![support::call(&format!("again{i}"), "fake__echo", huge.clone())])).collect());
    let (result, _) = ask(&app, "다시 긴 이슈를 만들어줘").await;
    let error = result.err().expect("not answered").to_string();
    assert!(error.contains("한 번에 담기지 않아"), "{error}");
    assert_eq!(tool_calls(&app, "fake", "echo"), 1, "none of them ran");
    app.mcp.shutdown().await;
}

/// Mcp and context review, thirteenth pass: the calls of a question stopped
/// while they ran left the conversation with it, so the next question did not
/// know an MCP tool had been asked (and may have taken effect).
#[tokio::test]
async fn a_stopped_question_keeps_the_calls_it_made() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("fake", &["echo", "slow"], &[])]);
    let llm = Scripted::new(vec![
        calls(vec![support::call("e1", "fake__echo", json!({"text":"이슈 생성"})), support::call("w1", "fake__slow", json!({"ms":30_000}))]),
        text("다음 답"),
    ]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "fake").await;
    let stop = CancellationToken::new();
    let stopper = {
        let (app, stop) = (app.clone(), stop.clone());
        tokio::spawn(async move {
            while tool_calls(&app, "fake", "echo") == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            stop.cancel();
        })
    };
    let started = Instant::now();
    let stopped = agent::answer(&app, Question { conversation_id: "mcp".into(), message: "이슈를 만들어줘".into(), history: vec![] }, Events::new(None), stop).await;
    stopper.await.unwrap();
    assert_eq!(stopped.err().map(|e| e.to_string()).as_deref(), Some("cancelled"));
    assert!(started.elapsed() < Duration::from_secs(10), "the slow call stopped with the question");
    let (result, _) = ask(&app, "만들어졌어?").await;
    assert_eq!(result.unwrap().answer, "다음 답");
    let request = llm.requests().last().unwrap().clone();
    assert_eq!(tool_result(&request, "e1")["data"]["text"], "echo: 이슈 생성");
    let slow = tool_result(&request, "w1");
    assert_eq!((slow["status"].as_str(), slow["recovery"]["code"].as_str()), (Some("cancelled"), Some("cancelled")), "{slow}");
    // MCP review, seventeenth pass: the next question is told the stopped
    // call was sent and may have taken effect, not only "cancelled" (taken
    // for no effect, asked again).
    assert!(slow["error"].as_str().unwrap().contains("may still have taken effect"), "{slow}");
    app.mcp.shutdown().await;
}

/// MCP review, fourteenth pass: a response holding the same call twice (a
/// model's parallel calls now and then do) ran it twice — an issue filed
/// twice, a message sent twice. The repeat is refused, as the agent's own
/// repeated query is: the arguments compared whatever their order, the tool
/// by either of its names.
#[tokio::test]
async fn a_call_repeated_within_one_response_runs_once() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("fake", &["echo", "add"], &[])]);
    let llm = Scripted::new(vec![
        calls(vec![
            support::call("e1", "fake__echo", json!({"text":"이슈 생성"})),
            support::call("e2", "fake__echo", json!({"text":"이슈 생성"})),
            support::call("e3", "echo", json!({"text":"이슈 생성"})),
            support::call("e4", "fake__echo", json!({"text":"다른 이슈"})),
            support::call("a1", "fake__add", json!({"a":1,"b":2})),
            support::call("a2", "fake__add", json!({"b":2,"a":1})),
        ]),
        text("끝"),
    ]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "fake").await;
    let (result, events) = ask(&app, "이슈를 만들어줘").await;
    assert_eq!(result.unwrap().answer, "끝");
    let second = &llm.requests()[1];
    assert_eq!(tool_result(second, "e1")["data"]["text"], "echo: 이슈 생성");
    assert_eq!(tool_result(second, "e4")["data"]["text"], "echo: 다른 이슈");
    assert_eq!(tool_result(second, "a1")["data"]["text"], "{\"sum\":3}");
    for id in ["e2", "e3", "a2"] {
        let refused = tool_result(second, id);
        assert!(refused["error"].as_str().unwrap().starts_with("repeated_call:"), "{id}: {refused}");
    }
    assert_eq!((tool_calls(&app, "fake", "echo"), tool_calls(&app, "fake", "add")), (2, 1));
    assert_eq!(ev(&events, "tool_done").len(), 6, "every progress line closes");
    app.mcp.shutdown().await;
}

/// MCP review, fourteenth pass: a tool the conversation called before, no
/// longer offered (its server off or not connected, the tool not allowed),
/// was told to the model as one that "does not exist" — which the model may
/// pass on to the user. It is told why it is not there.
#[tokio::test]
async fn a_tool_called_before_and_not_offered_now_is_told_why() {
    if node_missing() {
        return;
    }
    let mut config = config(vec![fake("fake", &["echo", "add"], &[]), fake("gone", &["*"], &[("FAKE_MCP_EXIT_BEFORE_INIT", "1")])]);
    let llm = Scripted::new(vec![
        calls(vec![
            support::call("e1", "fake__echo", json!({"text":"x"})),
            support::call("g1", "gone__echo", json!({"text":"x"})),
            support::call("n1", "nosuch__echo", json!({"text":"x"})),
            support::call("n2", "fake__nosuch", json!({})),
        ]),
        text("끝"),
    ]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "fake").await;
    wait_for(&app.mcp, "gone", |s| s["state"] == "failed").await;
    config.mcp_servers[0].tools = vec!["add".into()];
    app.mcp.apply(&config.mcp_servers);
    let (result, _) = ask(&app, "에코").await;
    assert_eq!(result.unwrap().answer, "끝");
    let second = &llm.requests()[1];
    assert_eq!(tool_result(second, "e1")["error"], "unsupported_tool: fake__echo is not offered now; use the offered tools");
    let gone = tool_result(second, "g1");
    assert!(gone["error"].as_str().unwrap().starts_with("mcp_server_unavailable: MCP server gone is not connected (failed"), "{gone}");
    assert_eq!(gone["recovery"]["action"], "answer_with_gathered_evidence");
    assert_eq!(tool_result(second, "n1")["error"], "unsupported_tool: nosuch__echo does not exist");
    assert_eq!(tool_result(second, "n2")["error"], "unsupported_tool: fake__nosuch does not exist");
    config.mcp_servers[0].enabled = false;
    app.mcp.apply(&config.mcp_servers);
    llm.push(vec![calls(vec![support::call("a1", "fake__add", json!({"a":1,"b":2}))]), text("끝")]);
    let (result, _) = ask(&app, "더하기").await;
    assert_eq!(result.unwrap().answer, "끝");
    assert_eq!(tool_result(&llm.requests()[3], "a1")["error"], "mcp_server_unavailable: MCP server fake is turned off");
    app.mcp.shutdown().await;
}

#[tokio::test]
async fn a_server_name_for_a_tool_two_servers_have_is_not_guessed() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("alpha", &["echo"], &[]), fake("beta", &["echo"], &[])]);
    let llm = Scripted::new(vec![calls(vec![support::call("e1", "echo", json!({"text":"어느 쪽"}))]), text("끝")]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "alpha").await;
    ready(&app.mcp, "beta").await;
    let (result, _) = ask(&app, "에코").await;
    assert_eq!(result.unwrap().answer, "끝");
    let refused = tool_result(&llm.requests()[1], "e1");
    assert_eq!(refused["status"], "unsupported");
    assert_eq!(refused["error"], "unsupported_tool: echo is a tool of several MCP servers; call one of alpha__echo, beta__echo");
    app.mcp.shutdown().await;
}

#[tokio::test]
async fn an_agent_tool_name_is_not_taken_for_a_server_tool() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("srv", &["history"], &[("FAKE_MCP_BUILTIN_NAME", "1")])]);
    let llm = Scripted::new(vec![calls(vec![support::call("h1", "history", json!({"action":"search","query":"x"}))]), text("끝")]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "srv").await;
    let (result, _) = ask(&app, "이력").await;
    assert_eq!(result.unwrap().answer, "끝");
    // The agent's own history tool is not offered yet (nothing left the
    // context): the call is told so, not run on the server's tool.
    let refused = tool_result(&llm.requests()[1], "h1");
    assert_eq!(refused["error"], "unsupported_tool: history is not offered now; use the offered tools", "{refused}");
    app.mcp.shutdown().await;
}

#[tokio::test]
async fn a_question_keeps_its_tools_while_the_server_reconnects() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("flaky", &["echo", "crash"], &[])]);
    let llm = Scripted::new(vec![
        calls(vec![support::call("c1", "flaky__crash", json!({}))]),
        calls(vec![support::call("c2", "flaky__echo", json!({"text":"다시"}))]),
        text("끝"),
    ]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "flaky").await;
    let (result, _) = ask(&app, "두 번 불러줘").await;
    assert_eq!(result.unwrap().answer, "끝");
    let requests = llm.requests();
    let crashed = tool_result(&requests[1], "c1");
    assert_eq!(crashed["recovery"]["code"], "mcp_server_unavailable");
    // The same tool definitions in every request of the question.
    assert_eq!(requests[0]["tools"], requests[2]["tools"]);
    let echo = tool_result(&requests[2], "c2");
    assert!(echo["status"] == "ok" || echo["recovery"]["code"] == "mcp_server_unavailable", "{echo}");
    app.mcp.shutdown().await;
}

/// A provider's refusal of the tool `name` at a place among a request's tools.
type Refusal = fn(&str, usize) -> String;

/// A model endpoint that refuses every request defining the tool `name`,
/// in the words of `refusal`; other requests are answered from the script.
struct Picky {
    inner: std::sync::Arc<Scripted>,
    name: String,
    refusal: Refusal,
}

#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for Picky {
    async fn complete(
        &self,
        request: Value,
        config: &llm_agent::config::LlmConfig,
        cancel: CancellationToken,
        delta: tokio::sync::mpsc::Sender<String>,
    ) -> anyhow::Result<llm_agent::llm::Completion> {
        let at = request["tools"].as_array().and_then(|tools| tools.iter().position(|t| t["function"]["name"] == self.name.as_str()));
        if let Some(at) = at {
            self.inner.requests.lock().unwrap().push(request);
            anyhow::bail!((self.refusal)(&self.name, at));
        }
        self.inner.complete(request, config, cancel, delta).await
    }
}

fn tool_names(request: &Value) -> Vec<String> {
    request["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap().to_owned()).collect()
}

/// Mcp review, eleventh pass: a provider that refused one MCP tool's
/// definition failed every question with a server error while the tool was
/// allowed, the agent's own tools and the other MCP tools with it.
#[tokio::test]
async fn a_definition_the_model_refuses_leaves_that_tool_out_alone() {
    if node_missing() {
        return;
    }
    let refusals: [(&str, Refusal); 3] = [
        ("OpenAI", |name, at| {
            format!(r#"http_400: {{"error":{{"message":"Invalid schema for function '{name}': In context=('properties', 'tags'), array schema missing items.","type":"invalid_request_error","param":"tools[{at}].function.parameters","code":"invalid_function_parameters"}}}}"#)
        }),
        ("Anthropic", |_, at| format!(r#"http_400: {{"type":"error","error":{{"type":"invalid_request_error","message":"tools.{at}.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12"}}}}"#)),
        ("Gemini", |_, at| {
            format!(r#"http_400: [{{"error":{{"code":400,"message":"* GenerateContentRequest.tools[0].function_declarations[{at}].parameters.properties[tags].items: missing field.\n","status":"INVALID_ARGUMENT"}}}}]"#)
        }),
    ];
    for (provider, refusal) in refusals {
        let config = config(vec![fake("fake", &["echo", "add"], &[])]);
        let scripted = Scripted::new(vec![text("끝"), text("둘째"), text("셋째")]);
        let llm = std::sync::Arc::new(Picky { inner: scripted.clone(), name: "fake__echo".into(), refusal });
        let (app, _dir) = app(config.clone(), llm);
        app.mcp.apply(&config.mcp_servers);
        ready(&app.mcp, "fake").await;
        let (result, _) = ask(&app, "에코 해줘").await;
        assert_eq!(result.unwrap_or_else(|e| panic!("{provider}: {e:#}")).answer, "끝", "{provider}");
        let requests = scripted.requests();
        assert_eq!(requests.len(), 2, "{provider}: refused once, then asked without the tool");
        assert!(tool_names(&requests[0]).contains(&"fake__echo".to_owned()));
        let second = tool_names(&requests[1]);
        assert!(!second.contains(&"fake__echo".to_owned()) && second.contains(&"fake__add".to_owned()) && second.contains(&"search".to_owned()), "{provider}: {second:?}");
        let system = requests[1]["messages"][0]["content"].as_str().unwrap();
        assert!(system.ends_with("- fake: 가짜 MCP 서버 fake"), "the server's other tool is still offered");
        // Told on the admin screen, and left out of later questions to this
        // model from the start (no refused request each time).
        let status = app.mcp.server_status("fake", MODEL).unwrap();
        let echo = status["tools"].as_array().unwrap().iter().find(|t| t["name"] == "echo").unwrap().clone();
        assert_eq!(echo["refused"]["model"], MODEL, "{provider}: {echo}");
        assert!(echo["refused"]["reason"].as_str().unwrap().starts_with("http_400:"), "{echo}");
        assert!(log_text(&status).contains("도구 fake__echo의 정의를 받지 않아"), "{}", log_text(&status));
        let (result, _) = ask(&app, "다시").await;
        assert_eq!(result.unwrap().answer, "둘째");
        let requests = scripted.requests();
        assert_eq!(requests.len(), 3, "{provider}");
        assert!(!tool_names(&requests[2]).contains(&"fake__echo".to_owned()));
        // Another model endpoint is offered it; a reconnect asked for offers
        // it again (the server may have fixed it).
        let mut other = config.clone();
        other.llm.model = "other-model".into();
        assert!(app.mcp.snapshot(&other).find("fake__echo").is_some());
        assert!(app.mcp.snapshot(&config).find("fake__echo").is_none());
        assert!(app.mcp.restart("fake"));
        wait_for(&app.mcp, "fake", |s| s["state"] == "ready" && s["restarts"] == 1).await;
        assert!(app.mcp.snapshot(&config).find("fake__echo").is_some());
        app.mcp.shutdown().await;
    }
}

#[tokio::test]
async fn a_refusal_naming_no_mcp_tool_still_fails_the_question() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("fake", &["echo"], &[])]);
    let scripted = Scripted::new(vec![text("끝")]);
    // Refuses the agent's own search tool: nothing of MCP to leave out.
    let refusal: Refusal = |name, at| format!(r#"http_400: {{"error":{{"message":"Invalid schema for function '{name}'","param":"tools[{at}]"}}}}"#);
    let llm = std::sync::Arc::new(Picky { inner: scripted.clone(), name: "search".into(), refusal });
    let (app, _dir) = app(config.clone(), llm);
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "fake").await;
    let (result, _) = ask(&app, "에코").await;
    let error = result.err().expect("refused");
    assert!(error.to_string().starts_with("http_400:"), "{error:#}");
    assert_eq!(scripted.requests().len(), 1);
    assert!(app.mcp.snapshot(&config).find("fake__echo").is_some(), "no MCP tool was blamed");
    app.mcp.shutdown().await;
}

/// Mcp review, eleventh pass: "*" on servers with many tools sent requests
/// past the 128 tools OpenAI takes, and every question failed.
#[tokio::test]
async fn a_request_defines_at_most_the_tool_limit() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("many", &["*"], &[("FAKE_MCP_MANY", "150")])]);
    let llm = Scripted::new(vec![text("끝"), text("둘째")]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    let status = ready(&app.mcp, "many").await;
    let listed = status["tools"].as_array().unwrap().len();
    assert!(listed > llm_agent::mcp::MAX_REQUEST_TOOLS, "{listed}");
    let (result, _) = ask(&app, "안녕").await;
    assert_eq!(result.unwrap().answer, "끝");
    let (result, _) = ask(&app, "또").await;
    assert_eq!(result.unwrap().answer, "둘째");
    let requests = llm.requests();
    for request in &requests {
        let names = tool_names(request);
        assert!(names.len() <= llm_agent::mcp::MAX_REQUEST_TOOLS, "{}", names.len());
        assert!(names.contains(&"search".to_owned()), "the agent's own tools first");
        // Room is kept for the history tool a later round adds.
        assert_eq!(names.len(), llm_agent::mcp::MAX_REQUEST_TOOLS - 1, "every place the limit leaves is used");
    }
    // Said once in the server's log, not at every question.
    let log = log_text(&app.mcp.server_status("many", MODEL).unwrap());
    assert_eq!(log.matches("개까지만 싣고").count(), 1, "{log}");
    app.mcp.shutdown().await;
}

/// The admin API over the router, as the screen calls it.
struct Admin {
    router: axum::Router,
    token: Option<String>,
}

impl Admin {
    async fn send(&self, method: &str, path: &str, body: Option<Value>, revision: Option<&str>) -> (u16, Value, String) {
        use axum::{body::Body, http::Request};
        use http_body_util::BodyExt;
        use tower::ServiceExt;
        let mut request = Request::builder().method(method).uri(format!("/api/admin/{path}")).header("x-admin-request", "1");
        if let Some(token) = &self.token {
            request = request.header("x-admin-token", token);
        }
        if let Some(revision) = revision {
            request = request.header("if-match", format!("\"{revision}\""));
        }
        let request = match body {
            Some(body) => request.header("content-type", "application/json").body(Body::from(body.to_string())).unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null), text)
    }
}

#[tokio::test]
async fn the_admin_screen_edits_servers_only_behind_a_key() {
    if node_missing() {
        return;
    }
    let (open_app, _open_dir) = app(config(vec![]), Scripted::new(vec![]));
    let open = Admin { router: llm_agent::web::router(open_app.clone()), token: None };
    let (status, body, _) = open.send("GET", "mcp", None, None).await;
    assert_eq!((status, body["editable"].clone()), (200, json!(false)));
    let draft = json!({"name":"fake","command":"node","args":[fixture().display().to_string()],"tools":["echo"]});
    for (method, path) in [("POST", "mcp"), ("POST", "mcp-check")] {
        let (status, body, _) = open.send(method, path, Some(draft.clone()), None).await;
        assert_eq!(status, 403, "{path}: {body}");
        assert!(body["error"].as_str().unwrap().contains("관리자 인증 키"));
    }

    // A key set while the admin API was open does not open MCP editing
    // until the backend restarts with it.
    let (status, settings, _) = open.send("GET", "settings", None, None).await;
    assert_eq!(status, 200);
    let (status, _, text) = open
        .send("PUT", "settings", Some(json!({"secrets":{"admin_token":"late-key"}})), Some(settings["revision"].as_str().unwrap()))
        .await;
    assert_eq!(status, 200, "{text}");
    let late = Admin { router: llm_agent::web::router(open_app.clone()), token: Some("late-key".into()) };
    let (status, listed, _) = late.send("GET", "mcp", None, None).await;
    assert_eq!((status, listed["editable"].clone()), (200, json!(false)));
    assert!(listed["locked_reason"].as_str().unwrap().contains("다시 시작"));
    let (status, body, _) = late.send("POST", "mcp", Some(draft.clone()), None).await;
    assert_eq!(status, 403, "{body}");
    assert!(body["error"].as_str().unwrap().contains("backend를 다시 시작한 뒤"), "{body}");

    let mut keyed = config(vec![]);
    keyed.admin_token = Some(Secret("key".into()));
    let (app, dir) = app(keyed, Scripted::new(vec![]));
    let admin = Admin { router: llm_agent::web::router(app.clone()), token: Some("key".into()) };
    let mut created = draft.clone();
    created["description"] = json!("가짜 서버");
    created["env"] = json!({"PLAIN":"visible"});
    created["secrets"] = json!({"env":{"HIDDEN":"kept-secret"}});
    let (status, server, text) = admin.send("POST", "mcp", Some(created.clone()), None).await;
    assert_eq!(status, 201, "{text}");
    assert_eq!(server["secrets"]["env"], json!(["HIDDEN"]));
    assert!(!text.contains("kept-secret"), "a secret is never sent back");
    let toml = std::fs::read_to_string(dir.path().join("config.toml")).unwrap();
    assert!(toml.contains("[[mcp_servers]]") && !toml.contains("kept-secret"), "{toml}");
    assert!(std::fs::read_to_string(dir.path().join("config.credentials.json")).unwrap().contains("kept-secret"));
    let first = ready(&app.mcp, "fake").await;
    let config_now = app.config();
    assert_eq!(call(&app.mcp, &config_now, "fake__echo", json!({"text":"화면"})).await.unwrap()["text"], "echo: 화면");
    let (status, _, _) = admin.send("POST", "mcp", Some(created.clone()), None).await;
    assert_eq!(status, 409, "the name is taken");
    let mut both = created.clone();
    both["name"] = json!("both");
    both["url"] = json!("http://127.0.0.1:9/mcp");
    let (status, body, _) = admin.send("POST", "mcp", Some(both), None).await;
    assert_eq!(status, 400, "{body}");

    // A stale revision is refused; allowed tools change on the live connection.
    let (status, _, _) = admin.send("PUT", "mcp/fake", Some(json!({"tools":["echo","add"]})), Some(&"0".repeat(64))).await;
    assert_eq!(status, 409);
    let (status, listed, _) = admin.send("GET", "mcp", None, None).await;
    assert_eq!(status, 200);
    let revision = listed["servers"][0]["revision"].as_str().unwrap().to_owned();
    assert_eq!(listed["servers"][0]["status"]["state"], "ready");
    let (status, updated, text) = admin.send("PUT", "mcp/fake", Some(json!({"tools":["echo","add"]})), Some(&revision)).await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(updated["secrets"]["env"], json!(["HIDDEN"]), "secrets absent from the body are kept");
    assert_eq!(updated["status"]["pid"], first["pid"], "no new connection for a changed allow list");
    assert_eq!(app.mcp.snapshot(&app.config()).names().collect::<Vec<_>>(), ["fake__echo", "fake__add"]);
    let revision = updated["revision"].as_str().unwrap().to_owned();
    let (status, updated, _) = admin.send("PUT", "mcp/fake", Some(json!({"secrets":{"env":{"HIDDEN":null}}})), Some(&revision)).await;
    assert_eq!(status, 200);
    assert_eq!(updated["secrets"]["env"], json!([]));
    ready(&app.mcp, "fake").await;

    // The settings tab neither shows nor drops the servers.
    let (status, settings, _) = admin.send("GET", "settings", None, None).await;
    assert_eq!(status, 200);
    assert!(settings["config"].get("mcp_servers").is_none());
    let (status, saved, text) = admin
        .send("PUT", "settings", Some(json!({"config":{"agent":{"tool_timeout_secs":31},"mcp_servers":[]}})), Some(settings["revision"].as_str().unwrap()))
        .await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(saved["config"]["agent"]["tool_timeout_secs"], 31);
    assert_eq!(app.config().mcp_servers.len(), 1);

    // A restart reconnects; a check connects with the draft and lists tools.
    let before = ready(&app.mcp, "fake").await;
    let (status, _, _) = admin.send("POST", "mcp/fake/restart", None, None).await;
    assert_eq!(status, 200);
    wait_for(&app.mcp, "fake", |s| s["state"] == "ready" && s["pid"] != before["pid"]).await;
    let (status, checked, text) = admin.send("POST", "mcp-check", Some(json!({"original":"fake","tools":["*"]})), None).await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(checked["ok"], true, "{checked:#}");
    assert_eq!(checked["tools"].as_array().unwrap().len(), 21);
    assert!(checked["tools"][0]["tokens"].as_u64().unwrap() > 10);
    let (status, _, _) = admin.send("POST", "mcp-check", Some(json!({"name":"a__b","command":"node"})), None).await;
    assert_eq!(status, 400);

    // A token is not sent to another host unless it is entered again.
    let mut web = json!({"name":"web","url":"http://127.0.0.1:9/mcp","tools":["*"],"secrets":{"headers":{"Authorization":"Bearer t0k"}}});
    let (status, created, text) = admin.send("POST", "mcp", Some(web.clone()), None).await;
    assert_eq!(status, 201, "{text}");
    let moved = json!({"url":"http://127.0.0.2:9/mcp"});
    let (status, body, _) = admin.send("PUT", "mcp/web", Some(moved.clone()), Some(created["revision"].as_str().unwrap())).await;
    assert_eq!(status, 400, "{body}");
    assert!(body["error"].as_str().unwrap().contains("Authorization"), "{body}");
    let (status, _, _) = admin.send("POST", "mcp-check", Some(json!({"original":"web","url":"http://127.0.0.2:9/mcp"})), None).await;
    assert_eq!(status, 400, "the check does not send it either");
    let empty = json!({"url":"http://127.0.0.2:9/mcp","secrets":{"headers":{"Authorization":""}}});
    let (status, _, _) = admin.send("PUT", "mcp/web", Some(empty), Some(created["revision"].as_str().unwrap())).await;
    assert_eq!(status, 400, "an empty value keeps the token: it is not an answer");
    let (status, same_host, text) = admin.send("PUT", "mcp/web", Some(json!({"url":"http://127.0.0.1:9/other"})), Some(created["revision"].as_str().unwrap())).await;
    assert_eq!(status, 200, "same host, another path: {text}");
    assert_eq!(same_host["secrets"]["headers"], json!(["Authorization"]));
    web["url"] = json!("http://127.0.0.2:9/mcp");
    web["secrets"] = json!({"headers":{"Authorization":"Bearer new"}});
    let (status, _, text) = admin.send("PUT", "mcp/web", Some(web), Some(same_host["revision"].as_str().unwrap())).await;
    assert_eq!(status, 200, "entered again: {text}");
    // A header entered again in another case replaces the stored one.
    let (_, listed, _) = admin.send("GET", "mcp", None, None).await;
    let web_revision = listed["servers"][1]["revision"].as_str().unwrap().to_owned();
    let lower = json!({"secrets":{"headers":{"authorization":"Bearer newer"}}});
    let (status, updated, text) = admin.send("PUT", "mcp/web", Some(lower), Some(&web_revision)).await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(updated["secrets"]["headers"], json!(["authorization"]));
    let stored = app.config().mcp_servers.iter().find(|s| s.name == "web").cloned().unwrap();
    assert_eq!(stored.secret_headers.values().map(|s| s.0.as_str()).collect::<Vec<_>>(), ["Bearer newer"]);
    // The screen lists a value entered in another case beside the stored
    // one, whose removal may come after it in the body: the new value stays.
    let replaced = json!({"secrets":{"headers":{"Authorization":"Bearer newest","authorization":null}}});
    let (status, updated, text) = admin.send("PUT", "mcp/web", Some(replaced), Some(updated["revision"].as_str().unwrap())).await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(updated["secrets"]["headers"], json!(["Authorization"]), "{updated:#}");
    let stored = app.config().mcp_servers.iter().find(|s| s.name == "web").cloned().unwrap();
    assert_eq!(stored.secret_headers.values().map(|s| s.0.as_str()).collect::<Vec<_>>(), ["Bearer newest"]);
    let (_, listed, _) = admin.send("GET", "mcp", None, None).await;
    let revision = listed["servers"][1]["revision"].as_str().unwrap().to_owned();
    let (status, _, _) = admin.send("DELETE", "mcp/web", None, Some(&revision)).await;
    assert_eq!(status, 204);

    // Removal needs the revision and stops the server.
    let (_, listed, _) = admin.send("GET", "mcp", None, None).await;
    let revision = listed["servers"][0]["revision"].as_str().unwrap().to_owned();
    let (status, _, _) = admin.send("DELETE", "mcp/fake", None, None).await;
    assert_eq!(status, 428);
    let (status, _, _) = admin.send("DELETE", "mcp/fake", None, Some(&revision)).await;
    assert_eq!(status, 204);
    assert!(app.mcp.server_status("fake", MODEL).is_none());
    assert!(app.config().mcp_servers.is_empty());
    app.mcp.shutdown().await;
}

#[tokio::test]
async fn a_key_in_the_server_address_stays_out_of_errors_and_logs() {
    let server = McpServer { name: "leak".into(), url: "http://user:hunter2@127.0.0.1:9/mcp?api_key=s3cret".into(), tools: vec!["*".into()], ..Default::default() };
    let hub = McpHub::default();
    hub.apply(&[server]);
    let failed = wait_for(&hub, "leak", |s| s["state"] == "failed").await;
    let shown = format!("{} {}", failed["error"], log_text(&failed));
    assert!(shown.contains("127.0.0.1:9/mcp?…"), "{shown}");
    for secret in ["s3cret", "hunter2", "api_key"] {
        assert!(!shown.contains(secret), "{secret} in {shown}");
    }
    hub.shutdown().await;
}

/// The admin screen's status counts the tokens of every tool definition;
/// a question starting meanwhile does not wait for it, and a count is made
/// once per model.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_status_counts_tokens_without_holding_up_questions() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("fat", &["*"], &[("FAKE_MCP_FAT", "300"), ("FAKE_MCP_PAGE", "100")])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "fat").await;
    // Another model: every definition is counted again.
    let counting = hub.clone();
    let status = tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let status = counting.status("another-model");
        (started.elapsed(), status)
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let started = Instant::now();
    let snapshot = hub.snapshot(&config);
    let waited = started.elapsed();
    let (counted, status) = status.await.unwrap();
    assert_eq!(snapshot.names().count(), 321);
    assert!(counted > Duration::from_millis(400), "the count takes a while: {counted:?}");
    assert!(waited < counted / 4, "the snapshot waited {waited:?} for a count of {counted:?}");
    let fat = status[0]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "fat_0").unwrap();
    assert!(fat["tokens"].as_u64().unwrap() > 1_000, "{}", fat["tokens"]);
    let started = Instant::now();
    hub.status("another-model");
    assert!(started.elapsed() < counted / 4, "counted once: {:?}", started.elapsed());
    hub.shutdown().await;
}

/// Text a JavaScript server cut inside an emoji holds half a surrogate pair
/// (a `\ud83d` escape), which JSON parsers refuse: the result comes with
/// U+FFFD in its place, over stdio, SSE and plain JSON (so does a byte that
/// is not UTF-8 over stdio). A plain JSON response was parsed inside the SDK,
/// and that call failed, until the client read answers itself (twenty-sixth
/// pass).
#[tokio::test]
async fn text_cut_inside_an_emoji_does_not_hang_or_end_the_session() {
    if node_missing() {
        return;
    }
    for mode in ["stdio", "sse", "json"] {
        let remote;
        let server = if mode == "stdio" {
            fake("cut", &["echo"], &[])
        } else {
            remote = HttpServer::start(if mode == "sse" { &[("FAKE_MCP_SSE", "1")] } else { &[] });
            McpServer { name: "cut".into(), url: remote.url.clone(), tools: vec!["echo".into()], ..Default::default() }
        };
        let config = config(vec![server]);
        let hub = McpHub::default();
        hub.apply(&config.mcp_servers);
        ready(&hub, "cut").await;
        let started = Instant::now();
        let outcome = call(&hub, &config, "cut__echo", json!({"text":"cut emoji"})).await;
        assert!(started.elapsed() < Duration::from_secs(5), "{mode}: answered at once, not at the timeout");
        assert_eq!(outcome.unwrap()["text"], "잘림 \u{fffd}", "{mode}");
        if mode == "stdio" {
            let bytes = call(&hub, &config, "cut__echo", json!({"text":"bad bytes"})).await;
            assert_eq!(bytes.unwrap()["text"], "raw \u{fffd} byte", "a byte that is not UTF-8");
        }
        let after = call(&hub, &config, "cut__echo", json!({"text":"after"})).await;
        assert_eq!(after.unwrap()["text"], "echo: after", "{mode}");
        let status = hub.server_status("cut", MODEL).unwrap();
        assert_eq!((status["state"].clone(), status["restarts"].clone()), (json!("ready"), json!(0)), "{mode}");
        hub.shutdown().await;
    }
}

/// Output as some Windows programs write it: a byte order mark before the
/// first line (the answer to initialize), CRLF line ends — read through the
/// line reader in front of the SDK's (which drops both).
#[tokio::test]
async fn windows_style_output_is_read() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("win", &["echo"], &[("FAKE_MCP_WINDOWS", "1")])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "win").await;
    assert_eq!(call(&hub, &config, "win__echo", json!({"text":"crlf"})).await.unwrap()["text"], "echo: crlf");
    hub.shutdown().await;
}

/// Answers that slip on JSON-RPC (no "jsonrpc":"2.0", an error without a
/// numeric code) were dropped by the SDK over stdio — the call waited out
/// its timeout — and ended the session over SSE. They are put right.
#[tokio::test]
async fn slips_of_the_protocol_neither_hang_nor_end_the_session() {
    if node_missing() {
        return;
    }
    let shapes = [
        (r#"{"result":{"content":[{"type":"text","text":"no version"}]}}"#, Ok("no version")),
        (r#"{"jsonrpc":"1.0","result":{"content":[{"type":"text","text":"old"}]}}"#, Ok("old")),
        (r#"{"jsonrpc":"2.0","error":{"message":"no code"}}"#, Err("mcp_request_failed: no code (code -32603)")),
        (r#"{"jsonrpc":"2.0","error":{"code":"E1","message":"text code"}}"#, Err("mcp_request_failed: text code (code -32603)")),
        (r#"{"jsonrpc":"2.0","error":"just text"}"#, Err("mcp_request_failed: just text (code -32603)")),
        // An error beside a null result (JSON-RPC 1.0 sends both, so does a
        // Go struct without omitempty) is the error, not a null success.
        (r#"{"jsonrpc":"2.0","result":null,"error":{"code":-32602,"message":"text must be short"}}"#, Err("invalid_tool_arguments: shape__echo refused the arguments: text must be short")),
        (r#"{"result":null,"error":{"code":-32000,"message":"old style"}}"#, Err("mcp_request_failed: old style (code -32000)")),
        (r#"{"result":{"content":[{"type":"text","text":"no error"}]},"error":null}"#, Ok("no error")),
        // A code past the SDK's 32-bit one, or written as a float, read as
        // the error it is (eighteenth pass: the SDK dropped the message).
        (r#"{"jsonrpc":"2.0","error":{"code":5000000000,"message":"big code"}}"#, Err("mcp_request_failed: big code (code -32603)")),
        (r#"{"jsonrpc":"2.0","error":{"code":-32602.0,"message":"float code"}}"#, Err("invalid_tool_arguments: shape__echo refused the arguments: float code")),
    ];
    for mode in ["stdio", "sse"] {
        let remote;
        let server = if mode == "stdio" {
            fake("shape", &["echo"], &[])
        } else {
            remote = HttpServer::start(&[("FAKE_MCP_SSE", "1")]);
            McpServer { name: "shape".into(), url: remote.url.clone(), tools: vec!["echo".into()], ..Default::default() }
        };
        let config = config(vec![McpServer { timeout_secs: Some(5), ..server }]);
        let hub = McpHub::default();
        hub.apply(&config.mcp_servers);
        ready(&hub, "shape").await;
        for (shape, expected) in shapes {
            let started = Instant::now();
            let outcome = call(&hub, &config, "shape__echo", json!({"text":format!("shape:{shape}")})).await;
            assert!(started.elapsed() < Duration::from_secs(3), "{mode} {shape}: answered at once");
            match expected {
                Ok(text) => assert_eq!(outcome.unwrap()["text"], text, "{mode} {shape}"),
                Err(error) => assert_eq!(outcome.unwrap_err().to_string(), error, "{mode} {shape}"),
            }
        }
        assert_eq!(call(&hub, &config, "shape__echo", json!({"text":"after"})).await.unwrap()["text"], "echo: after");
        assert_eq!(hub.server_status("shape", MODEL).unwrap()["restarts"], 0, "{mode}");
        hub.shutdown().await;
    }
}

/// A model calling MCP tools at random beside the agent's own — results past
/// the budget, failing and slow ones, a server's own name for a tool — and
/// following the continuations its last results give, with cut answers.
struct RandomMcpModel {
    seed: std::sync::Mutex<u64>,
    /// Tokens the provider serves; past it a request is refused.
    real_limit: usize,
    /// The provider's tokens per estimated token.
    ratio: f64,
    rounds: std::sync::Mutex<usize>,
    next_call: std::sync::Mutex<usize>,
    requests: std::sync::Mutex<Vec<(Value, bool)>>,
    /// Calls that follow a continuation, and the continuation.
    followed: std::sync::Mutex<Vec<(String, Value)>>,
    problems: std::sync::Mutex<Vec<String>>,
}
impl RandomMcpModel {
    fn next(&self, n: usize) -> usize {
        let mut seed = self.seed.lock().unwrap();
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 33) as usize) % n.max(1)
    }
    fn id(&self) -> String {
        let mut next = self.next_call.lock().unwrap();
        *next += 1;
        format!("c{next}")
    }
    fn problem(&self, problem: String) {
        self.problems.lock().unwrap().push(problem);
    }
}
#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for RandomMcpModel {
    async fn complete(&self, request: Value, config: &llm_agent::config::LlmConfig, _c: CancellationToken, _d: tokio::sync::mpsc::Sender<String>) -> anyhow::Result<llm_agent::llm::Completion> {
        let input = (llm_agent::context::count(&request, &config.model) as f64 * self.ratio) as usize;
        let accepted = input + config.output_tokens <= self.real_limit;
        self.requests.lock().unwrap().push((request.clone(), accepted));
        if !accepted {
            anyhow::bail!("http_400: {}", json!({"error":{"message":format!("This model's maximum context length is {} tokens.", self.real_limit),"code":"context_length_exceeded"}}));
        }
        // The results of the last response, by call name.
        let messages = request["messages"].as_array().unwrap();
        let last = messages.iter().rposition(|m| m["tool_calls"].as_array().is_some_and(|c| !c.is_empty()));
        let results: Vec<(String, String, Value)> = last
            .map(|at| {
                let calls = messages[at]["tool_calls"].as_array().unwrap();
                messages[at + 1..]
                    .iter()
                    .take_while(|m| m["role"] == "tool")
                    .map(|m| {
                        let id = m["tool_call_id"].as_str().unwrap().to_owned();
                        let name = calls.iter().find(|c| c["id"] == id.as_str()).map_or("", |c| c["function"]["name"].as_str().unwrap()).to_owned();
                        (id, name, serde_json::from_str(m["content"].as_str().unwrap()).unwrap())
                    })
                    .collect()
            })
            .unwrap_or_default();
        // A continuation followed reads on from where it was cut.
        for (id, cursor) in std::mem::take(&mut *self.followed.lock().unwrap()) {
            let Some((_, _, result)) = results.iter().find(|(r, _, _)| *r == id) else {
                continue;
            };
            if result["status"] != "ok" && result["status"] != "cancelled" {
                self.problem(format!("following {cursor} gave {result}"));
            }
            if result["next_cursor"]["tool"] == "history" && result["next_cursor"]["id"] == cursor["id"] && result["next_cursor"]["offset"].as_u64() <= cursor["offset"].as_u64() {
                self.problem(format!("following {cursor} went no further: {result}"));
            }
        }
        // A cut result of `big` shows its start.
        for (_, name, result) in &results {
            if let Some(text) = result["data"]["text"].as_str().filter(|_| name.ends_with("big"))
                && !text.chars().enumerate().all(|(i, c)| c == char::from(b'0' + (i % 10) as u8))
            {
                self.problem(format!("a cut result of big is not its start: {}", text.chars().take(80).collect::<String>()));
            }
            // Its archive is read on from where the text shown stops.
            if name.ends_with("big")
                && result["data"]["text"].as_str().is_some_and(|text| !text.is_empty())
                && result["next_cursor"]["tool"] == "history"
                && result["next_cursor"]["offset"] == 0
            {
                self.problem(format!("a cut result of big goes on from the start of its archive: {}", result["next_cursor"]));
            }
        }
        let rounds = {
            let mut rounds = self.rounds.lock().unwrap();
            *rounds += 1;
            *rounds
        };
        let mut out = text("");
        out.usage = Some(llm_agent::llm::Usage { input, output: 50, cached: None });
        let offered = request["tools"].as_array().is_some_and(|t| t.iter().any(|d| d["function"]["name"] == "history"));
        let cursors: Vec<Value> = results.iter().filter(|(_, _, r)| r["next_cursor"]["tool"] == "history").map(|(_, _, r)| r["next_cursor"].clone()).collect();
        if request["tool_choice"] != "none" && offered && !cursors.is_empty() && self.next(3) > 0 && rounds <= 10 {
            for cursor in cursors.iter().take(1 + self.next(3)) {
                let id = self.id();
                self.followed.lock().unwrap().push((id.clone(), cursor.clone()));
                out.calls.push(support::call(&id, "history", json!({"action":"read","id":cursor["id"],"offset":cursor["offset"]})));
            }
            return Ok(out);
        }
        match if rounds > 10 { 99 } else { self.next(100) } {
            0..=49 => {
                for _ in 0..1 + self.next(8) {
                    let id = self.id();
                    let chars = [50, 3_000, 30_000, 90_000, 150_000, 260_000][self.next(6)];
                    out.calls.push(match self.next(10) {
                        0..=2 => support::call(&id, "fake__big", json!({"chars":chars})),
                        // Now and then arguments as large as a document to file.
                        3 => support::call(&id, "fake__echo", json!({"text":"말 \"따옴\" \\ 끝 ".repeat(1 + self.next(if self.next(8) == 0 { 400 } else { 40 }))})),
                        4 => support::call(&id, "fake__fail", json!({})),
                        5 => support::call(&id, "fake__mixed", json!({})),
                        6 => support::call(&id, "fake__slow", json!({"ms":([20, 200])[self.next(2)]})),
                        7 if offered => support::call(&id, "history", json!({"action":"search","query":(["0123456789", "echo", "따옴"])[self.next(3)]})),
                        7 => support::call(&id, "big", json!({"chars":2_000})),
                        8 => support::call(&id, "file_read", json!({"path":"big.txt","start_line":1 + self.next(5000)})),
                        _ => support::call(&id, "fake__echo", json!({})),
                    });
                }
            }
            50..=62 => {
                out.text = format!("조각{} {}", self.next(1000), "가나다 ".repeat(self.next(config.output_tokens.min(3000))));
                out.length_limited = true;
            }
            63..=67 => {
                out.length_limited = true;
                out.discarded_tool_calls = true;
            }
            _ => {
                out.text = format!("답{}", self.next(1000));
                *self.rounds.lock().unwrap() = 0;
            }
        }
        Ok(out)
    }
}

/// Mcp and context review, thirteenth pass: random conversations with MCP
/// tools beside the agent's own keep every request in shape and within the
/// context, keep what the results in the context go on in, read on from
/// every continuation they give, and close every progress line; the user
/// stops now and then. MCP_CTX_FUZZ sets the number of conversations (it
/// found the calls run with no room for their results).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn random_conversations_with_mcp_tools_keep_their_context() {
    if node_missing() {
        return;
    }
    let runs: usize = std::env::var("MCP_CTX_FUZZ").ok().and_then(|n| n.parse().ok()).unwrap_or(8);
    let mut seed: u64 = 0x3cc;
    let mut next = |n: usize| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((seed >> 33) as usize) % n.max(1)
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    let body: String = (1..=8000).map(|i| format!("line {i} {}\n", "word \"q\" ".repeat(8))).collect();
    std::fs::write(root.join("big.txt"), &body).unwrap();
    for run in 0..runs {
        let mut config = config(vec![fake("fake", &["*"], &[])]);
        config.llm.model = ["gpt-4o", "unknown-tokenizer"][next(2)].into();
        let context = [24_000, 32_000, 64_000, 128_000][next(4)];
        config.llm.context_tokens = context;
        config.llm.output_tokens = [2_000, 4_000][next(2)];
        if next(2) == 0 {
            config.projects.push(llm_agent::config::Project { name: "app".into(), root: root.clone(), ..Default::default() });
        }
        if next(2) == 0 {
            config.agent.history_bytes = 64 * 1024;
        }
        if next(3) == 0 {
            config.agent.result_tokens = Some([1_200, 3_000, 8_000][next(3)]);
        }
        let real_limit = if next(4) == 0 { context * (70 + next(30)) / 100 } else { context * 2 };
        let ratio = if config.llm.model == "gpt-4o" { 1.0 } else { 0.8 + next(40) as f64 / 100.0 };
        let llm = std::sync::Arc::new(RandomMcpModel {
            seed: std::sync::Mutex::new(next(1 << 30) as u64 + 1),
            real_limit,
            ratio,
            rounds: Default::default(),
            next_call: Default::default(),
            requests: Default::default(),
            followed: Default::default(),
            problems: Default::default(),
        });
        let (app, _dir) = app(config.clone(), llm.clone());
        app.mcp.apply(&config.mcp_servers);
        ready(&app.mcp, "fake").await;
        let conversation = format!("fuzz{run}");
        for q in 0..4 {
            let before = llm.requests.lock().unwrap().len();
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let stop = CancellationToken::new();
            let stopping = (next(4) == 0).then(|| {
                let (stop, after) = (stop.clone(), next(300) as u64);
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(after)).await;
                    stop.cancel();
                })
            });
            let question = Question { conversation_id: conversation.clone(), message: format!("질문 {q} {}", "자료 ".repeat(next(600))), history: vec![] };
            let result = agent::answer(&app, question, Events::new(Some(tx)), stop).await;
            if let Some(stopping) = stopping {
                stopping.abort();
            }
            let mut events = vec![];
            while let Ok(event) = rx.try_recv() {
                events.push(event);
            }
            let requests = llm.requests.lock().unwrap().clone();
            for (i, (request, accepted)) in requests.iter().enumerate().skip(before) {
                if let Err(broken) = request_shape(request) {
                    panic!("run {run} question {q} request {i}: {broken}");
                }
                let input = (llm_agent::context::count(request, &config.llm.model) as f64 * ratio) as usize;
                assert!(!accepted || i == before || input + config.llm.output_tokens <= context, "run {run} request {i}: {input} tokens past the context {context}");
            }
            for started in events.iter().filter(|e| e["type"] == "tool") {
                assert!(events.iter().any(|e| e["type"] == "tool_done" && e["id"] == started["id"]), "run {run} question {q}: {started} never closed");
            }
            if let Err(error) = result {
                // A question ends answered, stopped, or with what the user may see.
                assert!(error.to_string() == "cancelled" || error.downcast_ref::<agent::UserFacing>().is_some(), "run {run} question {q}: {error:#}");
                // With the context served as configured, what the question
                // gathered always fits: its calls are not run otherwise.
                let shown = error.to_string();
                assert!(real_limit < context || !shown.contains("한 번에 담기지 않아"), "run {run} question {q}: {shown}");
            }
            let claim = app.sessions.open(&conversation, Duration::from_secs(60), 10, CancellationToken::new());
            let kept = continuations_kept(&claim.conversation.lock().await.history);
            app.sessions.finish(&conversation, claim.run);
            if let Err(lost) = kept {
                panic!("run {run} question {q}: {lost}");
            }
            let problems = std::mem::take(&mut *llm.problems.lock().unwrap());
            assert!(problems.is_empty(), "run {run} question {q}: {problems:#?}");
        }
        app.mcp.shutdown().await;
    }
}

/// MCP review, fifteenth pass: a server that was not connected was told to
/// the model with the last line of the server's own output (its stderr),
/// which may print anything — a connection string, a token — and the model's
/// provider is outside. The admin screen keeps it; the model is told the
/// state and the cause.
#[tokio::test]
async fn a_servers_own_output_stays_on_the_admin_screen() {
    if node_missing() {
        return;
    }
    let fatal = "fatal: cannot reach postgres://voc:s3cret@db.internal/voc";
    let config = config(vec![fake("fake", &["echo"], &[]), fake("gone", &["*"], &[("FAKE_MCP_EXIT_BEFORE_INIT", "1"), ("FAKE_MCP_FATAL", fatal)])]);
    let llm = Scripted::new(vec![calls(vec![support::call("g1", "gone__echo", json!({"text":"x"}))]), text("끝")]);
    let (app, _dir) = app(config.clone(), llm.clone());
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "fake").await;
    let status = wait_for(&app.mcp, "gone", |s| s["state"] == "failed").await;
    assert!(status["error"].as_str().unwrap().contains(fatal), "the admin sees it: {status:#}");
    let (result, _) = ask(&app, "에코").await;
    assert_eq!(result.unwrap().answer, "끝");
    let told = tool_result(&llm.requests()[1], "g1")["error"].as_str().unwrap().to_owned();
    assert!(told.starts_with("mcp_server_unavailable: MCP server gone is not connected (failed: "), "{told}");
    assert!(!told.contains("s3cret") && !told.contains("서버 출력"), "{told}");
    app.mcp.shutdown().await;
}

/// A model endpoint that refuses every request defining any of `names`, its
/// refusal listing each one's place, as Gemini lists every declaration it
/// does not take.
struct RefusesSeveral {
    inner: std::sync::Arc<Scripted>,
    names: Vec<&'static str>,
}

#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for RefusesSeveral {
    async fn complete(
        &self,
        request: Value,
        config: &llm_agent::config::LlmConfig,
        cancel: CancellationToken,
        delta: tokio::sync::mpsc::Sender<String>,
    ) -> anyhow::Result<llm_agent::llm::Completion> {
        let places: Vec<usize> = request["tools"].as_array().into_iter().flatten().enumerate()
            .filter(|(_, tool)| self.names.iter().any(|name| tool["function"]["name"] == *name))
            .map(|(at, _)| at)
            .collect();
        if !places.is_empty() {
            self.inner.requests.lock().unwrap().push(request);
            let lines: String = places.iter().map(|at| format!(r"* GenerateContentRequest.tools[0].function_declarations[{at}].parameters.properties[tags].items: missing field.\n")).collect();
            anyhow::bail!(format!(r#"http_400: [{{"error":{{"code":400,"message":"{lines}","status":"INVALID_ARGUMENT"}}}}]"#));
        }
        self.inner.complete(request, config, cancel, delta).await
    }
}

/// MCP review, fifteenth pass: a refusal naming several MCP tools left one
/// out at a time — a request refused again for each, a server of many faulty
/// tools taking as many requests before the question could start.
#[tokio::test]
async fn a_refusal_naming_several_tools_leaves_them_all_out_at_once() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("fake", &["echo", "add", "big"], &[])]);
    let scripted = Scripted::new(vec![text("끝")]);
    let llm = std::sync::Arc::new(RefusesSeveral { inner: scripted.clone(), names: vec!["fake__echo", "fake__add"] });
    let (app, _dir) = app(config.clone(), llm);
    app.mcp.apply(&config.mcp_servers);
    ready(&app.mcp, "fake").await;
    let (result, _) = ask(&app, "에코").await;
    assert_eq!(result.unwrap().answer, "끝");
    let requests = scripted.requests();
    assert_eq!(requests.len(), 2, "refused once, then asked without both");
    let second = tool_names(&requests[1]);
    assert!(!second.contains(&"fake__echo".to_owned()) && !second.contains(&"fake__add".to_owned()) && second.contains(&"fake__big".to_owned()), "{second:?}");
    let status = app.mcp.server_status("fake", MODEL).unwrap();
    for name in ["echo", "add"] {
        let tool = status["tools"].as_array().unwrap().iter().find(|t| t["name"] == name).unwrap();
        assert_eq!(tool["refused"]["model"], MODEL, "{tool}");
    }
    app.mcp.shutdown().await;
}

/// MCP review, fifteenth pass: of two tools whose names clean alike
/// (`weird.name`, `weird_name`), the one listed first took the plain model
/// name. A server listing its tools in another order (from a map) or adding
/// the twin later moved `fake__weird_name` to the other tool: the
/// conversation's calls and an allow-list entry of that name then meant
/// another tool.
#[tokio::test]
async fn a_tools_model_name_stays_with_it_whatever_the_listing_order() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("fake", &["*"], &[("FAKE_MCP_EXTRA_NAME", "weird_name"), ("FAKE_MCP_REVERSE_RELIST", "1")])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "fake").await;
    let tool_of = |name: &str| hub.snapshot(&config).find(name).map(|t| t.tool.clone());
    assert_eq!(tool_of("fake__weird_name").as_deref(), Some("weird.name"));
    call(&hub, &config, "fake__add_tool", json!({})).await.unwrap();
    wait_for(&hub, "fake", |s| s["tools"].as_array().unwrap().iter().any(|t| t["name"] == "weird_name")).await;
    assert_eq!(tool_of("fake__weird_name").as_deref(), Some("weird.name"), "the name stays with its tool");
    let snapshot = hub.snapshot(&config);
    let twin = snapshot.names().find(|n| n.starts_with("fake__weird_name_")).expect("the twin gets a name of its own").to_owned();
    assert_eq!(snapshot.find(&twin).unwrap().tool, "weird_name");
    hub.shutdown().await;
}

/// MCP review, sixteenth pass: a server of resources or prompts only does
/// not know `tools/list`. It was taken for one failing to connect and its
/// process started again and again (every minute at last), shown failed.
#[tokio::test]
async fn a_server_without_tools_is_connected_with_none() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("res", &["*"], &[("FAKE_MCP_NO_TOOLS", "1")])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    let status = ready(&hub, "res").await;
    assert_eq!(status["tools"], json!([]), "{status:#}");
    assert!(log_text(&status).contains("tools/list"), "{}", log_text(&status));
    // Not started again: one listing, no reconnection.
    tokio::time::sleep(Duration::from_millis(3_500)).await;
    let status = hub.server_status("res", MODEL).unwrap();
    assert_eq!((status["state"].as_str(), status["restarts"].as_u64()), (Some("ready"), Some(0)), "{status:#}");
    assert_eq!(log_text(&status).matches("listed ").count(), 1, "{}", log_text(&status));
    assert!(hub.snapshot(&config).is_empty());
    hub.shutdown().await;
    // The connection check says so too.
    let checked = probe(&config.mcp_servers[0], MODEL).await.unwrap();
    assert_eq!((checked["ok"].as_bool(), checked["tools"].as_array().map(Vec::len)), (Some(true), Some(0)), "{checked:#}");
}

/// MCP review, seventeenth pass: an error beside a null result (JSON-RPC
/// 1.0 sends both, so does a Go struct without omitempty) was read as a
/// success with a null result. A tool list refused so (a token expired)
/// connected the server as one without tools, its cause unsaid; a call
/// refused so lost the server's words for "an unexpected response".
#[tokio::test]
async fn an_error_beside_a_null_result_is_the_error() {
    if node_missing() {
        return;
    }
    for (mode, shape) in [
        ("2.0", r#"{"jsonrpc":"2.0","result":null,"error":{"code":-32001,"message":"token expired"}}"#),
        ("1.0", r#"{"result":null,"error":{"code":-32001,"message":"token expired"}}"#),
    ] {
        let server = fake("sloppy", &["*"], &[("FAKE_MCP_LIST_SHAPE", shape)]);
        let hub = McpHub::default();
        hub.apply(std::slice::from_ref(&server));
        let status = wait_for(&hub, "sloppy", |s| s["state"] == "failed").await;
        assert!(status["error"].as_str().unwrap().contains("token expired"), "{mode}: {status:#}");
        hub.shutdown().await;
        let checked = probe(&server, MODEL).await.unwrap();
        assert_eq!(checked["ok"], false, "{mode}: {checked:#}");
        let message = checked["message"].as_str().unwrap();
        assert!(message.starts_with("도구 목록을 받지 못했습니다: ") && message.contains("token expired"), "{mode}: {checked:#}");
    }
    // A null result without an error: connected, its log saying why it
    // shows no tools.
    let server = fake("sloppy", &["*"], &[("FAKE_MCP_LIST_SHAPE", r#"{"jsonrpc":"2.0","result":null}"#)]);
    let hub = McpHub::default();
    hub.apply(std::slice::from_ref(&server));
    let status = ready(&hub, "sloppy").await;
    assert_eq!(status["tools"], json!([]));
    assert!(log_text(&status).contains("도구 배열(tools)이 없어"), "{}", log_text(&status));
    hub.shutdown().await;
}

/// MCP review, sixteenth pass: a tool's own failure text was cut to 4,000
/// characters, but a protocol error's message went to the model whole —
/// a server echoing a large input in its "invalid params" error filled the
/// result, its archive and the token counting with it.
#[tokio::test]
async fn a_servers_error_message_is_bounded_like_a_tools() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("shape", &["echo"], &[])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "shape").await;
    for code in [-32602, -32601, -32000] {
        let message = format!("bad input: {}", "가".repeat(300_000));
        let shape = json!({"jsonrpc":"2.0","error":{"code":code,"message":message}});
        let error = call(&hub, &config, "shape__echo", json!({"text":format!("shape:{shape}")})).await.unwrap_err().to_string();
        assert!(error.contains("bad input: 가가"), "{code}: {}", &error[..200.min(error.len())]);
        assert!(error.chars().count() < 4_400, "{code}: {} characters", error.chars().count());
    }
    hub.shutdown().await;
}

/// A model endpoint that refuses its first requests in the words given, one
/// each, and answers the rest from the script.
struct RefusesFirst {
    inner: std::sync::Arc<Scripted>,
    refusals: std::sync::Mutex<std::collections::VecDeque<String>>,
}

#[async_trait::async_trait]
impl llm_agent::llm::LlmClient for RefusesFirst {
    async fn complete(
        &self,
        request: Value,
        config: &llm_agent::config::LlmConfig,
        cancel: CancellationToken,
        delta: tokio::sync::mpsc::Sender<String>,
    ) -> anyhow::Result<llm_agent::llm::Completion> {
        let refusal = self.refusals.lock().unwrap().pop_front();
        if let Some(refusal) = refusal {
            self.inner.requests.lock().unwrap().push(request);
            anyhow::bail!(refusal);
        }
        self.inner.complete(request, config, cancel, delta).await
    }
}

/// MCP review, eighteenth pass: a provider that validates the model's tool
/// calls (Groq: `tool_use_failed`) refuses the request when the model writes
/// a call that does not match its tool, naming the tool. That was taken for
/// a refusal of the tool's definition: the tool was left out of the question
/// and of every later one sent there, though its definition was taken — the
/// model only wrote one bad call.
#[tokio::test]
async fn a_bad_call_the_provider_refuses_does_not_leave_its_tool_out() {
    if node_missing() {
        return;
    }
    let refusals = [
        r#"http_400: {"error":{"message":"tool call validation failed: parameters for tool fake__echo did not match schema: errors: [missing properties: 'text']","type":"invalid_request_error","code":"tool_use_failed","failed_generation":"<function=fake__echo>{}</function>"}}"#,
        r#"http_400: {"error":{"message":"Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"tool_use_failed","failed_generation":"<function=fake__echo>{\"tex\": \"x\"}</function>"}}"#,
    ];
    for refusal in refusals {
        let config = config(vec![fake("fake", &["echo", "add"], &[])]);
        let scripted = Scripted::new(vec![text("끝"), text("둘째")]);
        let llm = std::sync::Arc::new(RefusesFirst { inner: scripted.clone(), refusals: std::sync::Mutex::new([refusal.to_owned()].into()) });
        let (app, _dir) = app(config.clone(), llm);
        app.mcp.apply(&config.mcp_servers);
        ready(&app.mcp, "fake").await;
        let (result, _) = ask(&app, "에코 해줘").await;
        assert_eq!(result.unwrap_or_else(|e| panic!("{refusal}: {e:#}")).answer, "끝");
        let requests = scripted.requests();
        assert_eq!(requests.len(), 2, "refused once, then asked again");
        assert!(tool_names(&requests[1]).contains(&"fake__echo".to_owned()), "{:?}", tool_names(&requests[1]));
        // Asked again told why, as for any call that could not be used.
        assert!(requests[1].to_string().contains("tool_use_failed"), "the model is told what was wrong");
        let status = app.mcp.server_status("fake", MODEL).unwrap();
        let echo = status["tools"].as_array().unwrap().iter().find(|t| t["name"] == "echo").unwrap().clone();
        assert!(echo["refused"].is_null(), "{echo}");
        assert!(app.mcp.snapshot(&config).find("fake__echo").is_some());
        let (result, _) = ask(&app, "다시").await;
        assert_eq!(result.unwrap().answer, "둘째");
        assert!(tool_names(&scripted.requests()[2]).contains(&"fake__echo".to_owned()));
        app.mcp.shutdown().await;
    }
}

/// MCP review, eighteenth pass: an allow-list entry may name a tool as the
/// model sees it (`fake__echo`). Renaming the server on the admin screen
/// kept such an entry under the old name, which no tool answers any more:
/// the tool silently left every question.
#[tokio::test]
async fn renaming_a_server_keeps_its_tools_allowed() {
    if node_missing() {
        return;
    }
    let mut keyed = config(vec![]);
    keyed.admin_token = Some(Secret("key".into()));
    let (app, _dir) = app(keyed, Scripted::new(vec![]));
    let admin = Admin { router: llm_agent::web::router(app.clone()), token: Some("key".into()) };
    let draft = json!({"name":"fake","command":"node","args":[fixture().display().to_string()],"tools":["fake__echo","add","FAKE__strict"]});
    let (status, created, text) = admin.send("POST", "mcp", Some(draft), None).await;
    assert_eq!(status, 201, "{text}");
    ready(&app.mcp, "fake").await;
    assert_eq!(app.mcp.snapshot(&app.config()).names().collect::<Vec<_>>(), ["fake__echo", "fake__add"]);
    // As the screen sends it: the whole form, the entries as they were.
    let renamed = json!({"name":"jira","command":"node","args":[fixture().display().to_string()],"tools":["fake__echo","add","FAKE__strict"]});
    let (status, updated, text) = admin.send("PUT", "mcp/fake", Some(renamed), Some(created["revision"].as_str().unwrap())).await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(updated["tools"], json!(["jira__echo", "add", "FAKE__strict"]), "an entry that named no tool of it (another case) stays as it was");
    ready(&app.mcp, "jira").await;
    assert_eq!(app.mcp.snapshot(&app.config()).names().collect::<Vec<_>>(), ["jira__echo", "jira__add"]);
    // A name changed in case only: the model's names follow it.
    let (status, updated, text) = admin.send("PUT", "mcp/jira", Some(json!({"name":"Jira"})), Some(updated["revision"].as_str().unwrap())).await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(updated["tools"], json!(["Jira__echo", "add", "FAKE__strict"]));
    ready(&app.mcp, "Jira").await;
    assert_eq!(app.mcp.snapshot(&app.config()).names().collect::<Vec<_>>(), ["Jira__echo", "Jira__add"]);
    app.mcp.shutdown().await;
}

/// MCP review, eighteenth pass: hosted MCP services put their secret in the
/// address's path (Zapier `…/api/mcp/s/<secret>/mcp`, Make `…/u/<token>/…`).
/// A connection error quotes the address whole, and it went to the model's
/// provider in `mcp_server_unavailable`, the path with it: the model is told
/// the server's host only. The admin screen, which shows the address
/// anyway, keeps it.
#[tokio::test]
async fn a_secret_in_the_address_path_is_not_told_to_the_model() {
    if node_missing() {
        return;
    }
    let remote = HttpServer::start(&[]);
    let port: u16 = remote.url.rsplit(':').next().unwrap().trim_end_matches("/mcp").parse().unwrap();
    let url = format!("{}/s/SECRETPATH/mcp", remote.url);
    let server = McpServer { name: "web".into(), url, tools: vec!["echo".into()], ..Default::default() };
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "web").await;
    drop(remote);
    let error = call(&hub, &config, "web__echo", json!({"text":"x"})).await.unwrap_err().to_string();
    assert!(error.starts_with("mcp_server_unavailable:") && error.contains("연결이 거부되었습니다"), "{error}");
    assert!(!error.contains("SECRETPATH"), "{error}");
    assert!(error.contains(&format!("127.0.0.1:{port}")), "the host is still named: {error}");
    let failed = wait_for(&hub, "web", |s| s["state"] == "failed").await;
    let told = hub.unoffered("web__echo").expect("told why");
    assert!(told.starts_with("mcp_server_unavailable:") && !told.contains("SECRETPATH"), "{told}");
    assert!(told.contains("연결이 거부되었습니다"), "the cause is kept: {told}");
    assert!(failed["error"].as_str().unwrap().contains("SECRETPATH"), "the admin sees the address configured: {failed:#}");
    hub.shutdown().await;
}

/// MCP review, eighteenth pass: an HTTP error quotes the body the server
/// answered with — a proxy's error page, a web app's 404 page — and the
/// whole of it went to the model in the call's error (and stayed in the
/// server's error, which the admin screen reads every few seconds), as the
/// JSON-RPC error messages bounded in the sixteenth pass did.
#[tokio::test]
async fn an_error_page_the_server_answers_with_is_bounded() {
    if node_missing() {
        return;
    }
    let body = "200000";
    let remote = HttpServer::start(&[("FAKE_MCP_CALL_STATUS", "502"), ("FAKE_MCP_CALL_STATUS_TOOL", "echo"), ("FAKE_MCP_ERROR_BODY", body)]);
    let server = McpServer { name: "proxied".into(), url: remote.url.clone(), tools: vec!["echo".into()], ..Default::default() };
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "proxied").await;
    let error = call(&hub, &config, "proxied__echo", json!({"text":"x"})).await.unwrap_err().to_string();
    assert!(error.starts_with("mcp_request_failed:") && error.contains("서버 쪽 오류") && error.contains("<html><body>xxx"), "{}", &error[..300.min(error.len())]);
    assert!(error.chars().count() < 3_000, "{} characters to the model", error.chars().count());
    hub.shutdown().await;
    // A page at an address that is no MCP endpoint, at the initialization:
    // the server's error, the model's cause and the probe's message.
    let wrong = McpServer { name: "wrong".into(), url: remote.url.replace("/mcp", "/app"), tools: vec!["echo".into()], ..Default::default() };
    let hub = McpHub::default();
    hub.apply(std::slice::from_ref(&wrong));
    let failed = wait_for(&hub, "wrong", |s| s["state"] == "failed").await;
    let shown = failed["error"].as_str().unwrap();
    assert!(shown.contains("MCP 엔드포인트가 없습니다") && shown.contains("<html><body>xxx"), "{}", &shown[..300.min(shown.len())]);
    assert!(shown.chars().count() < 3_000, "{} characters on the admin screen", shown.chars().count());
    let told = hub.unoffered("wrong__echo").unwrap();
    assert!(told.chars().count() < 3_000, "{} characters to the model", told.chars().count());
    hub.shutdown().await;
    let checked = probe(&wrong, MODEL).await.unwrap();
    assert!(checked["message"].as_str().unwrap().chars().count() < 3_000);
}

/// Resource-leak review: a request given up unanswered — the ping after a
/// timeout here, a changed tool list read past its limit alike — was only
/// dropped, never cancelled. The server went on with it, and over HTTP its
/// POST held a connection and one of the requests the session carries until
/// the server answered: three changed lists never answered held three
/// connections, until a reconnection. It is told to stop, as a call is.
#[tokio::test]
async fn a_request_given_up_tells_the_server_to_stop() {
    if node_missing() {
        return;
    }
    let mut server = fake("quiet", &["slow", "echo"], &[("FAKE_MCP_NO_PING", "1")]);
    server.timeout_secs = Some(1);
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "quiet").await;
    // The call times out and its ping is never answered; an answer to
    // another call meanwhile keeps the server taken for alive.
    let (slowed, answered) = tokio::join!(call(&hub, &config, "quiet__slow", json!({"ms":3_000})), async {
        tokio::time::sleep(Duration::from_secs(2)).await;
        call(&hub, &config, "quiet__echo", json!({"text":"살아 있음"})).await
    });
    assert!(slowed.unwrap_err().to_string().starts_with("mcp_timeout:"));
    assert_eq!(answered.unwrap()["text"], "echo: 살아 있음");
    // The fake server notes each cancellation it gets on stderr.
    let status = wait_for(&hub, "quiet", |s| log_text(s).contains("no longer awaited")).await;
    assert_eq!((status["state"].clone(), status["restarts"].clone()), (json!("ready"), json!(0)), "{status:#}");
    hub.shutdown().await;
}

/// Resource-leak review: a stdio server got three seconds once its input
/// closed, then was killed — never asked to stop. One that outlives its
/// input (a Node server holding a database pool) could not clean up: run as
/// `docker run -i --rm --init`, its container went on running after each
/// reconnection and after the backend ended. SIGTERM now comes first, as
/// the MCP specification and the official SDKs have it — for a connection
/// given up while it starts too.
#[cfg(unix)]
#[tokio::test]
async fn a_server_that_outlives_its_input_is_asked_to_stop_before_it_is_killed() {
    if node_missing() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let noted = dir.path().join("reconnected");
    let lingering = fake("linger", &["echo"], &[("FAKE_MCP_LINGER", "1"), ("FAKE_MCP_TERM_FILE", &noted.display().to_string())]);
    let hub = McpHub::default();
    hub.apply(std::slice::from_ref(&lingering));
    ready(&hub, "linger").await;
    assert!(hub.restart("linger"));
    wait_for(&hub, "linger", |s| s["state"] == "ready" && s["restarts"] == 1).await;
    assert_eq!(std::fs::read_to_string(&noted).ok().as_deref(), Some("SIGTERM"), "the process closed was asked to stop");
    hub.shutdown().await;
    // Stopped while it starts (it never answers the initialization).
    let starting = dir.path().join("starting");
    let stuck = fake("stuck", &["echo"], &[("FAKE_MCP_HANG_INIT", "1"), ("FAKE_MCP_LINGER", "1"), ("FAKE_MCP_TERM_FILE", &starting.display().to_string())]);
    let hub = McpHub::default();
    hub.apply(std::slice::from_ref(&stuck));
    wait_for(&hub, "stuck", |s| s["state"] == "connecting" && s["pid"].is_number()).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    hub.shutdown().await;
    assert_eq!(std::fs::read_to_string(&starting).ok().as_deref(), Some("SIGTERM"), "the process given up while it started was asked to stop");
}

/// MCP review (leaks, panics, deadlocks, context): a connection check that
/// ran out of time once its server had connected (a tool list unanswered)
/// killed the server's group at once, while the connection was still being
/// closed in order: a server that outlives its input was never asked to
/// stop — run as `docker run -i --rm --init`, its container went on running
/// after each such check.
#[cfg(unix)]
#[tokio::test]
async fn a_connection_check_out_of_time_asks_its_server_to_stop() {
    if node_missing() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let noted = dir.path().join("checked");
    let server = fake("slowlist", &["echo"], &[("FAKE_MCP_HANG_LIST", "1"), ("FAKE_MCP_LINGER", "1"), ("FAKE_MCP_TERM_FILE", &noted.display().to_string())]);
    let started = Instant::now();
    let checked = probe(&server, MODEL).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(std::fs::read_to_string(&noted).ok().as_deref(), Some("SIGTERM"), "the server checked was asked to stop");
    assert_eq!(checked["ok"], false, "{checked:#}");
    assert!(checked["message"].as_str().unwrap().contains("도구 목록을 받지 못했습니다"), "{checked:#}");
    assert!(started.elapsed() < Duration::from_secs(37), "{:?}", started.elapsed());
}

/// MCP review, twenty-second pass: a connection check ran in the admin's
/// request, which the web server drops once its client leaves (the screen
/// reloaded while a docker image downloads). Dropped while its server
/// started, the server was killed outright — run as `docker run -i --rm
/// --init`, its container went on running. Given up, it now closes its
/// server in order; so does a check under way when the backend stops, which
/// waits for it.
#[cfg(unix)]
#[tokio::test]
async fn a_connection_check_given_up_closes_its_server_in_order() {
    if node_missing() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let starting = |noted: &std::path::Path| {
        fake("starting", &["echo"], &[("FAKE_MCP_HANG_INIT", "1"), ("FAKE_MCP_LINGER", "1"), ("FAKE_MCP_TERM_FILE", &noted.display().to_string())])
    };
    let dropped = dir.path().join("dropped");
    let _ = tokio::time::timeout(Duration::from_millis(1_500), probe(&starting(&dropped), MODEL)).await;
    let asked = Instant::now();
    while !dropped.exists() && asked.elapsed() < Duration::from_secs(8) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(std::fs::read_to_string(&dropped).ok().as_deref(), Some("SIGTERM"), "the server of a check dropped was asked to stop");
    let stopped = dir.path().join("stopped");
    let hub = McpHub::default();
    let checking = {
        let (hub, server) = (hub.clone(), starting(&stopped));
        tokio::spawn(async move { hub.probe(&server, MODEL).await })
    };
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let started = Instant::now();
    hub.shutdown().await;
    assert_eq!(std::fs::read_to_string(&stopped).ok().as_deref(), Some("SIGTERM"), "the backend stopped once its check's server was asked to stop");
    assert!(started.elapsed() < Duration::from_secs(7), "{:?}", started.elapsed());
    let checked = checking.await.unwrap().unwrap();
    assert_eq!(checked["ok"], false, "{checked:#}");
    assert!(checked["message"].as_str().unwrap().contains("그만두었습니다"), "{checked:#}");
    assert!(hub.probe(&starting(&stopped), MODEL).await.is_err(), "no check starts once the backend stops");
}

/// Resource-leak review: a helper a server starts outside its process group
/// (a daemon) keeps the server's stderr open after the server is gone. Its
/// reader ran on until the helper ended — a task and a pipe each time — and
/// what the helper wrote went on into the log of the server's next process.
#[cfg(unix)]
#[tokio::test]
async fn the_output_of_a_server_gone_is_read_no_more() {
    if node_missing() {
        return;
    }
    let config = config(vec![fake("daemon", &["spawn_detached"], &[("FAKE_MCP_DETACHED", "1")])]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "daemon").await;
    let helper: i32 = call(&hub, &config, "daemon__spawn_detached", json!({})).await.unwrap()["text"].as_str().unwrap().parse().unwrap();
    let ticks = |status: &Value| log_text(status).matches("helper tick").count();
    wait_for(&hub, "daemon", |s| ticks(s) > 0).await;
    assert!(hub.restart("daemon"));
    wait_for(&hub, "daemon", |s| s["state"] == "ready" && s["restarts"] == 1).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let before = ticks(&hub.server_status("daemon", MODEL).unwrap());
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let after = ticks(&hub.server_status("daemon", MODEL).unwrap());
    // SAFETY: only signals the helper the test started.
    unsafe {
        libc::kill(helper, libc::SIGKILL);
    }
    assert_eq!(before, after, "the helper's output still reaches the log of the server's next process");
    hub.shutdown().await;
}

/// Answers JSON cannot hold as the SDK reads it — a number it cannot write
/// (NaN and Infinity from Python's json.dumps, an integer of 400 digits),
/// nesting past the parser's 128 levels — and an answer without its result
/// (a JavaScript handler's `undefined`): over stdio the SDK dropped them
/// and the call waited out its timeout; over SSE they ended the session,
/// with every call on it (twenty-fourth pass). Each ends its call at once.
#[tokio::test]
async fn answers_json_cannot_hold_neither_hang_nor_end_the_session() {
    if node_missing() {
        return;
    }
    let digits = format!("1{}", "0".repeat(400));
    let deep = format!("{}1{}", "[".repeat(200), "]".repeat(200));
    let answers: Vec<(String, Result<String, &str>)> = vec![
        (
            r#"{"jsonrpc":"2.0","id":@ID@,"result":{"content":[],"structuredContent":{"mean":NaN,"range":[-Infinity,Infinity]}}}"#.into(),
            Ok(r#"{"mean":null,"range":[null,null]}"#.into()),
        ),
        (format!(r#"{{"jsonrpc":"2.0","id":@ID@,"result":{{"content":[],"structuredContent":{{"n":{digits}}}}}}}"#), Ok(format!(r#"{{"n":"{digits}"}}"#))),
        (
            format!(r#"{{"jsonrpc":"2.0","id":@ID@,"result":{{"content":[],"structuredContent":{{"v":{deep}}}}}}}"#),
            Err("mcp_request_failed: the server answered, but its answer could not be read as JSON (recursion limit exceeded"),
        ),
        (r#"{"jsonrpc":"2.0","id":@ID@}"#.into(), Err("mcp_request_failed: raw__echo sent an unexpected response")),
    ];
    for mode in ["stdio", "sse"] {
        let remote;
        let server = if mode == "stdio" {
            fake("raw", &["echo"], &[])
        } else {
            remote = HttpServer::start(&[("FAKE_MCP_SSE", "1")]);
            McpServer { name: "raw".into(), url: remote.url.clone(), tools: vec!["echo".into()], ..Default::default() }
        };
        let config = config(vec![McpServer { timeout_secs: Some(10), ..server }]);
        let hub = McpHub::default();
        hub.apply(&config.mcp_servers);
        ready(&hub, "raw").await;
        for (answer, expected) in &answers {
            let started = Instant::now();
            let outcome = call(&hub, &config, "raw__echo", json!({"text":format!("raw:{answer}")})).await;
            let shown: String = answer.chars().take(100).collect();
            assert!(started.elapsed() < Duration::from_secs(3), "{mode}: answered at once, not at the timeout: {shown}");
            match expected {
                Ok(text) => assert_eq!(outcome.unwrap()["text"], json!(text), "{mode}: {shown}"),
                Err(start) => {
                    let error = outcome.unwrap_err().to_string();
                    assert!(error.starts_with(start), "{mode}: {shown}: {error}");
                }
            }
        }
        assert_eq!(call(&hub, &config, "raw__echo", json!({"text":"after"})).await.unwrap()["text"], "echo: after", "{mode}");
        let status = hub.server_status("raw", MODEL).unwrap();
        assert_eq!((status["state"].clone(), status["restarts"].clone()), (json!("ready"), json!(0)), "{mode}: the session stayed");
        hub.shutdown().await;
    }
}

/// A call whose event stream ends before its answer — a proxy's idle
/// timeout cutting a long call (nginx's is 60 s), the session fine — fails
/// alone: it was taken for a lost connection, and the session made again
/// ended every other conversation's call on it (twenty-fourth pass). A
/// server gone during a call is still reconnected at once.
#[tokio::test]
async fn a_call_whose_stream_is_cut_fails_alone() {
    if node_missing() {
        return;
    }
    let remote = HttpServer::start(&[("FAKE_MCP_SSE", "1"), ("FAKE_MCP_CUT", "1")]);
    let server = McpServer { name: "web".into(), url: remote.url.clone(), tools: vec!["slow".into(), "cut_stream".into()], timeout_secs: Some(10), ..Default::default() };
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "web").await;
    let snapshot = hub.snapshot(&config);
    let slow = snapshot.find("web__slow").unwrap();
    let others = slow_calls(&slow, Instant::now(), &[("a", 0.0, 2_000), ("b", 0.0, 2_000), ("c", 0.8, 1_500)]);
    let cut = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let started = Instant::now();
        let outcome = snapshot.find("web__cut_stream").unwrap().call(json!({"ms":200}), &CancellationToken::new()).await;
        (outcome.unwrap_err().to_string(), started.elapsed())
    };
    let (others, (error, took)) = tokio::join!(others, cut);
    assert!(took < Duration::from_secs(2), "{took:?}");
    assert!(error.starts_with("mcp_request_failed: the connection to MCP server web closed before web__cut_stream answered"), "{error}");
    assert!(error.ends_with("it may have taken effect on the server"), "{error}");
    for (tag, outcome) in &others {
        assert!(outcome.is_ok(), "{tag}: the other conversations' calls go on: {outcome:?}");
    }
    let status = hub.server_status("web", MODEL).unwrap();
    assert_eq!((status["state"].clone(), status["restarts"].clone()), (json!("ready"), json!(0)), "{}", log_text(&status));
    // Gone during a call: the ping after it finds no server.
    let gone = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(remote);
    };
    let started = Instant::now();
    let never = CancellationToken::new();
    let held = snapshot.find("web__cut_stream").unwrap();
    let (outcome, ()) = tokio::join!(held.call(json!({"hold":true}), &never), gone);
    let error = outcome.unwrap_err().to_string();
    assert!(error.starts_with("mcp_request_failed: the connection to MCP server web closed before") && error.contains("may have taken effect"), "{error}");
    let failed = wait_for(&hub, "web", |s| s["state"] == "failed").await;
    assert!(started.elapsed() < Duration::from_secs(4), "reconnected at once: {:?}", started.elapsed());
    assert!(log_text(&failed).contains("호출의 답이 오기 전에 연결이 끊겼고, 살아 있는지 묻는 ping에도"), "{}", log_text(&failed));
    hub.shutdown().await;
    // A server answering in plain JSON, gone while it worked on the call:
    // the call may have done its work.
    let remote = HttpServer::start(&[]);
    let server = McpServer { name: "json".into(), url: remote.url.clone(), tools: vec!["slow".into()], timeout_secs: Some(10), ..Default::default() };
    let config = self::config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    ready(&hub, "json").await;
    let slow = hub.snapshot(&config).find("json__slow").unwrap();
    let gone = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        drop(remote);
    };
    let (outcome, ()) = tokio::join!(slow.call(json!({"ms":5_000}), &never), gone);
    let error = outcome.unwrap_err().to_string();
    assert!(error.starts_with("mcp_server_unavailable:") && error.ends_with("it may have taken effect on the server"), "{error}");
    wait_for(&hub, "json", |s| s["state"] == "failed").await;
    hub.shutdown().await;
}


/// The process's largest resident memory so far, in MiB.
#[cfg(unix)]
fn peak_memory_mib() -> u64 {
    // SAFETY: getrusage only writes the struct it is given.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    // Bytes on macOS, kilobytes elsewhere.
    let unit = if cfg!(target_os = "macos") { 1 } else { 1024 };
    usage.ru_maxrss as u64 * unit / (1 << 20)
}

/// MCP review, twenty-sixth pass: the SDK read an HTTP answer in plain JSON,
/// and an HTTP error's body, whole — over stdio a line, over SSE an event
/// is read to 16 MiB. A tool answering 300 MiB took some 1.2 GB of the
/// backend's memory, a 300 MiB error page 1.6 GB, and an error page without
/// end grew it until the system killed the backend. An answer is read to
/// 16 MiB: past it, it answers its call with an error, at once, and the
/// session stays.
#[tokio::test]
async fn an_answer_past_what_one_message_may_be_is_not_read() {
    if node_missing() {
        return;
    }
    // (served as, size in MiB or without end, what the model is told)
    for (mode, mb, told) in [
        ("json", Some(300), "more than 16 MiB"),
        ("json", None, "more than 16 MiB"),
        ("sse", None, "more than 16 MiB"),
        ("500", None, "answered HTTP 500"),
    ] {
        let env: &[(&str, &str)] = match mode {
            "sse" => &[("FAKE_MCP_SSE", "1")],
            "500" => &[("FAKE_MCP_FLOOD_STATUS", "500")],
            _ => &[],
        };
        let remote = HttpServer::start(env);
        let server = McpServer {
            name: "flood".into(),
            url: remote.url.clone(),
            tools: vec!["flood_line".into(), "echo".into()],
            timeout_secs: Some(20),
            ..Default::default()
        };
        let config = config(vec![server]);
        let hub = McpHub::default();
        hub.apply(&config.mcp_servers);
        ready(&hub, "flood").await;
        #[cfg(unix)]
        let before = peak_memory_mib();
        let started = Instant::now();
        let args = mb.map_or(json!({}), |mb| json!({"mb":mb}));
        let error = call(&hub, &config, "flood__flood_line", args).await.unwrap_err().to_string();
        assert!(started.elapsed() < Duration::from_secs(5), "{mode} {mb:?}: {:?}, not at the timeout", started.elapsed());
        assert!(error.starts_with("mcp_request_failed:") && error.contains(told), "{mode} {mb:?}: {}", &error[..400.min(error.len())]);
        assert!(error.chars().count() < 3_000, "{mode} {mb:?}: {} characters to the model", error.chars().count());
        #[cfg(unix)]
        {
            let grown = peak_memory_mib().saturating_sub(before);
            assert!(grown < 256, "{mode} {mb:?}: the peak memory grew {grown} MiB");
        }
        // The session stays, and serves the next call.
        assert_eq!(call(&hub, &config, "flood__echo", json!({"text":"다음"})).await.unwrap()["text"], "echo: 다음", "{mode}");
        let status = hub.server_status("flood", MODEL).unwrap();
        assert_eq!((status["state"].clone(), status["restarts"].clone()), (json!("ready"), json!(0)), "{mode} {mb:?}");
        hub.shutdown().await;
    }
}
