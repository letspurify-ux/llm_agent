//! An MCP server set to go direct (`disable_proxy`) under a proxy in the
//! backend's environment. Its own test binary: the proxy variables are the
//! whole process's, and would send the other MCP tests' HTTP through it.

mod support;

use llm_agent::{
    config::{Config, McpServer},
    mcp::{McpHub, probe},
};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use support::skip;
use tokio_util::sync::CancellationToken;

const MODEL: &str = "gpt-4o";

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_mcp_server.mjs")
}

/// A proxy that keeps each request's first line and closes the connection.
fn proxy() -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(vec![]));
    let lines = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut line = String::new();
            let _ = BufReader::new(&stream).read_line(&mut line);
            lines.lock().unwrap().push(line.trim().to_owned());
        }
    });
    (address, seen)
}

struct HttpServer(Child);
impl Drop for HttpServer {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn env_of(hub: &McpHub, config: &Config, server: &str, name: &str) -> String {
    let started = Instant::now();
    while hub.server_status(server, MODEL).unwrap()["state"] != "ready" {
        assert!(started.elapsed() < Duration::from_secs(10), "{server} is not ready");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let tool = hub.snapshot(config).find(&format!("{server}__env")).unwrap();
    let result: Value = tool.call(json!({"name": name}), &CancellationToken::new()).await.unwrap();
    result["text"].as_str().unwrap().to_owned()
}

#[test]
fn a_server_set_to_go_direct_passes_by_the_environments_proxy() {
    if Command::new("node").arg("--version").output().is_err() {
        assert!(std::env::var("REQUIRE_NODE").as_deref() != Ok("1"), "node is required (REQUIRE_NODE=1)");
        return skip("node is not installed");
    }
    let (address, seen) = proxy();
    // SAFETY: set before the runtime starts, and this binary's only test.
    unsafe {
        for name in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] {
            std::env::set_var(name, &address);
        }
        std::env::remove_var("NO_PROXY");
        std::env::remove_var("no_proxy");
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap().block_on(async {
        let mut child = Command::new("node").arg(fixture()).args(["--http", "--port", "0"]).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let _remote = HttpServer(child);
        let url = format!("http://127.0.0.1:{}/mcp", line.trim().strip_prefix("listening ").unwrap());

        // HTTP: through the proxy as the environment says, unless set to go
        // direct.
        let mut http = McpServer { name: "web".into(), url: url.clone(), tools: vec!["*".into()], ..Default::default() };
        let refused = probe(&http, MODEL).await.unwrap();
        assert_eq!(refused["ok"], false, "the proxy closes every connection: {refused:#}");
        let through = seen.lock().unwrap().clone();
        assert!(through.iter().any(|l| l.starts_with("POST ") && l.contains(&url)), "{through:?}");
        http.disable_proxy = true;
        let checked = probe(&http, MODEL).await.unwrap();
        assert_eq!(checked["ok"], true, "{checked:#}");
        assert_eq!(seen.lock().unwrap().len(), through.len(), "nothing more went through the proxy");

        // A command: without the proxy variables and with NO_PROXY=*, its
        // own `env` still winning.
        let fake = |name: &str, disable_proxy: bool, env: &[(&str, &str)]| McpServer {
            name: name.into(),
            command: "node".into(),
            args: vec![fixture().display().to_string()],
            tools: vec!["env".into()],
            disable_proxy,
            env: env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
            ..Default::default()
        };
        let mut config = Config::default();
        config.llm.model = MODEL.into();
        config.mcp_servers = vec![
            fake("via", false, &[]),
            fake("direct", true, &[]),
            fake("own", true, &[("HTTPS_PROXY", "http://own:3128"), ("NO_PROXY", "internal")]),
        ];
        let hub = McpHub::default();
        hub.apply(&config.mcp_servers);
        assert_eq!(env_of(&hub, &config, "via", "HTTPS_PROXY").await, address);
        assert_eq!(env_of(&hub, &config, "via", "NO_PROXY").await, "<unset>");
        for name in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] {
            assert_eq!(env_of(&hub, &config, "direct", name).await, "<unset>", "{name}");
        }
        assert_eq!(env_of(&hub, &config, "direct", "NO_PROXY").await, "*");
        assert_eq!(env_of(&hub, &config, "direct", "no_proxy").await, "*");
        assert_eq!(env_of(&hub, &config, "own", "HTTPS_PROXY").await, "http://own:3128");
        assert_eq!(env_of(&hub, &config, "own", "NO_PROXY").await, "internal");
        assert_eq!(env_of(&hub, &config, "own", "no_proxy").await, "<unset>");

        // Switching it reconnects the server, as any connection setting does.
        config.mcp_servers[0].disable_proxy = true;
        hub.apply(&config.mcp_servers);
        assert_eq!(env_of(&hub, &config, "via", "HTTPS_PROXY").await, "<unset>");
        hub.shutdown().await;
    });
}
