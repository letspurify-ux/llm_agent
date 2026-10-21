//! The server binary as a process (Unix): how it stops on a hangup, and how
//! it runs once the reader of its output is gone — its launcher (start.sh's
//! log wrapper) ended, or the terminal it ran in was closed.
#![cfg(unix)]

use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};

/// Whether the fake MCP server cannot run (CI sets REQUIRE_NODE=1).
fn node_missing() -> bool {
    let missing = std::process::Command::new("node").arg("--version").output().is_err();
    if missing {
        assert!(std::env::var("REQUIRE_NODE").as_deref() != Ok("1"), "node is required (REQUIRE_NODE=1)");
        eprintln!("skipped: node is not installed");
    }
    missing
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn toml_string(text: &str) -> String {
    serde_json::to_string(text).unwrap()
}

/// Settings of a backend on `port`, its model at `llm`, without a
/// management DB (refused at once: port 9); `extra` follows (MCP servers).
fn settings(dir: &Path, port: u16, llm: u16, extra: &str) -> PathBuf {
    let path = dir.join("config.toml");
    let text = format!(
        "[llm]\nbase_url = \"http://127.0.0.1:{llm}/v1\"\nmodel = \"gpt-4o\"\ndisable_proxy = true\nretries = 0\n\n\
         [embedding]\nurl = \"\"\n\n[mariadb]\nhost = \"127.0.0.1\"\nport = 9\nuser = \"root\"\n\n\
         [oracle]\nmock = true\n\n[server]\nport = {port}\n{extra}"
    );
    std::fs::write(&path, text).unwrap();
    path
}

/// The backend binary with these settings, run in `dir` (no `.env` of the
/// checkout).
fn backend(dir: &Path, settings: &Path, output: fn() -> Stdio) -> Child {
    Command::new(env!("CARGO_BIN_EXE_llm-agent"))
        .arg("--config")
        .arg(settings)
        .current_dir(dir)
        .env_remove("LLM_AGENT_CONFIG")
        .stdin(Stdio::null())
        .stdout(output())
        .stderr(output())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(30)).build().unwrap()
}

fn signal(child: &Child, signal: libc::c_int) {
    // SAFETY: kill only sends a signal.
    unsafe {
        libc::kill(child.id().unwrap() as libc::pid_t, signal);
    }
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// An OpenAI-compatible model that answers every request in one streamed
/// text with its usage (the agent logs both).
async fn model() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut bytes = vec![];
                let mut buffer = [0u8; 65536];
                loop {
                    let Ok(n) = socket.read(&mut buffer).await else { return };
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                    let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&bytes[..at]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                        .unwrap_or(0);
                    if bytes.len() >= at + 4 + length {
                        break;
                    }
                }
                let event = |v: Value| format!("data: {v}\n\n");
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}{}{}data: [DONE]\n\n",
                    event(json!({"choices":[{"delta":{"content":"답입니다."},"finish_reason":null}]})),
                    event(json!({"choices":[{"delta":{},"finish_reason":"stop"}]})),
                    event(json!({"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":5}}))
                );
                let _ = socket.write_all(reply.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    port
}

/// The status of the backend's only MCP server once it is ready.
async fn ready_mcp(port: u16) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let status = client()
            .get(format!("http://127.0.0.1:{port}/api/admin/mcp"))
            .header("x-admin-request", "1")
            .send()
            .await;
        if let Ok(response) = status
            && let Ok(body) = response.json::<Value>().await
            && body["servers"][0]["status"]["state"] == "ready"
        {
            return body["servers"][0]["status"].clone();
        }
        assert!(Instant::now() < deadline, "the MCP server did not get ready");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// A hangup (the terminal closed, the log launcher passing on its own) ended
/// the backend on the spot, as SIGHUP's default does: its MCP servers were
/// not stopped, and one that outlives its input — a Node server holding a
/// database pool, a docker container — kept running, orphaned.
#[tokio::test]
async fn a_hangup_stops_the_backend_in_order_with_its_mcp_servers() {
    if node_missing() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let term = dir.path().join("term");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_mcp_server.mjs");
    // Its stderr goes nowhere: told of its input's end, the fixture writes a
    // line, and a write to a backend gone would end it.
    let command = format!("exec node '{}' 2>/dev/null", fixture.display());
    let mcp = format!(
        "\n[[mcp_servers]]\nname = \"linger\"\ncommand = \"sh\"\nargs = [\"-c\", {}]\ntools = [\"*\"]\n\n\
         [mcp_servers.env]\nFAKE_MCP_LINGER = \"1\"\nFAKE_MCP_TERM_FILE = {}\n",
        toml_string(&command),
        toml_string(&term.display().to_string())
    );
    let port = free_port();
    let path = settings(dir.path(), port, 9, &mcp);
    let mut child = backend(dir.path(), &path, Stdio::null);
    let server = ready_mcp(port).await;
    let pid = server["pid"].as_u64().unwrap() as u32;
    signal(&child, libc::SIGHUP);
    let status = tokio::time::timeout(Duration::from_secs(20), child.wait()).await.expect("the backend did not stop").unwrap();
    let left = alive(pid);
    if left {
        // SAFETY: kill only sends a signal.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
    assert!(status.success(), "{status:?}");
    assert!(!left, "the MCP server outlived the backend");
    assert_eq!(std::fs::read_to_string(&term).ok().as_deref(), Some("SIGTERM"), "the MCP server was not asked to stop");
}

/// Once the reader of its output was gone, each log line was a panic (std's
/// `eprintln!` panics when its write fails): every question failed at its
/// first line and left no chat log, and the shutdown that followed panicked
/// on its own first line, its MCP servers never closed.
#[tokio::test]
async fn a_backend_whose_output_is_no_longer_read_answers_and_stops_in_order() {
    let llm = model().await;
    let dir = tempfile::tempdir().unwrap();
    let port = free_port();
    let path = settings(dir.path(), port, llm, "");
    let mut child = backend(dir.path(), &path, Stdio::piped);
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if line.starts_with("agent server:") {
                return;
            }
        }
        panic!("the backend ended before it served");
    })
    .await
    .expect("the backend did not start");
    // Read no more, as when the launcher logging both outputs ends.
    drop(lines);
    drop(child.stderr.take());
    let url = format!("http://127.0.0.1:{port}/api/chat");
    let response = client().post(&url).json(&json!({"message":"안녕","conversation_id":"plain"})).send().await.unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert_eq!((status.as_u16(), body["answer"].as_str()), (200, Some("답입니다.")), "{body}");
    let streamed = client()
        .post(&url)
        .header("accept", "application/x-ndjson")
        .json(&json!({"message":"다시","conversation_id":"streamed"}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let last: Value = streamed.lines().last().map(|l| serde_json::from_str(l).unwrap()).unwrap_or_default();
    assert_eq!((last["type"].as_str(), last["answer"].as_str()), (Some("done"), Some("답입니다.")), "{streamed}");
    signal(&child, libc::SIGTERM);
    let stopped = tokio::time::timeout(Duration::from_secs(20), child.wait()).await.expect("the backend did not stop").unwrap();
    assert!(stopped.success(), "{stopped:?}");
}

/// A shell standing in for start.sh's log launcher: it starts the backend
/// (with `APP_LAUNCHER_PID` when `told`) and prints its process ID.
async fn launched(dir: &Path, settings: &Path, told: bool) -> (Child, u32) {
    let script = if told {
        r#"APP_LAUNCHER_PID=$$ "$0" --config "$1" </dev/null >/dev/null 2>&1 & echo $!; wait"#
    } else {
        r#""$0" --config "$1" </dev/null >/dev/null 2>&1 & echo $!; wait"#
    };
    let mut launcher = Command::new("sh")
        .arg("-c")
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_llm-agent"))
        .arg(settings)
        .current_dir(dir)
        .env_remove("LLM_AGENT_CONFIG")
        .env_remove("APP_LAUNCHER_PID")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(launcher.stdout.take().unwrap()).read_line(&mut line).await.unwrap();
    (launcher, line.trim().parse().unwrap())
}

fn kill(pid: u32, signal: libc::c_int) {
    // SAFETY: kill only sends a signal.
    unsafe {
        libc::kill(pid as libc::pid_t, signal);
    }
}

/// Whether `pid` runs: an orphan that ended stays a zombie until the
/// process that took it in (init, a subreaper) reaps it.
fn running(pid: u32) -> bool {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
    let zombie = stat.rsplit_once(')').is_some_and(|(_, rest)| rest.trim_start().starts_with('Z'));
    alive(pid) && !zombie
}

/// Whether `pid` ends within `limit` (a process not ours to wait for).
async fn ends_within(pid: u32, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while running(pid) {
        if Instant::now() > deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    true
}

/// The log launcher killed outright (SIGKILL: a force quit, the out-of-memory
/// killer) left its backend running on, orphaned: still holding the port,
/// its DB connections and its MCP servers, while stop.sh, which signals the
/// launcher, found nothing to stop and start.sh then found the port taken.
#[tokio::test]
async fn a_backend_whose_launcher_is_killed_stops_in_order() {
    if node_missing() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let term = dir.path().join("term");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_mcp_server.mjs");
    let command = format!("exec node '{}' 2>/dev/null", fixture.display());
    let mcp = format!(
        "\n[[mcp_servers]]\nname = \"linger\"\ncommand = \"sh\"\nargs = [\"-c\", {}]\ntools = [\"*\"]\n\n\
         [mcp_servers.env]\nFAKE_MCP_LINGER = \"1\"\nFAKE_MCP_TERM_FILE = {}\n",
        toml_string(&command),
        toml_string(&term.display().to_string())
    );
    let port = free_port();
    let path = settings(dir.path(), port, 9, &mcp);
    let (mut launcher, backend) = launched(dir.path(), &path, true).await;
    let server = ready_mcp(port).await;
    let mcp_pid = server["pid"].as_u64().unwrap() as u32;
    signal(&launcher, libc::SIGKILL);
    let _ = launcher.wait().await;
    let stopped = ends_within(backend, Duration::from_secs(20)).await;
    let left = running(mcp_pid);
    for pid in [backend, mcp_pid] {
        kill(pid, libc::SIGKILL);
    }
    assert!(stopped, "the backend outlived its launcher");
    assert!(!left, "the MCP server outlived the backend");
    assert_eq!(std::fs::read_to_string(&term).ok().as_deref(), Some("SIGTERM"), "the MCP server was not asked to stop");
}

/// The backend itself killed outright (SIGKILL, the out-of-memory killer, a
/// crash) ended nothing in order: an MCP server that outlives its input ran
/// on, orphaned, and each restart added another. A guardian of its own
/// (`mcp::guardian`) ends the server then: SIGTERM after the grace a closed
/// server gets, then SIGKILL.
#[tokio::test]
async fn a_killed_backend_leaves_no_mcp_server_running() {
    if node_missing() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let term = dir.path().join("term");
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_mcp_server.mjs");
    let command = format!("exec node '{}' 2>/dev/null", fixture.display());
    let mcp = format!(
        "\n[[mcp_servers]]\nname = \"linger\"\ncommand = \"sh\"\nargs = [\"-c\", {}]\ntools = [\"*\"]\n\n\
         [mcp_servers.env]\nFAKE_MCP_LINGER = \"1\"\nFAKE_MCP_TERM_FILE = {}\n",
        toml_string(&command),
        toml_string(&term.display().to_string())
    );
    let port = free_port();
    let path = settings(dir.path(), port, 9, &mcp);
    let mut child = backend(dir.path(), &path, Stdio::null);
    let server = ready_mcp(port).await;
    let pid = server["pid"].as_u64().unwrap() as u32;
    signal(&child, libc::SIGKILL);
    let _ = child.wait().await;
    let ended = ends_within(pid, Duration::from_secs(15)).await;
    kill(pid, libc::SIGKILL);
    assert!(ended, "the MCP server outlived the killed backend");
    assert_eq!(std::fs::read_to_string(&term).ok().as_deref(), Some("SIGTERM"), "the MCP server was not asked to stop");
}

/// Started without the launcher (`nohup`, a shell of its own), the backend
/// still outlives the process that started it.
#[tokio::test]
async fn a_backend_started_otherwise_outlives_its_parent() {
    let dir = tempfile::tempdir().unwrap();
    let port = free_port();
    let path = settings(dir.path(), port, 9, "");
    let (mut launcher, backend) = launched(dir.path(), &path, false).await;
    let health = format!("http://127.0.0.1:{port}/api/health");
    let deadline = Instant::now() + Duration::from_secs(30);
    while client().get(&health).send().await.is_err() {
        assert!(Instant::now() < deadline, "the backend did not start");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    signal(&launcher, libc::SIGKILL);
    let _ = launcher.wait().await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let serving = client().get(&health).send().await.is_ok_and(|r| r.status().is_success());
    kill(backend, libc::SIGTERM);
    assert!(ends_within(backend, Duration::from_secs(20)).await, "the backend did not stop on SIGTERM");
    assert!(serving, "the backend stopped with the process that started it");
}

/// Resource review, sixteenth pass: started from a macOS terminal the
/// backend had 256 descriptors (Node, which ran the former backend, raises
/// its limit at start; the Rust one did not), and a few hundred connections
/// at once — clients, the management DB, the model — took it out of
/// service: no answer, "too many open files" for the next connection.
#[tokio::test]
async fn a_backend_started_with_few_descriptors_serves_hundreds_of_connections() {
    let llm = model().await;
    let dir = tempfile::tempdir().unwrap();
    let port = free_port();
    let path = settings(dir.path(), port, llm, "");
    // The limit is checked once raised: a system whose hard limit is 256
    // has nothing to raise it to.
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(r#"ulimit -S -n 256 && exec "$0" --config "$1""#)
        .arg(env!("CARGO_BIN_EXE_llm-agent"))
        .arg(&path)
        .current_dir(dir.path())
        .env_remove("LLM_AGENT_CONFIG")
        .env_remove("APP_LAUNCHER_PID")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let health = format!("http://127.0.0.1:{port}/api/health");
    let deadline = Instant::now() + Duration::from_secs(30);
    while client().get(&health).send().await.is_err() {
        assert!(Instant::now() < deadline, "the backend did not start");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut held = vec![];
    for _ in 0..300 {
        held.push(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap());
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    let checked = tokio::time::timeout(Duration::from_secs(20), async {
        let up = client().get(&health).send().await.map(|r| r.status().as_u16());
        let answer = async {
            let response = client()
                .post(format!("http://127.0.0.1:{port}/api/chat"))
                .json(&json!({"message":"안녕","conversation_id":"many"}))
                .send()
                .await?;
            response.json::<Value>().await
        }
        .await;
        (up.ok(), answer.ok().and_then(|a| a["answer"].as_str().map(str::to_owned)))
    })
    .await;
    drop(held);
    signal(&child, libc::SIGTERM);
    let _ = tokio::time::timeout(Duration::from_secs(20), child.wait()).await;
    assert_eq!(checked.ok(), Some((Some(200), Some("답입니다.".to_owned()))), "the backend was out of service");
}
