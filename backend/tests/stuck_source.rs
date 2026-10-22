//! A source call stuck in the file system, as on a network drive gone
//! silent: here the walker opens the global git config (`$HOME/.gitconfig`,
//! read for core.excludesFile), a FIFO no one writes, and blocks there. In a
//! process of its own, since it points HOME at that file.
#![cfg(unix)]

mod support;

use llm_agent::agent::{self, Events, Question};
use serde_json::json;
use std::time::{Duration, Instant};
use support::*;
use tokio_util::sync::CancellationToken;

/// Opens the FIFO for writing on the way out, a failed assertion too, so the
/// walker's open returns and its thread ends with the runtime (which waits
/// for it). Without a reader left, the open fails at once and does nothing.
struct Unblock(std::path::PathBuf);
impl Drop for Unblock {
    fn drop(&mut self) {
        use std::os::unix::fs::OpenOptionsExt;
        let _ = std::fs::OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open(&self.0);
    }
}

/// Performance, deadlock and panic review, 2026-10-23: the batch waited for
/// its source thread with no end, so a stopped question stayed running for
/// as long as a read did not return.
#[tokio::test]
async fn a_stopped_question_does_not_wait_for_a_stuck_source_call() {
    let home = tempfile::tempdir().unwrap();
    let gitconfig = home.path().join(".gitconfig");
    assert!(std::process::Command::new("mkfifo").arg(&gitconfig).status().unwrap().success());
    let _unblock = Unblock(gitconfig.clone());
    // SAFETY: the only test of this process, set before anything reads them.
    unsafe {
        std::env::set_var("HOME", home.path());
        std::env::remove_var("GIT_CONFIG_GLOBAL");
    }
    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir(project.path().join(".git")).unwrap();
    std::fs::write(project.path().join("a.rs"), "fn a() {}\n").unwrap();
    let mut config = llm_agent::config::Config::default();
    config.mariadb.port = 9;
    config.llm.base_url = "http://127.0.0.1:9/v1".into();
    config.llm.model = "gpt-4o".into();
    config.projects.push(llm_agent::config::Project { name: "app".into(), root: project.path().into(), ..Default::default() });
    let llm = Scripted::new(vec![calls(vec![call("s", "source_search", json!({"query":"fn a"}))]), text("답")]);
    let (app, _dir) = app(config, llm);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let stop = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        stop.cancel();
    });
    let started = Instant::now();
    let question = Question { conversation_id: "stuck".into(), message: "a 함수는?".into(), history: vec![] };
    let result = tokio::time::timeout(Duration::from_secs(20), agent::answer(&app, question, Events::new(Some(tx)), cancel))
        .await
        .expect("the stopped question ended");
    assert_eq!(result.err().map(|e| e.to_string()).as_deref(), Some("cancelled"));
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    let mut events = vec![];
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    assert!(ev(&events, "tool_done").iter().any(|e| e["status"] == "cancelled"), "{events:?}");
}
