//! Test harness: a throwaway MariaDB database built from sql/schema.sql and
//! sql/seed.sql, a scripted model, and an app wired to both.
//!
//! Database tests run when LLM_AGENT_TEST_MARIADB is set
//! (`user:password@host:port`); without it they pass with a notice. Search
//! tests also need an embedding server (LLM_AGENT_TEST_EMBEDDING, default
//! http://localhost:11434/v1 with qwen3-embedding:0.6b).
#![allow(dead_code)]

use async_trait::async_trait;
use llm_agent::{
    app::App,
    config::{Config, LlmConfig, Secret},
    llm::{Completion, LlmClient, ToolCall},
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    process::Command,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub struct TestDb {
    pub name: String,
    pub user: String,
    pub password: String,
    pub host: String,
    pub port: u16,
}

impl TestDb {
    /// A fresh database with the schema and demo seed, or None when no test
    /// server is configured.
    pub fn create(tag: &str) -> Option<TestDb> {
        let spec = std::env::var("LLM_AGENT_TEST_MARIADB").ok()?;
        let (credentials, address) = spec.rsplit_once('@')?;
        let (user, password) = credentials.split_once(':').unwrap_or((credentials, ""));
        let (host, port) = address.split_once(':').unwrap_or((address, "3306"));
        let db = TestDb {
            name: format!("llm_agent_rs_test_{tag}_{}", std::process::id()),
            user: user.into(),
            password: password.into(),
            host: host.into(),
            port: port.parse().unwrap_or(3306),
        };
        db.sql(&format!(
            "DROP DATABASE IF EXISTS {0}; CREATE DATABASE {0} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;",
            db.name
        ));
        let root = env!("CARGO_MANIFEST_DIR");
        for file in ["sql/schema.sql", "sql/seed.sql"] {
            let text = std::fs::read_to_string(format!("{root}/{file}")).unwrap();
            let text: String = text
                .lines()
                .filter(|l| !l.starts_with("CREATE DATABASE") && !l.starts_with("USE "))
                .collect::<Vec<_>>()
                .join("\n");
            db.sql_in(&text);
        }
        Some(db)
    }

    fn command(&self) -> Command {
        let mut command = Command::new("mariadb");
        command
            .arg(format!("-u{}", self.user))
            .arg(format!("-h{}", self.host))
            .arg(format!("-P{}", self.port))
            .arg("--protocol=TCP")
            .arg("--default-character-set=utf8mb4")
            .env("MYSQL_PWD", &self.password);
        command
    }

    pub fn sql(&self, statements: &str) {
        let out = self.command().arg("-e").arg(statements).output().expect("mariadb client");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    pub fn sql_in(&self, statements: &str) {
        let out = self
            .command()
            .arg(&self.name)
            .arg("-e")
            .arg(statements)
            .output()
            .expect("mariadb client");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// One value from the test database.
    pub fn scalar(&self, query: &str) -> String {
        let out = self
            .command()
            .arg(&self.name)
            .arg("-N")
            .arg("-B")
            .arg("-e")
            .arg(query)
            .output()
            .expect("mariadb client");
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    pub fn config(&self) -> Config {
        let mut config = Config::default();
        config.mariadb.host = self.host.clone();
        config.mariadb.port = self.port;
        config.mariadb.user = self.user.clone();
        config.mariadb.password = (!self.password.is_empty()).then(|| Secret(self.password.clone()));
        config.mariadb.database = self.name.clone();
        config.oracle.mock = true;
        config.llm = LlmConfig {
            base_url: "http://127.0.0.1:9/v1".into(),
            model: "gpt-4o".into(),
            ..LlmConfig::default()
        };
        config.embedding.url = std::env::var("LLM_AGENT_TEST_EMBEDDING").unwrap_or_else(|_| "http://localhost:11434/v1".into());
        config
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let _ = self
            .command()
            .arg("-e")
            .arg(format!("DROP DATABASE IF EXISTS {}", self.name))
            .output();
    }
}

/// Whether the configured embedding server answers.
pub async fn embedding_available(config: &Config) -> bool {
    llm_agent::embedding::embed(&config.embedding, &["확인".to_owned()], &CancellationToken::new())
        .await
        .is_ok()
}

pub fn call(id: &str, name: &str, arguments: Value) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: name.into(),
        arguments: arguments.to_string(),
    }
}

/// A response that calls tools. It reports no usage, as a server without
/// usage reporting does: a fixed count would be a server that counts every
/// request alike however long, which is a server cutting requests.
pub fn calls(calls: Vec<ToolCall>) -> Completion {
    Completion {
        calls,
        attempts: 1,
        ..Default::default()
    }
}

/// An answer (no usage, as `calls`).
pub fn text(text: &str) -> Completion {
    Completion {
        text: text.into(),
        attempts: 1,
        ..Default::default()
    }
}

/// A model that replies from a script and records every request.
#[derive(Default)]
pub struct Scripted {
    pub replies: Mutex<VecDeque<Completion>>,
    pub requests: Mutex<Vec<Value>>,
    /// Waits for cancellation instead of answering.
    pub hang: std::sync::atomic::AtomicBool,
}

impl Scripted {
    pub fn new(replies: Vec<Completion>) -> Arc<Self> {
        Arc::new(Self {
            replies: Mutex::new(replies.into()),
            ..Default::default()
        })
    }
    pub fn push(&self, replies: Vec<Completion>) {
        self.replies.lock().unwrap().extend(replies);
    }
    pub fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl LlmClient for Scripted {
    async fn complete(&self, request: Value, _config: &LlmConfig, cancel: CancellationToken, delta: mpsc::Sender<String>) -> anyhow::Result<Completion> {
        self.requests.lock().unwrap().push(request);
        if self.hang.load(std::sync::atomic::Ordering::Relaxed) {
            cancel.cancelled().await;
            anyhow::bail!("cancelled");
        }
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| text("(script exhausted)"));
        if !reply.text.is_empty() {
            for part in reply.text.split_inclusive(' ') {
                let _ = delta.send(part.to_owned()).await;
            }
        }
        Ok(reply)
    }
}

/// An app on a config in a temporary directory.
pub fn app(config: Config, llm: Arc<dyn LlmClient>) -> (Arc<App>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.toml");
    config.save(&path).unwrap();
    (App::new(path, config, llm), dir)
}

/// Messages of a recorded request with the given role.
pub fn messages(request: &Value, role: &str) -> Vec<Value> {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["role"] == role)
        .cloned()
        .collect()
}

/// The parsed content of the tool message answering `call_id`.
pub fn tool_result(request: &Value, call_id: &str) -> Value {
    let message = request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "tool" && m["tool_call_id"] == call_id)
        .unwrap_or_else(|| panic!("no tool result for {call_id}"));
    serde_json::from_str(message["content"].as_str().unwrap()).unwrap()
}

pub fn skip(reason: &str) {
    eprintln!("skipped: {reason}");
}

pub fn ev(events: &[Value], kind: &str) -> Vec<Value> {
    events.iter().filter(|e| e["type"] == kind).cloned().collect()
}

pub fn json_line(value: &Value) -> String {
    json!(value).to_string()
}

/// The shape every request must keep: the context opens with a user
/// message, no reply follows a reply, every tool call has its result right
/// after it, one answer per question, no internal flags.
pub fn request_shape(request: &Value) -> Result<(), String> {
    let messages = request["messages"].as_array().unwrap();
    if messages[0]["role"] != "system" || messages[1]["role"] != "user" || messages.last().unwrap()["role"] != "user" {
        return Err("not system, user …, state".into());
    }
    let mut pending: Vec<&str> = vec![];
    let mut answers = 0;
    let mut previous = "";
    for message in &messages[1..] {
        let role = message["role"].as_str().unwrap();
        if role == "assistant" && previous == "assistant" {
            return Err("a reply after a reply".into());
        }
        if role != "tool" && !pending.is_empty() {
            return Err(format!("no result for {pending:?}"));
        }
        if message.get("partial").is_some() || message.get("restored").is_some() {
            return Err("internal flag".into());
        }
        match role {
            "assistant" => match message["tool_calls"].as_array() {
                Some(calls) if !calls.is_empty() => pending = calls.iter().map(|c| c["id"].as_str().unwrap()).collect(),
                _ => answers += 1,
            },
            "tool" => {
                let id = message["tool_call_id"].as_str().unwrap();
                let at = pending.iter().position(|p| *p == id).ok_or(format!("result without its call {id}"))?;
                pending.remove(at);
            }
            _ => answers = 0,
        }
        if answers > 1 {
            return Err("two answers to one question".into());
        }
        previous = role;
    }
    Ok(())
}

/// What a result in the context goes on in is still held: the archive of a
/// cut result, the bundle a cut history read reads.
pub fn continuations_kept(history: &llm_agent::session::SessionHistory) -> Result<(), String> {
    for bundle in history.bundles.iter().filter(|b| b.active) {
        for message in bundle.messages.iter().filter(|m| m["role"] == "tool") {
            let Ok(result) = serde_json::from_str::<Value>(message["content"].as_str().unwrap_or("")) else {
                continue;
            };
            let mut ids: Vec<u64> = result["archive_id"].as_u64().into_iter().collect();
            if result["next_cursor"]["tool"] == "history" {
                ids.extend(result["next_cursor"]["id"].as_u64());
            }
            if result["data"]["truncated"] == true && result["next_cursor"]["tool"] != "history" && message["tool_call_id"].as_str().is_some() {
                // A cut history read without a continuation the prune can see.
                let call = bundle.messages[0]["tool_calls"].as_array().and_then(|calls| calls.iter().find(|c| c["id"] == message["tool_call_id"]));
                if call.is_some_and(|c| c["function"]["name"] == "history") {
                    return Err(format!("bundle {}: a cut history read names no next_cursor", bundle.id));
                }
            }
            for id in ids {
                if history.read(id).is_err() {
                    return Err(format!("bundle {}: {id}, which a result in the context goes on in, was dropped", bundle.id));
                }
            }
            let call = bundle.messages[0]["tool_calls"].as_array().and_then(|calls| calls.iter().find(|c| c["id"] == message["tool_call_id"]));
            if call.is_some_and(|c| c["function"]["name"] != "history") {
                archive_read_goes_on_past_what_was_shown(history, &result).map_err(|e| format!("bundle {}: {e}", bundle.id))?;
            }
        }
    }
    Ok(())
}

/// A cut result's archive is read on right past what the result shows of
/// it: the item after the last one it shows, the character after the start
/// of its text it shows (a preview of it is read from the start).
fn archive_read_goes_on_past_what_was_shown(history: &llm_agent::session::SessionHistory, result: &Value) -> Result<(), String> {
    let cursor = &result["next_cursor"];
    let (Some(id), Some(offset)) = (cursor["id"].as_u64().filter(|_| cursor["tool"] == "history"), cursor["offset"].as_u64()) else {
        return Ok(());
    };
    let Some(archive) = history.read(id).ok().filter(|b| b.messages[0]["role"] == "tool_archive") else {
        return Ok(());
    };
    let whole = serde_json::to_string(&llm_agent::context::shown_messages(&archive.messages[..])).unwrap();
    let (passed, rest): (String, String) = (whole.chars().take(offset as usize).collect(), whole.chars().skip(offset as usize).collect());
    let shown = llm_agent::tools::model_result(result);
    let archived = llm_agent::tools::model_result(&archive.messages[0]["result"]);
    for pointer in ["/data/content/text", "/data/text"] {
        if let (Some(text), Some(all)) = (shown.pointer(pointer).and_then(Value::as_str), archived.pointer(pointer).and_then(Value::as_str))
            && !text.is_empty()
            && text.len() < all.len()
        {
            let escaped = serde_json::to_string(text).unwrap();
            return if passed.ends_with(&escaped[..escaped.len() - 1]) {
                Ok(())
            } else {
                Err(format!("archive {id} is read on at {offset}, not past the {} characters of {pointer} shown", text.chars().count()))
            };
        }
    }
    for field in ["paths", "matches", "items", "rows", "hits", "outline", "files", "counts"] {
        if let (Some(items), Some(all)) = (shown["data"][field].as_array(), archived["data"][field].as_array())
            && !items.is_empty()
            && items.len() < all.len()
        {
            let next = serde_json::to_string(&all[items.len()]).unwrap();
            return if rest.starts_with(&format!(",{next}")) {
                Ok(())
            } else {
                Err(format!("archive {id} is read on at {offset}, not at the first of {field} left out ({} of {} shown)", items.len(), all.len()))
            };
        }
    }
    Ok(())
}

/// Bytes this process has allocated, where the platform says.
pub fn heap_in_use() -> Option<usize> {
    #[cfg(target_os = "macos")]
    {
        #[repr(C)]
        #[derive(Default)]
        struct Statistics {
            blocks_in_use: u32,
            size_in_use: usize,
            max_size_in_use: usize,
            size_allocated: usize,
        }
        unsafe extern "C" {
            fn malloc_zone_statistics(zone: *const std::ffi::c_void, stats: *mut Statistics);
        }
        let mut stats = Statistics::default();
        // SAFETY: a null zone sums every zone into `stats`.
        unsafe { malloc_zone_statistics(std::ptr::null(), &mut stats) };
        Some(stats.size_in_use)
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // SAFETY: reads the allocator's counters.
        let info = unsafe { libc::mallinfo2() };
        Some(info.uordblks + info.hblkhd)
    }
    #[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
    {
        None
    }
}
