//! What MCP connections keep of the messages they carried, in a process of
//! their own: the heap is measured process-wide, a test at a time.

mod support;

use llm_agent::{
    config::{Config, McpServer},
    mcp::McpHub,
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

/// One test measures at a time.
static MEASURING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_mcp_server.mjs")
}

fn node_missing() -> bool {
    let missing = Command::new("node").arg("--version").output().is_err();
    if missing {
        assert!(std::env::var("REQUIRE_NODE").as_deref() != Ok("1"), "node is required (REQUIRE_NODE=1)");
        skip("node is not installed");
    }
    missing
}

fn config(servers: Vec<McpServer>) -> Config {
    let mut config = Config::default();
    config.mariadb.port = 9;
    config.llm.model = MODEL.into();
    config.mcp_servers = servers;
    config
}

/// Within twenty seconds, each server's status passes `done`.
async fn wait_for(hub: &McpHub, config: &Config, done: impl Fn(&Value) -> bool) {
    let started = Instant::now();
    for server in &config.mcp_servers {
        loop {
            let status = hub.server_status(&server.name, MODEL).unwrap();
            if done(&status) {
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(20), "{}: {status:#}", server.name);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

/// A fake HTTP server, its environment `env`, ended when dropped.
struct HttpServer(Child, String);

impl HttpServer {
    fn start(env: &[(&str, &str)]) -> Self {
        let mut child = Command::new("node")
            .arg(fixture())
            .arg("--http")
            .envs(env.iter().copied())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let port = line.trim().strip_prefix("listening ").unwrap().to_owned();
        Self(child, format!("http://127.0.0.1:{port}/mcp"))
    }

    fn server(&self, name: &str) -> McpServer {
        McpServer { name: name.into(), description: format!("가짜 MCP 서버 {name}"), url: self.1.clone(), tools: vec!["*".into()], ..Default::default() }
    }
}

impl Drop for HttpServer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn fake(name: &str) -> McpServer {
    McpServer {
        name: name.into(),
        description: format!("가짜 MCP 서버 {name}"),
        command: "node".into(),
        args: vec![fixture().display().to_string()],
        tools: vec!["*".into()],
        ..Default::default()
    }
}

/// Resource review, twenty-third pass: the SDK's stdio reader kept its line
/// buffer the size of the longest line a server had sent, and its writer
/// that of the largest message sent to it, for as long as the server stayed
/// connected — four servers that answered 12 MB once held 64 MiB after
/// their next, small, answers (128 MiB right after the large ones).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn large_messages_carried_leave_no_buffers_behind() {
    if node_missing() {
        return;
    }
    if heap_in_use().is_none() {
        return skip("the heap in use is not measured on this platform");
    }
    let _measuring = MEASURING.lock().await;
    let servers = 4;
    let config = config((0..servers).map(|i| fake(&format!("s{i}"))).collect());
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    wait_for(&hub, &config, |s| s["state"] == "ready").await;
    let calls = |args: Value| {
        let snapshot = hub.snapshot(&config);
        async move {
            for i in 0..servers {
                let tool = snapshot.find(&format!("s{i}__big")).unwrap();
                tool.call(args.clone(), &CancellationToken::new()).await.unwrap();
            }
        }
    };
    calls(json!({"chars": 10})).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before = heap_in_use().unwrap();
    // Large answers, then a large message to each server.
    calls(json!({"chars": 12_000_000})).await;
    calls(json!({"chars": 10, "padding": "p".repeat(8_000_000)})).await;
    calls(json!({"chars": 10})).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let grown = heap_in_use().unwrap().saturating_sub(before);
    hub.shutdown().await;
    assert!(grown < 16 << 20, "{} MiB more while {servers} servers that carried large messages stay connected", grown >> 20);
}

/// Resource review, twenty-third pass: the SDK read a GET's event stream
/// with a parser that kept a line it had in parts in a buffer the size of
/// the longest, for as long as the stream stayed open — about 17 MiB a
/// server after one log message of 12 MB.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_large_event_read_leaves_no_buffer_behind() {
    if node_missing() {
        return;
    }
    if heap_in_use().is_none() {
        return skip("the heap in use is not measured on this platform");
    }
    let _measuring = MEASURING.lock().await;
    // The HTTP client's first use (its certificates) is not counted.
    let plain = HttpServer::start(&[]);
    let warm = McpHub::default();
    let warming = config(vec![plain.server("plain")]);
    warm.apply(&warming.mcp_servers);
    wait_for(&warm, &warming, |s| s["state"] == "ready").await;
    warm.shutdown().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before = heap_in_use().unwrap();
    let streams: Vec<HttpServer> = (0..4).map(|_| HttpServer::start(&[("FAKE_MCP_GET", "big")])).collect();
    let config = config(streams.iter().enumerate().map(|(i, s)| s.server(&format!("h{i}"))).collect());
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    let logged = |s: &Value| s["log"].as_array().unwrap().iter().any(|l| l["text"].as_str().unwrap_or("").starts_with("info: bbb"));
    wait_for(&hub, &config, |s| s["state"] == "ready" && logged(s)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let grown = heap_in_use().unwrap().saturating_sub(before);
    hub.shutdown().await;
    assert!(grown < 16 << 20, "{} MiB more while 4 servers that sent a large event stay connected", grown >> 20);
}

/// Resource review, thirty-third pass: the SDK reads on while each answer
/// to a server's own request waits to be written, on a task of its own. A
/// stdio server that stopped reading its input and went on asking (pings)
/// had every answer kept waiting, for as long as it stayed connected and
/// shown ready: 300,000 pings held 1 GiB. Past `ANSWERS_WAITING` answers
/// the server is reconnected instead.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_that_asks_without_reading_the_answers_is_reconnected() {
    if node_missing() {
        return;
    }
    if heap_in_use().is_none() {
        return skip("the heap in use is not measured on this platform");
    }
    let _measuring = MEASURING.lock().await;
    let mut server = fake("asker");
    server.env = [("FAKE_MCP_ASK_FLOOD".to_owned(), "100000".to_owned())].into();
    let config = config(vec![server]);
    let hub = McpHub::default();
    hub.apply(&config.mcp_servers);
    wait_for(&hub, &config, |s| s["state"] == "ready").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before = heap_in_use().unwrap();
    let snapshot = hub.snapshot(&config);
    snapshot.find("asker__stall_input").unwrap().call(json!({}), &CancellationToken::new()).await.unwrap();
    wait_for(&hub, &config, |s| s["restarts"].as_u64() >= Some(1) && s["state"] == "ready").await;
    let grown = heap_in_use().unwrap().saturating_sub(before);
    let status = hub.server_status("asker", MODEL).unwrap();
    hub.shutdown().await;
    let told = status["log"].as_array().unwrap().iter().any(|l| l["text"].as_str().unwrap_or("").contains("입력을 읽지 않으면서 요청을 계속 보내"));
    assert!(told, "{status:#}");
    assert!(grown < 16 << 20, "{} MiB more after a server asked without reading the answers", grown >> 20);
}
