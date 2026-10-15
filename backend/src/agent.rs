//! One question: the MnemoArc answer loop with native tool calls. Each model
//! response either calls tools (run as one batch and kept with their results
//! as one history bundle) or is the answer. Old bundles leave the context
//! when it grows (`context::evict`); near the request or time limit the
//! model is asked to answer without tools.

use crate::{
    app::App,
    config::{Config, Project},
    context,
    llm::{Completion, ToolCall},
    session::Conversation,
    text::{clip_utf16, js_trim, name_key},
    tools::{self, FileCursor, ToolConfig, ToolRegistry, Workspace, recovery::FailureTracker},
    voc_tools::{self, Clipped, Effect},
};
use anyhow::{Result, bail};
use futures_util::{StreamExt, stream::FuturesUnordered};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

/// Turns of the browser's history used to restore a lost conversation.
pub const MAX_CHAT_TURNS: usize = 6;
pub const MAX_CHAT_LEN: usize = 10_000;
/// Characters (UTF-16) of a question: a pasted log or SQL fits, and its
/// UTF-8 stays within chat_log's TEXT column (3 bytes a unit at most).
pub const MAX_QUESTION_LEN: usize = 20_000;
/// Characters of the question repeated in each request's runtime state; the
/// whole question is in the conversation.
const STATE_QUESTION_LEN: usize = 2_000;
/// Responses that still call tools after tools were withheld.
const WITHHELD_RETRIES: usize = 2;
/// Prefix of the conversation a request without `conversation_id` gets
/// (web.rs). Client ids cannot contain ':', so none is taken for one. Nothing
/// can continue it, so it is dropped when its run ends rather than kept for
/// the idle time, where it would also push real conversations out.
pub const ONE_SHOT_PREFIX: &str = "once:";
/// Seconds kept for the final answer when time runs short.
const FINAL_RESERVE_SECS: u64 = 45;
const PROVIDER_WAITS: [u64; 2] = [5, 15];
const EMPTY_RETRIES: usize = 2;
const LENGTH_CONTINUATIONS: usize = 2;

pub struct Question {
    pub conversation_id: String,
    pub message: String,
    /// The browser's recent turns (role, text), for a conversation the
    /// server no longer holds.
    pub history: Vec<(String, String)>,
}

pub struct Answer {
    pub answer: String,
    /// This question's searches, queries and tool calls, for the trace panel.
    pub trace: Vec<Value>,
    /// Rows of earlier steps the answer refers to.
    pub refs: Vec<Value>,
    /// The chat_log trace.
    pub log: Value,
}

/// A failure whose message the user may see as is.
#[derive(Debug)]
pub struct UserFacing(pub String);
impl std::fmt::Display for UserFacing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for UserFacing {}

/// Events streamed to the browser (NDJSON lines).
#[derive(Clone)]
pub struct Events(Option<UnboundedSender<Value>>);
impl Events {
    pub fn new(sender: Option<UnboundedSender<Value>>) -> Self {
        Self(sender)
    }
    fn send(&self, event: Value) {
        if let Some(sender) = &self.0 {
            let _ = sender.send(event);
        }
    }
}

struct Timing {
    started: Instant,
    llm: Vec<Value>,
    tools: Vec<Value>,
}

/// Answers one question in its conversation.
pub async fn answer(app: &Arc<App>, question: Question, events: Events, cancel: CancellationToken) -> Result<Answer> {
    let config = app.config();
    config
        .llm
        .runnable()
        .map_err(|e| UserFacing(e.to_string()))?;
    let claim = app.sessions.open(
        &question.conversation_id,
        Duration::from_secs(config.agent.session_idle_minutes.saturating_mul(60)),
        config.agent.max_sessions,
        cancel.clone(),
    );
    // Dropped last (after the conversation's lock), on every way out.
    let _release = app.sessions.release_on_drop(
        &question.conversation_id,
        claim.run,
        question.conversation_id.starts_with(ONE_SHOT_PREFIX),
    );
    let mut conversation = tokio::select! {
        guard = claim.conversation.lock() => guard,
        _ = cancel.cancelled() => bail!("cancelled"),
    };
    conversation.last_used = Instant::now();
    if !claim.existed {
        restore(&mut conversation, &question.history);
    }
    run(app, &config, &mut conversation, &question.message, &events, &cancel).await
}

/// A conversation the server lost (restart, expiry) continues from the
/// turns the browser kept.
fn restore(c: &mut Conversation, history: &[(String, String)]) {
    for (role, text) in history.iter().rev().take(MAX_CHAT_TURNS).rev() {
        let text = clip_utf16(js_trim(text), MAX_CHAT_LEN);
        if text.is_empty() || !matches!(role.as_str(), "user" | "assistant") {
            continue;
        }
        c.history
            .push(vec![json!({"role":role,"content":text,"restored":true})], true);
    }
}

async fn run(
    app: &Arc<App>,
    config: &Arc<Config>,
    c: &mut Conversation,
    message: &str,
    events: &Events,
    cancel: &CancellationToken,
) -> Result<Answer> {
    let mut timing = Timing {
        started: Instant::now(),
        llm: vec![],
        tools: vec![],
    };
    let question_bundle = c
        .history
        .push(vec![json!({"role":"user","content":message})], true);
    let model = config.llm.model.clone();
    let deadline = timing.started + Duration::from_secs(config.agent.run_seconds);
    let mut trace: Vec<Value> = vec![];
    let mut tracker = FailureTracker::default();
    let mut rounds = 0usize;
    let mut withheld = 0usize;
    let mut empty = 0usize;
    let mut outages = 0usize;
    let mut partial: Vec<String> = vec![];
    let mut notice: Option<String> = None;
    let mut event_id = 0u64;
    let answer_text = loop {
        if cancel.is_cancelled() {
            bail!("cancelled");
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        // A question runs until it answers; near its time the model is asked
        // to answer with what it has.
        let final_round = remaining.as_secs() <= FINAL_RESERVE_SECS;
        if remaining.is_zero() {
            bail!(UserFacing("답변 시간이 다 되어 마무리하지 못했습니다. 질문을 좁혀 다시 시도해주세요.".into()));
        }
        let offered = offered_tools(config, c, final_round);
        let state = runtime_state(config, message, remaining, final_round, &offered, partial.is_empty(), notice.take());
        let mut definitions = ToolRegistry::definitions(&offered.iter().map(String::as_str).collect());
        tools::require_project(&mut definitions, &config.projects);
        // What eviction cannot remove: the frame and the question.
        let kept = context::count(&context::request(&Default::default(), &state, &model, definitions.clone()), &model)
            + context::bundle_tokens(&c.history, question_bundle, &model)
            + 512;
        let mut request = context::request(&c.history, &state, &model, definitions.clone());
        let mut estimate = context::count(&request, &model);
        let evicted = context::evict(c, config, estimate, &[question_bundle]);
        if !evicted.is_empty() {
            request = context::request(&c.history, &state, &model, definitions);
            estimate = context::count(&request, &model);
            eprintln!("[context] evicted {} old bundles; request now ~{estimate} tokens", evicted.len());
        }
        let calibrated = (estimate as f64 * context::token_ratio(c, &model)).ceil() as usize;
        if calibrated + config.llm.output_tokens + 512 > config.llm.context_tokens {
            bail!(UserFacing("대화가 너무 길어 이어서 답할 수 없습니다. 새 대화로 다시 질문해주세요.".into()));
        }
        rounds += 1;
        let (delta_tx, mut delta_rx) = tokio::sync::mpsc::channel::<String>(64);
        let relay_events = events.clone();
        let relay = tokio::spawn(async move {
            let mut emitted = false;
            while let Some(text) = delta_rx.recv().await {
                if !text.is_empty() {
                    emitted = true;
                    relay_events.send(json!({"type":"answer_delta","text":text}));
                }
            }
            emitted
        });
        let started = Instant::now();
        let mut llm_config = config.llm.clone();
        llm_config.retry_timeouts = true;
        let response = tokio::select! {
            _ = cancel.cancelled() => Err(anyhow::anyhow!("cancelled")),
            result = tokio::time::timeout(remaining, app.llm.complete(request, &llm_config, cancel.clone(), delta_tx)) => match result {
                Ok(result) => result,
                Err(_) => Err(anyhow::anyhow!("run_timeout")),
            },
        };
        let emitted = relay.await.unwrap_or(false);
        let ms = started.elapsed().as_millis() as u64;
        let completion: Completion = match response {
            Ok(completion) => completion,
            Err(error) => {
                timing.llm.push(json!({"ms":ms,"error":true}));
                if emitted {
                    events.send(json!({"type":"answer_reset"}));
                }
                if error.to_string() == "cancelled" {
                    bail!("cancelled");
                }
                let unavailable = error
                    .downcast_ref::<crate::llm::CompletionError>()
                    .is_some_and(|e| e.provider_unavailable());
                if unavailable && outages < PROVIDER_WAITS.len() {
                    let wait = Duration::from_secs(PROVIDER_WAITS[outages]);
                    if Instant::now() + wait + Duration::from_secs(FINAL_RESERVE_SECS) < deadline {
                        outages += 1;
                        rounds -= 1;
                        eprintln!("[llm] provider unavailable; retrying in {}s: {error}", wait.as_secs());
                        tokio::select! {
                            _ = cancel.cancelled() => bail!("cancelled"),
                            _ = tokio::time::sleep(wait) => {}
                        }
                        continue;
                    }
                }
                return Err(error);
            }
        };
        outages = 0;
        let usage = completion.usage.clone();
        if let Some(usage) = &usage {
            context::record_usage(c, &model, estimate, usage.input);
            eprintln!(
                "[llm] usage prompt={} completion={} cached={} ms={ms}",
                usage.input,
                usage.output,
                usage.cached.unwrap_or(0)
            );
        }
        timing.llm.push(json!({"ms":ms,"prompt":usage.as_ref().map(|u| u.input),"completion":usage.as_ref().map(|u| u.output),"cached":usage.as_ref().and_then(|u| u.cached),"estimate":estimate}));
        if emitted && (!completion.calls.is_empty() || completion.length_limited) {
            events.send(json!({"type":"answer_reset"}));
        }
        if completion.length_limited {
            if completion.discarded_tool_calls {
                notice = Some("이전 응답이 출력 한도에 걸려 그 도구 호출은 하나도 실행되지 않았다. 필요한 호출을 더 짧은 인수로 다시 하라.".into());
                continue;
            }
            if !completion.text.trim().is_empty() && partial.len() < LENGTH_CONTINUATIONS {
                partial.push(completion.text.clone());
                c.history.push(
                    vec![json!({"role":"assistant","content":completion.text,"partial":true})],
                    true,
                );
                continue;
            }
            if !completion.text.trim().is_empty() {
                partial.push(completion.text.clone());
                break partial.concat();
            }
        }
        if completion.calls.is_empty() {
            let text = completion.text.trim();
            if text.is_empty() {
                empty += 1;
                if empty > EMPTY_RETRIES {
                    if !partial.is_empty() {
                        break partial.concat();
                    }
                    bail!(UserFacing("모델이 빈 응답을 반복해 답변을 만들지 못했습니다. 잠시 후 다시 시도해주세요.".into()));
                }
                notice = Some("이전 응답이 비어 있었다(글도 도구 호출도 없었다). 도구를 부르거나 답변을 써라.".into());
                continue;
            }
            partial.push(completion.text.clone());
            break partial.concat();
        }
        empty = 0;
        if final_round {
            // Tools were withheld; a provider that still sends calls gets
            // one more request.
            notice = Some("도구를 더 쓸 수 없다. 지금까지 확보한 근거로 최종 답변만 써라.".into());
            withheld += 1;
            if withheld > WITHHELD_RETRIES {
                bail!(UserFacing("모델이 답변 대신 도구 호출을 반복해 답변을 마무리하지 못했습니다.".into()));
            }
            continue;
        }
        // What this response's tool results may fill, at the token ratio its
        // own usage has just updated: the next request is checked with it.
        let room = ((config.input_budget() as f64 / context::token_ratio(c, &model)) as usize).saturating_sub(kept);
        let tool_started = Instant::now();
        let messages = execute_batch(
            app,
            config,
            c,
            &completion,
            &offered,
            events,
            cancel,
            &mut tracker,
            &mut trace,
            &mut event_id,
            room,
        )
        .await;
        timing.tools.push(json!({"ms":tool_started.elapsed().as_millis() as u64,"calls":completion.calls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>()}));
        if cancel.is_cancelled() {
            bail!("cancelled");
        }
        c.history.push(messages, true);
    };
    // The answer is kept in history as written (table and chart references,
    // not filled rows): the context stays small and refers to steps.
    for _ in 0..partial.len().saturating_sub(1) {
        if let Some(last) = c.history.bundles.back()
            && last.messages.first().is_some_and(|m| m["partial"] == true)
        {
            c.history.bundles.pop_back();
        }
    }
    c.history
        .push(vec![json!({"role":"assistant","content":answer_text})], true);
    c.history.prune(config.agent.history_bytes);
    let refs = references(&answer_text, c, &trace);
    let total = timing.started.elapsed().as_millis() as u64;
    eprintln!(
        "[agent] timing total={total}ms rounds={rounds} llm={} tools={}",
        json!(timing.llm.iter().map(|l| l["ms"].clone()).collect::<Vec<_>>()),
        json!(timing.tools.iter().map(|t| t["ms"].clone()).collect::<Vec<_>>())
    );
    let log = json!({
        "v":5,"outcome":"answered","conversation_id":c.id,"rounds":rounds,
        "search":search_summary(&trace),
        "timing":{"total":total,"llm":timing.llm,"tools":timing.tools},
        "steps":trace.iter().map(log_step).collect::<Vec<_>>()
    });
    Ok(Answer {
        answer: answer_text,
        trace,
        refs,
        log,
    })
}

/// Tools offered this round: the knowledge and query tools always, the
/// source tools when projects exist, the history tool once something left
/// the context. None in the final round.
fn offered_tools(config: &Config, c: &Conversation, final_round: bool) -> Vec<String> {
    if final_round {
        return vec![];
    }
    let mut names: Vec<String> = voc_tools::specs().iter().map(|s| s.name.to_owned()).collect();
    if !config.projects.is_empty() {
        names.extend(
            ToolRegistry::source_specs()
                .iter()
                .filter(|s| s.source)
                .map(|s| s.name.to_owned()),
        );
    }
    if c.history.bundles.iter().any(|b| !b.active) {
        names.push("history".into());
    }
    names
}

fn weekday(n: u32) -> &'static str {
    ["월", "화", "수", "목", "금", "토", "일"][n as usize % 7]
}

#[allow(clippy::too_many_arguments)]
fn runtime_state(
    config: &Config,
    message: &str,
    remaining: Duration,
    final_round: bool,
    offered: &[String],
    first_part: bool,
    notice: Option<String>,
) -> Value {
    use chrono::Datelike;
    let now = chrono::Utc::now() + chrono::Duration::hours(9);
    let instruction = if final_round {
        "도구를 더 쓸 수 없다. 지금까지 확보한 근거로 최종 답변을 써라. 확인하지 못한 부분은 그렇다고 밝혀라."
    } else if !first_part {
        "이전 응답이 출력 한도에서 끊겼다. 끊긴 곳에서 바로 이어 써라. 앞부분을 반복하거나 머리말을 붙이지 말고, 이미 연 코드블록을 다시 열지 마라."
    } else {
        "질문에 필요한 근거를 도구로 확보하고, 충분하면 도구 없이 최종 답변을 써라."
    };
    let mut guidance = json!({
        "instruction":instruction,
        "remaining_seconds":remaining.as_secs(),
    });
    if let Some(notice) = notice {
        guidance["notice"] = json!(notice);
    }
    let mut state = json!({
        "run_guidance":guidance,
        "now":format!("{} ({}) KST", now.format("%Y-%m-%d %H:%M"), weekday(now.weekday().num_days_from_monday())),
        "current_question":crate::text::clip_marked(message, STATE_QUESTION_LEN),
    });
    if !config.embedding.enabled() {
        state["search"] = json!("unavailable: 임베딩이 설정되지 않아 의미 검색을 쓸 수 없다. 정확한 쿼리 이름 조회만 된다.");
    }
    if !config.projects.is_empty() && offered.iter().any(|t| t == "file_read") {
        state["projects"] = json!(config
            .projects
            .iter()
            .map(|p| json!({"name":p.name,"description":p.description,"docs":p.docs}))
            .collect::<Vec<_>>());
    }
    state
}

/// One call, ready to run.
enum Prepared {
    Voc { args: Value },
    Source { args: Value, project: Project },
    /// Refused before running (its result is the refusal).
    Done(Value),
}

/// The project of a source call: the project of the file cursor it
/// continues, the project it names, the only configured project, or the one
/// project its path resolves in. The note, when there is one, tells the
/// model which project was used instead of what it sent.
fn resolve_project(
    config: &Config,
    name: &str,
    args: &Value,
    cursors: &BTreeMap<String, FileCursor>,
) -> std::result::Result<(Project, Option<String>), String> {
    if name == "history" {
        let project = config.projects.first().cloned().unwrap_or_else(|| Project {
            name: "-".into(),
            root: std::env::temp_dir(),
            ..Default::default()
        });
        return Ok((project, None));
    }
    let names = || config.projects.iter().map(|p| p.name.clone()).collect::<Vec<_>>().join(", ");
    let find = |wanted: &str| {
        config
            .projects
            .iter()
            .find(|p| name_key(&p.name) == name_key(wanted))
            .cloned()
            .ok_or_else(|| format!("project_not_found: no project is named {wanted:?}; configured projects: {}", names()))
    };
    let sent = args["project"].as_str().map(js_trim).filter(|s| !s.is_empty());
    // A cursor reads the file of the project it was issued in, whatever
    // project the call names.
    let cursor = (name == "file_read")
        .then(|| args["cursor"].as_str().and_then(|id| cursors.get(id)))
        .flatten();
    if let Some(cursor) = cursor {
        let project = find(&cursor.project)?;
        let note = sent
            .filter(|sent| name_key(sent) != name_key(&project.name))
            .map(|sent| format!("project {sent:?} was replaced by {}, the project of the cursor", project.name));
        return Ok((project, note));
    }
    if let Some(sent) = sent {
        return find(sent).map(|project| (project, None));
    }
    if config.projects.len() == 1 {
        return Ok((config.projects[0].clone(), None));
    }
    // An omitted project is taken from a path that resolves in exactly one
    // project: refusing it would cost a model request to repeat the call.
    let Some(path) = args["path"].as_str().map(js_trim).filter(|p| !p.is_empty()) else {
        return Err(format!("project_required: name the project (one of: {})", names()));
    };
    let found: Vec<&Project> = config
        .projects
        .iter()
        .filter(|p| tools::path_in_project(p, path))
        .collect();
    match found.as_slice() {
        [only] => Ok((
            (*only).clone(),
            Some(format!("project was omitted; {} was used, the only project where {path:?} exists", only.name)),
        )),
        [] => Err(format!(
            "project_required: name the project (one of: {}); {path:?} was not found in any of them",
            names()
        )),
        several => Err(format!(
            "project_required: {path:?} exists in {}; name the project",
            several.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_batch(
    app: &Arc<App>,
    config: &Arc<Config>,
    c: &mut Conversation,
    completion: &Completion,
    offered: &[String],
    events: &Events,
    cancel: &CancellationToken,
    tracker: &mut FailureTracker,
    trace: &mut Vec<Value>,
    event_id: &mut u64,
    room: usize,
) -> Vec<Value> {
    let calls = &completion.calls;
    // Every result gets the whole result budget, however many calls the
    // response made; `fit_batch` keeps their sum within `room`.
    let share = config.result_budget();
    let mut prepared: Vec<Prepared> = Vec::with_capacity(calls.len());
    let mut ids: Vec<u64> = vec![];
    let mut batch_runs = BTreeSet::new();
    let root = |p: &Project| p.root.canonicalize().unwrap_or_else(|_| p.root.clone());
    let mut roots: BTreeMap<usize, String> = BTreeMap::new();
    for (index, call) in calls.iter().enumerate() {
        *event_id += 1;
        ids.push(*event_id);
        let raw = if call.arguments.trim().is_empty() { "{}" } else { call.arguments.as_str() };
        let parsed: std::result::Result<Value, String> = serde_json::from_str(raw).map_err(|e| {
            format!("invalid_tool_arguments: {e}; send one complete JSON object; nothing was executed")
        });
        let prepared_call = (|| -> std::result::Result<Prepared, String> {
            if !offered.iter().any(|o| *o == call.name) {
                let known = ToolRegistry::specs().iter().any(|s| s.name == call.name);
                return Err(if known {
                    format!("unsupported_tool: {} is not offered now; use the offered tools", call.name)
                } else {
                    format!("unsupported_tool: {} does not exist", call.name)
                });
            }
            let mut args = parsed.clone()?;
            let adjusted = tools::normalize_arguments(&call.name, &mut args);
            ToolRegistry::validate(&call.name, &args).map_err(|e| format!("{e:#}"))?;
            if !adjusted.is_empty() {
                args["__adjusted"] = json!(adjusted);
            }
            if call.name == "query_run" {
                let signature = voc_tools::run_signature(
                    args["query_name"].as_str().unwrap_or_default(),
                    args["target_db"].as_str(),
                    &voc_tools::clean_params(&args),
                );
                if !batch_runs.insert(signature) {
                    return Err("repeated_call: 이 응답 안에서 같은 쿼리를 같은 값으로 두 번 실행하려 했다. 하나만 실행된다".into());
                }
            }
            if ToolRegistry::source_specs().iter().any(|s| s.name == call.name) {
                let (project, note) = resolve_project(config, &call.name, &args, &c.file_cursors)?;
                if let Some(note) = note {
                    let mut notes = args["__adjusted"].as_array().cloned().unwrap_or_default();
                    notes.push(json!(note));
                    args["__adjusted"] = json!(notes);
                }
                if call.name != "history" {
                    roots.insert(index, root(&project).display().to_string());
                }
                Ok(Prepared::Source { args, project })
            } else {
                Ok(Prepared::Voc { args })
            }
        })();
        prepared.push(match prepared_call {
            Ok(p) => p,
            Err(message) => Prepared::Done(tools::envelope(Err(anyhow::anyhow!(message)))),
        });
    }
    // Start events, in call order.
    for (index, call) in calls.iter().enumerate() {
        let id = ids[index];
        let args = match &prepared[index] {
            Prepared::Voc { args } | Prepared::Source { args, .. } => args.clone(),
            Prepared::Done(_) => serde_json::from_str(&call.arguments).unwrap_or(Value::Null),
        };
        match call.name.as_str() {
            "search" => events.send(json!({"type":"search","id":id,"text":args["query"],"targets":search_targets(&args)})),
            "query_run" => {
                let mut event = json!({"type":"run_query","id":id,"query_name":args["query_name"],"params":voc_tools::clean_params(&args)});
                if let Some(db) = args["target_db"].as_str() {
                    event["targetDb"] = json!(db);
                }
                events.send(event);
            }
            _ => {
                let root = roots.get(&index).map(std::path::PathBuf::from).unwrap_or_default();
                events.send(json!({"type":"tool","id":id,"name":call.name,"summary":tools::call_summary(&root, &call.name, &call.arguments)}));
            }
        }
    }
    let mut results: Vec<Option<Value>> = vec![None; calls.len()];
    let mut runs: Vec<Option<voc_tools::Run>> = (0..calls.len()).map(|_| None).collect();
    // Source calls run on a blocking thread with the conversation's cursors
    // and history; knowledge and query calls run concurrently meanwhile.
    let source_calls: Vec<(usize, ToolCall, Value, Project)> = prepared
        .iter()
        .enumerate()
        .filter_map(|(i, p)| match p {
            Prepared::Source { args, project } => Some((i, calls[i].clone(), args.clone(), project.clone())),
            _ => None,
        })
        .collect();
    let tool_config = ToolConfig {
        model: config.llm.model.clone(),
        result_tokens: config.result_budget(),
        tool_timeout_secs: config.agent.tool_timeout_secs,
    };
    // Values shown cut short so far, before the history moves to the
    // source-tool thread.
    let clipped = {
        let mut clipped = Clipped::from_results(&c.results);
        for text in c.history_texts() {
            clipped.learn_text(&text);
        }
        clipped
    };
    // Restored if the source thread dies (a panic past the tool's own guard):
    // the copies it holds die with it, and the conversation would go on with
    // an empty history. Bundles share their messages, so this copy is cheap.
    let backup = (c.file_cursors.clone(), c.list_cursor_scopes.clone(), c.history.clone());
    let mut cursors = std::mem::take(&mut c.file_cursors);
    let mut scopes = std::mem::take(&mut c.list_cursor_scopes);
    let mut history = std::mem::take(&mut c.history);
    let source_events = events.clone();
    let source_cancel = cancel.clone();
    let source_ids = ids.clone();
    let source_task = tokio::task::spawn_blocking(move || {
        let mut outputs = vec![];
        for (index, call, args, project) in source_calls {
            let started = Instant::now();
            let root_text = project.root.canonicalize().unwrap_or_else(|_| project.root.clone());
            let mut workspace = Workspace {
                project,
                config: tool_config.clone(),
                file_cursors: std::mem::take(&mut cursors),
                list_cursor_scopes: std::mem::take(&mut scopes),
                history: std::mem::take(&mut history),
            };
            let mut clean = args.clone();
            let adjusted = clean.as_object_mut().and_then(|o| {
                o.remove("project");
                o.remove("__adjusted")
            });
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                tools::execute(&mut workspace, &call.name, clean.clone(), &source_cancel)
            }))
            .unwrap_or_else(|_| Err(anyhow::anyhow!("tool_worker_panic: the tool stopped unexpectedly")));
            let mut result = tools::envelope(outcome);
            if let Some(adjusted) = adjusted
                && result["data"].is_object()
            {
                result["data"]["adjusted_arguments"] = adjusted;
            }
            let mut result = tools::limit_result(&mut workspace, &call, &clean, result, share);
            if call.name != "history" {
                result["root"] = json!(root_text.display().to_string());
            }
            source_events.send(json!({"type":"tool_done","id":source_ids[index],"name":call.name,"status":result["status"],"ms":started.elapsed().as_millis() as u64}));
            cursors = workspace.file_cursors;
            scopes = workspace.list_cursor_scopes;
            history = workspace.history;
            outputs.push((index, result));
        }
        (outputs, cursors, scopes, history)
    });
    {
        let cx = voc_tools::Context {
            app,
            config,
            cancel,
            results: &c.results,
            executed: &c.executed,
            clipped: &clipped,
            result_tokens: share,
        };
        let mut pending: FuturesUnordered<_> = prepared
            .iter()
            .enumerate()
            .filter_map(|(i, p)| match p {
                Prepared::Voc { args } => {
                    let name = calls[i].name.clone();
                    let cx = &cx;
                    Some(async move {
                        let started = Instant::now();
                        let mut clean = args.clone();
                        if let Some(o) = clean.as_object_mut() {
                            o.remove("__adjusted");
                        }
                        let run = voc_tools::run(cx, &name, &clean).await;
                        (i, run, started.elapsed().as_millis() as u64)
                    })
                }
                _ => None,
            })
            .collect();
        while let Some((index, run, ms)) = pending.next().await {
            let id = ids[index];
            match calls[index].name.as_str() {
                "search" => {
                    let (hits, failed) = run.hits.clone().unwrap_or((json!({}), vec![]));
                    let args = match &prepared[index] {
                        Prepared::Voc { args } => args.clone(),
                        _ => Value::Null,
                    };
                    let mut event = json!({"type":"search_done","id":id,"text":args["query"],"targets":search_targets(&args),"hits":hits});
                    if !failed.is_empty() {
                        event["failed"] = json!(failed);
                    }
                    events.send(event);
                }
                "query_run" => {
                    let args = match &prepared[index] {
                        Prepared::Voc { args } => args.clone(),
                        _ => Value::Null,
                    };
                    let mut event = json!({"type":"run_query_done","id":id,"query_name":args["query_name"]});
                    match &run.result {
                        Ok(data) => {
                            event["query_name"] = data["query_name"].clone();
                            event["targetDb"] = data["target_db"].clone();
                            event["rowCount"] = row_count(data["row_count"].as_u64().unwrap_or(0), data["capped"] == true);
                        }
                        Err(_) => {
                            if let Some(db) = args["target_db"].as_str() {
                                event["targetDb"] = json!(db);
                            }
                            event["error"] = json!(run.public_error.clone().unwrap_or_else(|| "조회 중 오류가 발생했습니다.".into()));
                        }
                    }
                    events.send(event);
                }
                name => {
                    events.send(json!({"type":"tool_done","id":id,"name":name,"status":if run.result.is_ok() {"ok"} else {"error"},"ms":ms}));
                }
            }
            runs[index] = Some(run);
        }
    }
    let (outputs, cursors, scopes, history) = match source_task.await {
        Ok(done) => done,
        Err(_) => (vec![], backup.0, backup.1, backup.2),
    };
    c.file_cursors = cursors;
    c.list_cursor_scopes = scopes;
    c.history = history;
    for (index, result) in outputs {
        results[index] = Some(result);
    }
    // Effects and results of knowledge and query calls, in call order.
    let mut workspace = Workspace {
        project: Project::default(),
        config: ToolConfig {
            model: config.llm.model.clone(),
            result_tokens: config.result_budget(),
            tool_timeout_secs: config.agent.tool_timeout_secs,
        },
        file_cursors: BTreeMap::new(),
        list_cursor_scopes: VecDeque::new(),
        history: std::mem::take(&mut c.history),
    };
    for index in 0..calls.len() {
        let call = &calls[index];
        let Some(run) = runs[index].take() else {
            continue;
        };
        let args = match &prepared[index] {
            Prepared::Voc { args } => args.clone(),
            _ => Value::Null,
        };
        let mut data_result = run.result;
        match run.effect {
            Effect::Stored { result, signature } => {
                let rows = result.rows.clone();
                let omitted = result.omitted_column_key.clone();
                let params = result.params.clone();
                let target = result.target_db.clone();
                let name = result.query_name.clone();
                let capped = result.capped;
                let step = c.store_result(result, config.agent.result_store_bytes);
                c.executed.insert(signature, step);
                if let Ok(data) = &mut data_result {
                    // The step first: the model copies it into references.
                    let mut ordered = Map::new();
                    ordered.insert("step".into(), json!(step));
                    if let Some(fields) = data.as_object() {
                        ordered.extend(fields.clone());
                    }
                    *data = Value::Object(ordered);
                }
                let mut step_trace = json!({"step":step,"query_name":name,"params":params,"rowCount":row_count(rows.len() as u64, capped),"rows":*rows});
                if let Some(db) = target {
                    step_trace["targetDb"] = json!(db);
                }
                if capped {
                    step_trace["capped"] = json!(true);
                }
                if let Some(key) = omitted {
                    step_trace["omittedColumnKey"] = json!(key);
                }
                trace.push(step_trace);
            }
            Effect::Failed { .. } => {
                let step = c.reserve_step();
                let mut step_trace = json!({"step":step,"query_name":args["query_name"],"params":voc_tools::clean_params(&args),"error":run.public_error.clone().unwrap_or_else(|| "조회 중 오류가 발생했습니다.".into())});
                if let Some(db) = args["target_db"].as_str() {
                    step_trace["targetDb"] = json!(db);
                }
                trace.push(step_trace);
            }
            Effect::Refused => {}
            Effect::None => {
                if call.name == "query_run" && data_result.is_err() {
                    let mut step_trace = json!({"step":c.reserve_step(),"query_name":args["query_name"],"params":voc_tools::clean_params(&args),"error":run.public_error.clone().unwrap_or_else(|| "조회 중 오류가 발생했습니다.".into())});
                    if let Some(db) = args["target_db"].as_str() {
                        step_trace["targetDb"] = json!(db);
                    }
                    trace.push(step_trace);
                }
            }
        }
        if call.name == "search" {
            let (hits, failed) = run.hits.unwrap_or((json!({}), vec![]));
            let mut step_trace = json!({"search":args["query"],"targets":search_targets(&args),"hits":hits});
            if !failed.is_empty() {
                step_trace["failed"] = json!(failed);
            }
            trace.push(step_trace);
        }
        let mut result = tools::envelope(data_result);
        if let Some(adjusted) = args.get("__adjusted")
            && result["data"].is_object()
        {
            result["data"]["adjusted_arguments"] = adjusted.clone();
        }
        let bounded = tools::bound_result(&mut workspace, call, &args, result, share);
        results[index] = Some(bounded);
    }
    // Every result as the model receives it (repeat warnings and recovery
    // hints attached), fitted beside the response's own calls.
    let mut finals: Vec<Value> = Vec::with_capacity(calls.len());
    for (index, call) in calls.iter().enumerate() {
        let mut result = match &prepared[index] {
            Prepared::Done(result) => result.clone(),
            _ => results[index].take().unwrap_or_else(|| tools::envelope(Err(anyhow::anyhow!("cancelled")))),
        };
        tracker.observe(&call.name, &call.arguments, &mut result);
        tools::recovery::attach(offered, &mut result);
        finals.push(result);
    }
    let assistant = assistant_message(completion);
    let room = room.saturating_sub(context::count(&assistant, &config.llm.model));
    workspace.file_cursors = std::mem::take(&mut c.file_cursors);
    fit_batch(&mut workspace, calls, &prepared, &mut finals, room);
    c.file_cursors = workspace.file_cursors;
    c.history = workspace.history;
    let mut messages = vec![assistant];
    for (index, (call, result)) in calls.iter().zip(finals).enumerate() {
        if !matches!(call.name.as_str(), "search" | "query_run") {
            let root = result["root"].as_str().map(std::path::PathBuf::from).unwrap_or_default();
            trace.push(json!({"tool":call.name,"summary":tools::call_summary(&root, &call.name, &call.arguments),"status":result["status"]}));
            if let Prepared::Done(_) = &prepared[index] {
                events.send(json!({"type":"tool_done","id":ids[index],"name":call.name,"status":result["status"]}));
            }
        } else if let Prepared::Done(_) = &prepared[index] {
            // A refused search or query still closes its progress line.
            let id = ids[index];
            let raw: Value = serde_json::from_str(&call.arguments).unwrap_or(Value::Null);
            if call.name == "search" {
                events.send(json!({"type":"search_done","id":id,"text":raw["query"],"targets":search_targets(&raw),"hits":{},"failed":search_targets(&raw)}));
            } else {
                events.send(json!({"type":"run_query_done","id":id,"query_name":raw["query_name"],"error":"조회를 실행하지 않았습니다."}));
            }
        }
        messages.push(json!({"role":"tool","tool_call_id":call.id,"content":result.to_string()}));
    }
    messages
}

/// Cuts the largest results until this response's tool messages fit `room`:
/// what is left of the context with every older bundle evicted and the
/// response's own calls in place. Each result already fits the result
/// budget, so this only acts on a response with many large results. A cut
/// result is paged or archived in history with its start, as
/// `bound_result` does at the budget.
fn fit_batch(ws: &mut Workspace, calls: &[ToolCall], prepared: &[Prepared], results: &mut [Value], room: usize) {
    let model = ws.config.model.clone();
    // A message token is at least one byte of the message, whose content is
    // escaped once more, plus the estimate's quarter: most responses stop
    // here uncounted.
    let most: usize = calls
        .iter()
        .zip(results.iter())
        .map(|(call, r)| ((tools::model_result(r).to_string().len() * 2 + call.id.len()) * 5).div_ceil(4) + 64)
        .sum();
    if most <= room {
        return;
    }
    let mut sizes: Vec<usize> = calls
        .iter()
        .zip(results.iter())
        .map(|(call, r)| tools::result_tokens(call, r, &model))
        .collect();
    // Refusals are small and kept as they are.
    let mut settled: Vec<bool> = prepared
        .iter()
        .map(|p| !matches!(p, Prepared::Voc { .. } | Prepared::Source { .. }))
        .collect();
    loop {
        let total = sizes.iter().sum::<usize>();
        if total <= room {
            return;
        }
        let Some((index, size)) = sizes
            .iter()
            .copied()
            .enumerate()
            .filter(|(i, size)| !settled[*i] && *size > crate::config::MIN_RESULT_TOKENS)
            .max_by_key(|(_, size)| *size)
        else {
            return;
        };
        let mut args = match &prepared[index] {
            Prepared::Voc { args } => args.clone(),
            Prepared::Source { args, project } => {
                ws.project = project.clone();
                args.clone()
            }
            _ => unreachable!("only run calls are cut"),
        };
        if let Some(fields) = args.as_object_mut() {
            fields.remove("project");
            fields.remove("__adjusted");
        }
        let limit = size.saturating_sub(total - room).max(crate::config::MIN_RESULT_TOKENS);
        let result = std::mem::take(&mut results[index]);
        let cut = tools::bound_result(ws, &calls[index], &args, result, limit);
        let cut_size = tools::result_tokens(&calls[index], &cut, &model);
        settled[index] = cut_size >= size || cut_size <= limit;
        sizes[index] = cut_size;
        results[index] = cut;
    }
}

fn search_targets(args: &Value) -> Value {
    match args["targets"].as_array() {
        Some(t) if !t.is_empty() => json!(t),
        _ => json!(["knowledge", "qa_method", "query"]),
    }
}

fn row_count(rows: u64, capped: bool) -> Value {
    if capped { json!(format!("{rows}+")) } else { json!(rows) }
}

fn assistant_message(completion: &Completion) -> Value {
    let content = if completion.text.trim().is_empty() {
        Value::Null
    } else {
        json!(completion.text)
    };
    json!({"role":"assistant","content":content,"tool_calls":completion.calls.iter().map(|call| json!({"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments}})).collect::<Vec<_>>()})
}

/// Earlier steps the answer's table and chart blocks may refer to, with
/// their rows (this question's steps are in the trace already).
fn references(answer: &str, c: &Conversation, trace: &[Value]) -> Vec<Value> {
    let pattern = regex::Regex::new(r"(?i)(?:step|data|실행|#)\s*:?\s*(?:step\s*)?(\d{1,6})").unwrap();
    let here: BTreeSet<u64> = trace.iter().filter_map(|s| s["step"].as_u64()).collect();
    let mut seen = BTreeSet::new();
    pattern
        .captures_iter(answer)
        .filter_map(|m| m[1].parse::<u64>().ok())
        .filter(|step| !here.contains(step) && seen.insert(*step))
        .filter_map(|step| {
            let stored = c.results.get(&step)?;
            let mut item = json!({"step":step,"rows":*stored.rows});
            if let Some(key) = &stored.omitted_column_key {
                item["omittedColumnKey"] = json!(key);
            }
            Some(item)
        })
        .collect()
}

/// A trace step for chat_log: rows cut to 20 with their total.
/// The chat_log search summary the operations queries read (README "대화
/// 로그"): searches run, the targets asked for, and hits per target summed
/// over the searches — null when no search covered that target, so "looked
/// and found nothing" (0) stays apart from "never looked". `searchFailed`
/// marks a request whose search could not run (embedding server down), so
/// it is not counted as missing knowledge.
fn search_summary(trace: &[Value]) -> Value {
    let searches: Vec<&Value> = trace.iter().filter(|s| s.get("search").is_some()).collect();
    let mut targets: Vec<String> = vec![];
    for target in searches.iter().flat_map(|s| s["targets"].as_array().into_iter().flatten()) {
        if let Some(t) = target.as_str()
            && !targets.iter().any(|seen| seen == t)
        {
            targets.push(t.to_owned());
        }
    }
    let mut summary = json!({"searches":searches.len(),"targets":targets});
    for key in ["knowledge", "qaMethods", "queries"] {
        let counts: Vec<u64> = searches.iter().filter_map(|s| s["hits"][key].as_u64()).collect();
        summary[key] = if counts.is_empty() { Value::Null } else { json!(counts.iter().sum::<u64>()) };
    }
    if searches.iter().any(|s| s.get("failed").is_some()) {
        summary["searchFailed"] = json!(true);
    }
    summary
}

fn log_step(step: &Value) -> Value {
    let mut step = step.clone();
    if let Some(rows) = step["rows"].as_array().cloned() {
        step["totalRows"] = json!(rows.len());
        step["rows"] = json!(rows.into_iter().take(20).collect::<Vec<_>>());
    }
    step
}

impl Conversation {
    /// User and assistant texts in history (for clipped-copy detection).
    pub fn history_texts(&self) -> Vec<String> {
        self.history
            .bundles
            .iter()
            .flat_map(|b| b.messages.iter())
            .filter(|m| matches!(m["role"].as_str(), Some("user" | "assistant")))
            .filter_map(|m| m["content"].as_str().map(str::to_owned))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_project_comes_from_the_cursor_the_name_or_a_path_found_in_one_project() {
        let dir = tempfile::tempdir().unwrap();
        for (project, file) in [("a", "only_a.txt"), ("b", "only_b.txt"), ("a", "README.md"), ("b", "README.md")] {
            std::fs::create_dir_all(dir.path().join(project)).unwrap();
            std::fs::write(dir.path().join(project).join(file), "x\n").unwrap();
        }
        let mut config = Config::default();
        for name in ["a", "b"] {
            config.projects.push(Project {
                name: name.into(),
                root: dir.path().join(name),
                ..Default::default()
            });
        }
        let none = BTreeMap::new();
        let resolve = |name: &str, args: Value, cursors: &BTreeMap<String, FileCursor>| {
            resolve_project(&config, name, &args, cursors).map(|(p, note)| (p.name, note))
        };

        assert_eq!(resolve("file_read", json!({"project":"B","path":"README.md"}), &none).unwrap(), ("b".into(), None));
        let (project, note) = resolve("file_read", json!({"path":"only_b.txt"}), &none).unwrap();
        assert_eq!(project, "b");
        assert!(note.unwrap().contains("only project where"));
        let absolute = dir.path().join("a/only_a.txt").display().to_string();
        assert_eq!(resolve("code_outline", json!({"path":absolute}), &none).unwrap().0, "a");
        assert_eq!(resolve("file_list", json!({"path":"."}), &none).unwrap_err(), "project_required: \".\" exists in a, b; name the project");
        let both = resolve("file_read", json!({"path":"README.md"}), &none).unwrap_err();
        assert!(both.starts_with("project_required") && both.contains("exists in a, b"), "{both}");
        let missing = resolve("file_read", json!({"path":"nowhere.txt"}), &none).unwrap_err();
        assert!(missing.contains("was not found in any of them"), "{missing}");
        let searched = resolve("source_search", json!({"query":"x"}), &none).unwrap_err();
        assert_eq!(searched, "project_required: name the project (one of: a, b)");
        assert!(resolve("file_read", json!({"project":"c"}), &none).unwrap_err().starts_with("project_not_found"));

        let mut cursors = BTreeMap::new();
        cursors.insert(
            "k1".to_owned(),
            FileCursor { project: "b".into(), path: "README.md".into(), hash: String::new(), start_line: 1, max_lines: 10, offset: 0 },
        );
        let (project, note) = resolve("file_read", json!({"project":"a","cursor":"k1"}), &cursors).unwrap();
        assert_eq!(project, "b");
        assert!(note.unwrap().contains("the project of the cursor"));
        assert_eq!(resolve("file_read", json!({"cursor":"k1"}), &cursors).unwrap(), ("b".into(), None));
        // Only a file_read cursor names a project.
        assert!(resolve("file_list", json!({"cursor":"k1"}), &cursors).is_err());

        let mut single = config.clone();
        single.projects.truncate(1);
        let (project, note) = resolve_project(&single, "source_search", &json!({"query":"x"}), &none).unwrap();
        assert_eq!((project.name, note), ("a".into(), None));
    }

    #[test]
    fn an_omitted_project_is_found_without_walking_the_projects() {
        // The check runs on the async runtime: a missing path used to walk
        // every project to suggest similar names, compiling each include and
        // exclude glob again for every file.
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        for name in ["a", "b"] {
            for i in 0..3000 {
                let folder = dir.path().join(name).join(format!("src/m{}", i % 30));
                std::fs::create_dir_all(&folder).unwrap();
                std::fs::write(folder.join(format!("f{i}.rs")), "x\n").unwrap();
            }
            config.projects.push(Project {
                name: name.into(),
                root: dir.path().join(name),
                include: vec!["src/**".into(), "**/*.rs".into(), "**/*.md".into()],
                exclude: vec!["**/gen/**".into(), "**/*.min.js".into()],
                ..Default::default()
            });
        }
        std::fs::write(dir.path().join("a/src/only_a.rs"), "x\n").unwrap();
        let started = Instant::now();
        let (project, _) = resolve_project(&config, "file_read", &json!({"path":"src/only_a.rs"}), &BTreeMap::new()).unwrap();
        assert_eq!(project.name, "a");
        assert!(resolve_project(&config, "file_read", &json!({"path":"src/nowhere.rs"}), &BTreeMap::new()).is_err());
        assert!(started.elapsed() < Duration::from_millis(500), "{:?}", started.elapsed());
    }

    #[test]
    fn search_summary_keeps_never_looked_apart_from_found_nothing() {
        let trace = vec![
            json!({"search":"배치","targets":["knowledge","qa_method"],"hits":{"knowledge":2,"qaMethods":0}}),
            json!({"step":1,"query_name":"q","rows":[]}),
            json!({"search":"배치 상태","targets":["knowledge"],"hits":{"knowledge":3}}),
        ];
        assert_eq!(
            search_summary(&trace),
            json!({"searches":2,"targets":["knowledge","qa_method"],"knowledge":5,"qaMethods":0,"queries":null})
        );
        let failed = vec![json!({"search":"x","targets":["knowledge"],"hits":{"knowledge":null},"failed":["knowledge"]})];
        let summary = search_summary(&failed);
        assert_eq!((summary["knowledge"].clone(), summary["searchFailed"].clone()), (Value::Null, json!(true)));
        assert_eq!(search_summary(&[]), json!({"searches":0,"targets":[],"knowledge":null,"qaMethods":null,"queries":null}));
    }
}
