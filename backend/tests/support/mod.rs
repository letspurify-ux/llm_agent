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
