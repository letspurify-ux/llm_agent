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
    mcp,
    session::Conversation,
    text::{clip_utf16, js_trim, name_key},
    tools::{self, FileCursor, ToolConfig, ToolRegistry, Workspace, recovery::FailureTracker},
    voc_tools::{self, Clipped, Effect},
};
use anyhow::{Result, bail};
use futures_util::{StreamExt, stream::FuturesUnordered};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

/// Turns of the browser's history used to restore a lost conversation (the
/// browser keeps and sends as many: frontend/src/chat-store.js HISTORY_TURNS).
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
/// Seconds kept for the final answer when time runs short. Work started
/// before them stops at them: a request that has not begun its answer, and
/// tool calls.
const FINAL_RESERVE_SECS: u64 = 45;
const TIME_OVER: &str = "답변 시간이 다 되어 마무리하지 못했습니다. 질문을 좁혀 다시 시도해주세요.";
/// A short question the model server refused as longer than its context.
const SERVED_SMALLER: &str = "모델 서버가 받을 수 있는 컨텍스트가 설정보다 작아 답할 수 없습니다. 설정의 컨텍스트와 출력 한도를 모델 서버에 맞춰주세요.";
/// A model server that cuts what does not fit its context instead of
/// refusing it (Ollama truncates to the context it loaded).
const SERVED_CUT: &str = "모델 서버가 요청을 다 받지 못하고 일부를 버린 채 답하고 있어 답할 수 없습니다(서버가 받는 컨텍스트가 설정보다 작습니다). 서버의 컨텍스트를 늘리거나(Ollama는 OLLAMA_CONTEXT_LENGTH) 설정의 컨텍스트를 서버에 맞춰주세요.";
/// Estimated tokens a request grows by, nothing evicted, past which a
/// provider count that did not grow means the provider cut the request.
const CUT_GROWTH: usize = 1_000;
/// What the model is told when the work before the final reserve stopped.
const RESERVE_REACHED: &str = "남은 시간이 모자라 이전 요청을 멈췄다.";
/// The allowed MCP tools' definitions alone fill the context.
const MCP_TOO_LARGE: &str = "허용한 MCP 도구의 정의가 모델 컨텍스트를 너무 많이 차지해 답할 수 없습니다. 관리자 화면 MCP 탭에서 허용 도구를 줄여주세요.";
const TOOLS_STOPPED: &str = "남은 시간이 모자라 이전 응답의 도구 실행 일부를 멈췄다(status cancelled).";
/// What the model is told when it answered that the registered material
/// lacks the subject before searching for it.
const SEARCH_FIRST: &str = "이전 응답은 search 없이 '등록된 지식에 없다'고 답하려 해서 멈췄다. 일반 지식처럼 보여도 등록 자료에 있을 수 있으니 먼저 search로 찾아라. 찾아도 없을 때만 그 문구를 써라.";
/// The start of the general-knowledge line of the system prompt, which a
/// streamed answer is held against before any search.
const UNREGISTERED_LEAD: &str = "등록된 지식에 없는 내용";
/// Characters of an answer's opening line judged for the general-knowledge
/// line: the line with a few words before it. Past them the line is not
/// what opens the answer, and the answer streams on.
const OPENING_CHARS: usize = 60;
/// Characters of blank lines and short headings passed over before the
/// opening line. Past them the general-knowledge line no longer opens the
/// answer: a response of heading or blank lines alone (a model repeating
/// itself) was held whole, and judged from its start again at every token.
const OPENING_SKIP: usize = 4 * OPENING_CHARS;
const PROVIDER_WAITS: [u64; 2] = [5, 15];
const EMPTY_RETRIES: usize = 2;
const EMPTY_REPLIES: &str = "모델이 빈 응답을 반복해 답변을 만들지 못했습니다. 잠시 후 다시 시도해주세요.";
/// Replies cut at the output limit before any text: waiting does not help,
/// a larger limit or less reasoning does.
const OUTPUT_SPENT: &str = "모델이 출력 한도에 닿을 때까지 답변을 시작하지 못했습니다. 추론 모델이면 설정에서 출력 한도를 늘리거나 추론 강도를 낮춰주세요.";
const LENGTH_CONTINUATIONS: usize = 2;
/// Responses in a row whose tool calls could not be used.
const UNUSABLE_RETRIES: usize = 2;
const UNUSABLE_CALLS: &str = "모델이 쓸 수 없는 도구 호출을 거듭해 답변을 마무리하지 못했습니다. 잠시 후 다시 시도하거나 다른 모델을 써 보세요.";
/// Responses in a row whose calls leave no room for their results.
const OVERSIZED_RETRIES: usize = 2;

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
    // A conversation with no question yet continues from the turns the
    // browser kept: a new one, or one whose first run was cancelled while
    // it waited for the conversation.
    if conversation.history.next_id == 0 {
        restore(&mut conversation, &question.history);
    }
    run(app, &config, &mut conversation, &question.message, &events, &cancel).await
}

/// A conversation the server lost (restart, expiry) continues from the
/// turns the browser kept.
fn restore(c: &mut Conversation, history: &[(String, String)]) {
    let turns = history
        .iter()
        .rev()
        .take(MAX_CHAT_TURNS)
        .rev()
        .map(|(role, text)| (role.as_str(), clip_utf16(js_trim(text), MAX_CHAT_LEN)))
        .filter(|(role, text)| !text.is_empty() && matches!(*role, "user" | "assistant"));
    // A reply follows its question: the conversation opens with a question,
    // as eviction keeps it, and a reply whose question was left out (blank)
    // goes too rather than follow another reply.
    let mut previous = "";
    for (role, text) in turns {
        if role == "assistant" && previous != "user" {
            continue;
        }
        previous = role;
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
    let model = config.llm.model.clone();
    // The MCP tools of this question: the same definitions and system prompt
    // in every request, so a provider's prefix cache keeps them. A request
    // defines `MAX_REQUEST_TOOLS` at most, the agent's own tools first.
    let mut mcp = app.mcp.snapshot_within(config, mcp::MAX_REQUEST_TOOLS.saturating_sub(most_agent_tools(config)));
    // Definitions past twice the context cannot fit, whatever the
    // calibration (at least half the local count): said before a request
    // with them all is counted, and before the question joins the
    // conversation — it left before eviction, where only the input budget
    // bounds the bundles in the context, and each question asked meanwhile
    // stayed there for as long as the conversation went on.
    if mcp.tokens(&model) / 2 > config.llm.context_tokens {
        eprintln!("[mcp] the allowed MCP tools' definitions (~{} tokens) are past twice the context", mcp.tokens(&model));
        bail!(UserFacing(MCP_TOO_LARGE.into()));
    }
    let question_bundle = c
        .history
        .push(vec![json!({"role":"user","content":message})], true);
    let mut system = context::system_prompt(&mcp.prompt());
    let deadline = timing.started + Duration::from_secs(config.agent.run_seconds);
    let mut trace: Vec<Value> = vec![];
    let mut tracker = FailureTracker::default();
    // Query runs of this question (query, target, params) → step: an
    // identical repeat is refused for result_read on that step. A later
    // question runs it again: the DB is live, and its user may be asking for
    // the values as they are now.
    let mut executed: HashMap<String, u64> = HashMap::new();
    let mut rounds = 0usize;
    let mut withheld = 0usize;
    let mut empty = 0usize;
    let mut outages = 0usize;
    let mut unusable = 0usize;
    let mut oversized = 0usize;
    let mut partial: Vec<String> = vec![];
    let mut notice: Option<String> = None;
    let mut event_id = 0u64;
    // The last request the provider counted since anything left the context:
    // its estimate as sent and the tokens the provider saw.
    let mut counted_before: Option<(usize, usize)> = None;
    // The general-knowledge line says the registered material was searched
    // and lacks the subject. Opening an answer before this question looked
    // anything up, it is refused once and the model asked to search, unless
    // the previous answer opened with it too (a follow-up on the same
    // unregistered subject).
    let previous_claimed = c
        .history
        .bundles
        .iter()
        .rev()
        .filter(|b| b.id != question_bundle)
        .flat_map(|b| b.messages.iter().rev())
        .find(|m| m["role"] == "assistant" && m["tool_calls"].as_array().is_none_or(|calls| calls.is_empty()))
        .and_then(|m| m["content"].as_str())
        .is_some_and(|text| opening(text, true) == Lead::Claims);
    let mut search_first_asked = false;
    let answer_text = loop {
        if cancel.is_cancelled() {
            bail!("cancelled");
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        // A question runs until it answers; near its time the model is asked
        // to answer with what it has.
        let final_round = remaining.as_secs() <= FINAL_RESERVE_SECS;
        // An answer cut at the output limit is continued without tools.
        let continuing = !partial.is_empty();
        if remaining.is_zero() {
            // A cut answer whose time ran out stands as written.
            if continuing {
                break partial.concat();
            }
            bail!(UserFacing(TIME_OVER.into()));
        }
        let withheld_tools = final_round || continuing;
        let round_notice = notice.take();
        // Withheld tools stay defined, refused with tool_choice "none": the
        // tool definitions open the prompt, and dropping them would leave
        // nothing of the provider's prefix cache for the final answer or a
        // continuation. (The client drops them for a provider that refuses or
        // ignores tool_choice.)
        let frame = |c: &Conversation| {
            let offered = offered_tools(config, c, &mcp);
            let usable: &[String] = if withheld_tools { &[] } else { &offered };
            let state = runtime_state(config, message, remaining, final_round, usable, partial.is_empty(), round_notice.clone());
            let mut definitions = ToolRegistry::definitions(&offered.iter().map(String::as_str).collect());
            tools::require_project(&mut definitions, &config.projects);
            // After require_project: an MCP tool's own `project` field is its own.
            definitions.extend(mcp.definitions());
            (offered, state, definitions)
        };
        let build = |c: &Conversation, state: &Value, definitions: &[Value]| {
            let mut request = context::request_with(&system, &c.history, state, &model, definitions.to_vec());
            if withheld_tools && !definitions.is_empty() {
                request["tool_choice"] = json!("none");
            }
            request
        };
        let (mut offered, mut state, mut definitions) = frame(c);
        let mut request = build(c, &state, &definitions);
        let mut estimate = context::count(&request, &model);
        // A request that withholds the tools cannot read back what leaves:
        // it keeps what fits (the results its answer is written from).
        let evicted = context::evict(c, config, estimate, &[question_bundle], !withheld_tools);
        if !evicted.is_empty() {
            counted_before = None;
            // What left is readable through the history tool from this
            // request on.
            (offered, state, definitions) = frame(c);
            request = build(c, &state, &definitions);
            estimate = context::count(&request, &model);
            eprintln!("[context] evicted {} old bundles; request now ~{estimate} tokens", evicted.len());
        }
        // What eviction cannot remove: the frame and the question.
        let alone = context::count(&context::request_with(&system, &Default::default(), &state, &model, definitions.clone()), &model)
            + context::bundle_tokens(&c.history, question_bundle, &model);
        let kept = alone + 512;
        let ratio = context::token_ratio(c, &model);
        let fits = |tokens: usize| ((tokens as f64 * ratio).ceil() as usize).saturating_add(config.llm.output_tokens + 512) <= config.llm.context_tokens;
        if !fits(estimate) {
            // A cut answer that can no longer be continued stands as written.
            if continuing {
                break partial.concat();
            }
            let usable: &[String] = if withheld_tools { &[] } else { &offered };
            let bare = runtime_state(config, "", remaining, final_round, usable, true, None);
            let mcp_count = mcp.definitions().len();
            let own = definitions[..definitions.len() - mcp_count].to_vec();
            let frame_tokens = context::count(&context::request_with(&system, &Default::default(), &bare, &model, definitions), &model);
            // The MCP tools' definitions and section are what does not fit:
            // the settings are not too small, the allowed tools too many.
            if !fits(frame_tokens) && mcp_count > 0 && fits(context::count(&context::request(&Default::default(), &bare, &model, own), &model)) {
                eprintln!("[mcp] the allowed MCP tools' definitions (~{frame_tokens} tokens with the frame) do not fit the context");
                bail!(UserFacing(MCP_TOO_LARGE.into()));
            }
            bail!(too_long(fits(frame_tokens), fits(alone)));
        }
        rounds += 1;
        let search_first = !withheld_tools && !search_first_asked && !previous_claimed && !looked(&trace);
        let (delta_tx, mut delta_rx) = tokio::sync::mpsc::channel::<String>(64);
        let relay_events = events.clone();
        let writing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let relay_writing = writing.clone();
        let (claim_tx, mut claim_rx) = tokio::sync::oneshot::channel::<()>();
        // The run is cancelled when the browser closes the stream (a stop):
        // what is sent after that never reaches it.
        let stopped = cancel.clone();
        // The text shown while the response streams, kept for a stop.
        let relay = tokio::spawn(async move {
            let mut shown = String::new();
            // Before anything is looked up, the opening line is held while it
            // may still be the general-knowledge line, which is then refused
            // unseen; an answer that opens otherwise streams on. What was
            // shown is never taken back for the line.
            let mut held = search_first.then(String::new);
            let mut claim = Some(claim_tx);
            while let Some(text) = delta_rx.recv().await {
                if text.is_empty() || stopped.is_cancelled() {
                    continue;
                }
                relay_writing.store(true, std::sync::atomic::Ordering::Relaxed);
                let text = match held.as_mut() {
                    Some(start) => {
                        start.push_str(&text);
                        // The line as the system prompt words it: the rest of
                        // the response is not worth generating.
                        if opening_line(start).is_some_and(|(line, _)| lead(line) == Lead::Claims) {
                            if let Some(claim) = claim.take() {
                                let _ = claim.send(());
                            }
                            continue;
                        }
                        match opening(start, false) {
                            // Words to that effect stay held, judged with the
                            // whole response (one with calls is no answer).
                            Lead::Undecided | Lead::Claims => continue,
                            Lead::Other => held.take().unwrap_or_default(),
                        }
                    }
                    None => text,
                };
                shown.push_str(&text);
                relay_events.send(json!({"type":"answer_delta","text":text}));
            }
            // A response that ended while undecided shows its start unless it
            // opens with the line (not after a stop: the stream ended because
            // the browser closed it).
            if let Some(start) = held
                && claim.is_some()
                && !start.is_empty()
                && !stopped.is_cancelled()
                && opening(&start, true) == Lead::Other
            {
                shown.push_str(&start);
                relay_events.send(json!({"type":"answer_delta","text":start}));
            }
            shown
        });
        let started = Instant::now();
        let mut llm_config = config.llm.clone();
        llm_config.retry_timeouts = true;
        let mut call = Box::pin(tokio::time::timeout(remaining, app.llm.complete(request, &llm_config, cancel.clone(), delta_tx)));
        // Before the final reserve, a request that has not begun writing by
        // then stops, so the final answer keeps its time; one writing its
        // answer goes on.
        let mut reserve = (!final_round).then(|| {
            Box::pin(tokio::time::sleep_until(tokio::time::Instant::from_std(deadline - Duration::from_secs(FINAL_RESERVE_SECS))))
        });
        let mut watching = search_first;
        let response = loop {
            tokio::select! {
                _ = cancel.cancelled() => break Err(anyhow::anyhow!("cancelled")),
                result = &mut call => break match result {
                    Ok(result) => result,
                    Err(_) => Err(anyhow::anyhow!("run_timeout")),
                },
                _ = async { reserve.as_mut().unwrap().await }, if reserve.is_some() => {
                    reserve = None;
                    if !writing.load(std::sync::atomic::Ordering::Relaxed) {
                        break Err(anyhow::anyhow!("reserve_reached"));
                    }
                }
                // The held start became the general-knowledge line: the rest
                // of that answer is not worth generating.
                claimed = &mut claim_rx, if watching => {
                    watching = false;
                    if claimed.is_ok() {
                        break Err(anyhow::anyhow!("search_first"));
                    }
                }
            }
        };
        // A request left unfinished goes now, with its stream, so the relay ends.
        drop(call);
        let shown = relay.await.unwrap_or_default();
        let emitted = !shown.is_empty();
        let ms = started.elapsed().as_millis() as u64;
        let completion: Completion = match response {
            Ok(completion) => completion,
            Err(error) => {
                let stopped_for_search = error.to_string() == "search_first";
                timing.llm.push(if stopped_for_search { json!({"ms":ms,"searchFirst":true}) } else { json!({"ms":ms,"error":true}) });
                // What the answer has written: the pieces kept so far and
                // what this response showed before it ended.
                let written = partial.concat() + &shown;
                if error.to_string() == "cancelled" {
                    // What a stopped answer has written stays in the
                    // conversation, as the browser keeps what it showed for
                    // the next question.
                    if !written.trim().is_empty() {
                        if last_is_partial(c) {
                            c.history.bundles.pop_back();
                        }
                        c.history.push(vec![json!({"role":"assistant","content":written})], true);
                    }
                    bail!("cancelled");
                }
                // What this response showed is taken back where it is not
                // part of the answer: the request is made again, or the
                // question ends. A cut answer standing as written keeps it.
                let discard = || {
                    if emitted {
                        retract(events, &partial);
                    }
                };
                if stopped_for_search {
                    eprintln!("[agent] the answer said the registered material lacks it before any search; asking for a search");
                    discard();
                    search_first_asked = true;
                    notice = Some(SEARCH_FIRST.into());
                    continue;
                }
                // Stopped at the final reserve: the next request is the final
                // one, with the whole reserve.
                if error.to_string() == "reserve_reached" {
                    eprintln!("[agent] the request had not begun its answer at the final reserve; asking for the final answer");
                    discard();
                    notice = Some(RESERVE_REACHED.into());
                    continue;
                }
                // A provider that counts more than the estimate, or serves
                // less context than configured, refuses the request. Most
                // refusals say what it counted, the only measure of a request
                // no usage comes back for: it calibrates the estimate.
                // Counted past the configured context, the request was
                // estimated short (the server serves what is configured):
                // calibrated, it is made again as any other — only what must
                // leave leaves, and one that cannot fit is told by what fills
                // it. Otherwise every bundle that may leave leaves and the
                // request is made again; nothing left to leave, the question
                // ends as one too long. Without the count a new
                // conversation's first request (nothing calibrated yet) lost
                // every old bundle, and a question alone was sent to the
                // settings as if the server served less than configured.
                let refusal = error.to_string();
                if crate::llm::context_overflow(&refusal) {
                    let counted = crate::llm::overflow_prompt_tokens(&refusal);
                    let undercounted = counted.is_some_and(|n| n.saturating_add(config.llm.output_tokens + 512) > config.llm.context_tokens);
                    if let Some(counted) = counted {
                        let dropped = error
                            .downcast_ref::<crate::llm::CompletionError>()
                            .is_some_and(|e| e.tools_dropped());
                        let sent = if dropped {
                            context::count(&context::request_with(&system, &c.history, &state, &model, vec![]), &model)
                        } else {
                            estimate
                        };
                        context::record_usage(c, &model, sent, counted);
                    }
                    let calibrated = (estimate as f64 * context::token_ratio(c, &model)).ceil() as usize;
                    if undercounted && calibrated.saturating_add(config.llm.output_tokens + 512) > config.llm.context_tokens {
                        eprintln!("[context] the provider counted {} tokens for ~{estimate}; asking again calibrated", counted.unwrap_or_default());
                        discard();
                        rounds -= 1;
                        notice = round_notice;
                        continue;
                    }
                    let evicted = context::evict_all(c, config, &[question_bundle]);
                    if !evicted.is_empty() {
                        counted_before = None;
                        eprintln!("[context] the provider refused ~{estimate} tokens as too long; evicted {} old bundles", evicted.len());
                        discard();
                        rounds -= 1;
                        notice = round_notice;
                        continue;
                    }
                    if continuing {
                        break written;
                    }
                    discard();
                    let only_question = c.history.bundles.iter().rev().find(|b| b.active).map(|b| b.id) == Some(question_bundle);
                    // Refused with the question alone, which is not most of
                    // the request: the system prompt and tools pass what the
                    // server serves, and a shorter question would not help.
                    // Counted past the configured context, the server serves
                    // it: the settings hold too little for what it counts.
                    if only_question && context::bundle_tokens(&c.history, question_bundle, &model) * 2 < estimate {
                        bail!(if undercounted { too_long(false, true) } else { UserFacing(SERVED_SMALLER.into()) });
                    }
                    bail!(too_long(true, !only_question));
                }
                // A model endpoint that does not take an MCP tool's
                // definition (a schema it refuses) refuses every request the
                // tool is in: the question goes on without the tools its
                // refusal names, and later questions sent there leave them
                // out. Not so for a request sent without its tools, whose
                // refusal is not about them, nor for a refusal of the calls
                // the model wrote, which names the tool it called.
                let tools_sent = !error
                    .downcast_ref::<crate::llm::CompletionError>()
                    .is_some_and(|e| e.tools_dropped());
                let generation = crate::llm::refused_generation(&refusal);
                if tools_sent && !generation && (refusal.starts_with("http_400:") || refusal.starts_with("http_422:")) {
                    let refused = mcp.refused_in(&refusal, &definitions);
                    if !refused.is_empty() {
                        eprintln!("[mcp] the model endpoint refused the definitions of {}; asking without them", refused.join(", "));
                        mcp.refuse(&refused, config, &refusal);
                        mcp = mcp.without(&refused);
                        system = context::system_prompt(&mcp.prompt());
                        discard();
                        rounds -= 1;
                        notice = round_notice;
                        continue;
                    }
                }
                // Tool calls that cannot be used (arguments that are not one
                // JSON object, an empty tool name, too many calls):
                // nothing ran. The client asks again only while none of the
                // response's text has gone out, so one that wrote first (a
                // sentence before its calls) ended the question; it is asked
                // again here, told what was wrong. So is a response whose
                // calls the provider refused.
                let message = error.to_string();
                if crate::llm::unusable_tool_calls(&message) || generation {
                    if unusable < UNUSABLE_RETRIES {
                        unusable += 1;
                        discard();
                        let detail = clip_utf16(&message, 300);
                        notice = Some(if continuing {
                            format!("이전 응답은 쓸 수 없는 도구 호출로 끝났다({detail}). 답변을 이어 쓰는 중이라 도구를 쓸 수 없다. 끊긴 곳에서 바로 이어 써라.")
                        } else if withheld_tools {
                            format!("이전 응답은 쓸 수 없는 도구 호출로 끝났다({detail}). 도구를 더 쓸 수 없다. 지금까지 확보한 근거로 최종 답변만 써라.")
                        } else {
                            format!("이전 응답의 도구 호출은 쓸 수 없어 하나도 실행되지 않았다({detail}). 필요한 호출을 올바른 인수로 다시 하라.")
                        });
                        continue;
                    }
                    if continuing {
                        break written;
                    }
                    discard();
                    bail!(UserFacing(UNUSABLE_CALLS.into()));
                }
                // The provider or the connection failed: asked again after a
                // wait, what this response showed taken back. A stream cut
                // while it wrote is no reason to end the question, though
                // the client could not retry it (its text had gone out).
                let unavailable = error
                    .downcast_ref::<crate::llm::CompletionError>()
                    .is_some_and(|e| e.transient());
                if unavailable && outages < PROVIDER_WAITS.len() {
                    let wait = Duration::from_secs(PROVIDER_WAITS[outages]);
                    if Instant::now() + wait + Duration::from_secs(FINAL_RESERVE_SECS) < deadline {
                        outages += 1;
                        rounds -= 1;
                        discard();
                        eprintln!("[llm] provider unavailable; retrying in {}s: {error}", wait.as_secs());
                        tokio::select! {
                            _ = cancel.cancelled() => bail!("cancelled"),
                            _ = tokio::time::sleep(wait) => {}
                        }
                        notice = round_notice;
                        continue;
                    }
                }
                // A cut answer whose continuation failed (its time ran out,
                // the provider failed) stands as written.
                if continuing {
                    eprintln!("[agent] continuing a cut answer failed; it stands as written: {error:#}");
                    break written;
                }
                discard();
                if error.to_string() == "run_timeout" {
                    bail!(UserFacing(TIME_OVER.into()));
                }
                return Err(error);
            }
        };
        outages = 0;
        unusable = 0;
        let usage = completion.usage.clone();
        if let Some(usage) = &usage {
            // The provider counted the request as it was sent: without the
            // withheld tools when it was answered without them.
            let sent = if completion.tools_dropped {
                context::count(&context::request_with(&system, &c.history, &state, &model, vec![]), &model)
            } else {
                estimate
            };
            context::record_usage(c, &model, sent, usage.input);
            eprintln!(
                "[llm] usage prompt={} completion={} cached={} ms={ms}",
                usage.input,
                usage.output,
                usage.cached.unwrap_or(0)
            );
            // A request that only grew since the last one counted (nothing
            // left the context) counts more tokens, whatever the tokenizer.
            // One counted no more, and under half its estimate (below what
            // calibration takes), was cut to a context smaller than
            // configured: the answer would be written from what was left —
            // the question gone, as a real Ollama at its default 4,096 tokens
            // answered with pieces of the runtime state. The prompt count
            // includes its cached tokens (OpenAI's usage, which compatible
            // providers follow — added in, a cache hit before a miss would
            // look like a shrinking count); more cached than prompt tokens
            // is a provider counting them apart.
            let cached = usage.cached.unwrap_or(0);
            let seen = if cached > usage.input { usage.input.saturating_add(cached) } else { usage.input };
            if let Some((before, counted)) = counted_before
                && sent >= before + CUT_GROWTH
                && seen <= counted
                && seen.saturating_mul(2) < sent
            {
                eprintln!("[context] the provider counted {seen} tokens for ~{sent} after {counted} for ~{before}: it cuts requests to less context than configured");
                if emitted || !partial.is_empty() {
                    events.send(json!({"type":"answer_reset"}));
                }
                if last_is_partial(c) {
                    c.history.bundles.pop_back();
                }
                bail!(UserFacing(SERVED_CUT.into()));
            }
            if seen > 0 {
                counted_before = Some((sent, seen));
            }
        }
        timing.llm.push(json!({"ms":ms,"prompt":usage.as_ref().map(|u| u.input),"completion":usage.as_ref().map(|u| u.output),"cached":usage.as_ref().and_then(|u| u.cached),"estimate":estimate}));
        // An answer opening with words to the effect of the general-knowledge
        // line before anything was looked up, held unseen while it streamed.
        // Only its opening line is judged: the same words further on are no
        // claim (a quote of the line, as the README's own examples hold), and
        // when the whole answer was judged, one shown in full was taken back
        // and written again for them. What was shown stands.
        if search_first
            && !emitted
            && completion.calls.is_empty()
            && !completion.discarded_tool_calls
            && opening(&completion.text, true) == Lead::Claims
        {
            eprintln!("[agent] the answer said the registered material lacks it before any search; asking for a search");
            if let Some(last) = timing.llm.last_mut() {
                last["searchFirst"] = json!(true);
            }
            search_first_asked = true;
            notice = Some(SEARCH_FIRST.into());
            continue;
        }
        // Text streamed for a response that is not part of the answer (it
        // called tools, its calls were cut, it was blank) is taken back. A
        // cut answer's piece stays shown: its continuation follows it.
        let answers = completion.calls.is_empty() && !completion.discarded_tool_calls && !completion.text.trim().is_empty();
        if emitted && !answers {
            retract(events, &partial);
        }
        if completion.length_limited {
            if completion.discarded_tool_calls {
                // Calls cut at the output limit never run. Withheld, they
                // count below as calls the model was told not to make.
                if !withheld_tools {
                    notice = Some("이전 응답이 출력 한도에 걸려 그 도구 호출은 하나도 실행되지 않았다. 필요한 호출을 더 짧은 인수로 다시 하라.".into());
                    continue;
                }
            } else if !completion.text.trim().is_empty() && partial.len() < LENGTH_CONTINUATIONS {
                partial.push(completion.text.clone());
                // A piece is progress: its continuation gets its own retries
                // for blank replies and for calls while tools are withheld.
                empty = 0;
                withheld = 0;
                // The pieces so far stay one assistant message, which the
                // next piece continues.
                if last_is_partial(c) {
                    c.history.bundles.pop_back();
                }
                c.history.push(
                    vec![json!({"role":"assistant","content":partial.concat(),"partial":true})],
                    true,
                );
                continue;
            } else if !completion.text.trim().is_empty() {
                partial.push(completion.text.clone());
                break partial.concat();
            }
        }
        if completion.calls.is_empty() && !completion.discarded_tool_calls {
            let text = completion.text.trim();
            if text.is_empty() {
                empty += 1;
                // Cut at the output limit with nothing written: the limit
                // went on what the model does not show (a thinking model's
                // reasoning). Neither a blank reply nor a passing failure.
                let spent = completion.length_limited;
                if empty > EMPTY_RETRIES {
                    if !partial.is_empty() {
                        break partial.concat();
                    }
                    bail!(UserFacing(if spent { OUTPUT_SPENT } else { EMPTY_REPLIES }.into()));
                }
                notice = Some(
                    match (spent, continuing, final_round) {
                        (false, true, _) => "이전 응답이 비어 있었다. 끊긴 곳에서 바로 이어 써라.",
                        (false, false, true) => "이전 응답이 비어 있었다. 지금까지 확보한 근거로 최종 답변을 써라.",
                        (false, false, false) => "이전 응답이 비어 있었다(글도 도구 호출도 없었다). 도구를 부르거나 답변을 써라.",
                        (true, true, _) => "이전 응답은 출력 한도에 닿을 때까지 글을 쓰지 못했다. 생각을 짧게 하고 끊긴 곳에서 바로 이어 써라.",
                        (true, false, true) => "이전 응답은 출력 한도에 닿을 때까지 글을 쓰지 못했다. 생각을 짧게 하고 지금까지 확보한 근거로 바로 최종 답변을 써라.",
                        (true, false, false) => "이전 응답은 출력 한도에 닿을 때까지 글도 도구 호출도 내지 못했다. 생각을 짧게 하고 바로 도구를 부르거나 답변을 써라.",
                    }
                    .into(),
                );
                continue;
            }
            partial.push(completion.text.clone());
            break partial.concat();
        }
        empty = 0;
        if withheld_tools {
            // Tools were withheld; a provider that still sends calls gets
            // another request.
            notice = Some(if continuing {
                "답변을 이어 쓰는 중이라 도구를 쓸 수 없다. 끊긴 곳에서 바로 이어 써라.".into()
            } else {
                "도구를 더 쓸 수 없다. 지금까지 확보한 근거로 최종 답변만 써라.".into()
            });
            withheld += 1;
            if withheld > WITHHELD_RETRIES {
                // A cut answer is kept as far as it was written.
                if continuing {
                    break partial.concat();
                }
                bail!(UserFacing("모델이 답변 대신 도구 호출을 반복해 답변을 마무리하지 못했습니다.".into()));
            }
            continue;
        }
        // What this response's tool results may fill, at the token ratio its
        // own usage has just updated: the next request is checked with it.
        let room = ((config.input_budget() as f64 / context::token_ratio(c, &model)) as usize).saturating_sub(kept);
        // A response whose own calls (their arguments, a text before them)
        // leave no room for the smallest results `fit_batch` cuts to is not
        // run: its results would be cut and the next request still not fit,
        // ending the question after its tools ran — an MCP tool's effect (an
        // issue filed, a message sent) to be done again when the question is
        // asked again. The model is asked for smaller calls instead.
        let response_tokens = context::count(&assistant_message(&completion), &model);
        if response_tokens + completion.calls.len() * crate::config::MIN_RESULT_TOKENS > room {
            eprintln!(
                "[agent] the response's {} calls (~{response_tokens} tokens) leave no room for their results (~{room} tokens); not run",
                completion.calls.len()
            );
            oversized += 1;
            if oversized > OVERSIZED_RETRIES {
                bail!(too_long(true, true));
            }
            notice = Some(format!(
                "이전 응답의 도구 호출 {}개는 하나도 실행하지 않았다: 호출과 그 인수만 약 {response_tokens} 토큰이라 결과를 함께 담을 자리(약 {room} 토큰)가 남지 않는다. 인수를 줄이거나 호출 수를 줄여 다시 하라.",
                completion.calls.len()
            ));
            continue;
        }
        oversized = 0;
        let tool_started = Instant::now();
        // The calls stop at the final reserve too, which the final answer keeps.
        let tools_cancel = cancel.child_token();
        let stop_at = deadline - Duration::from_secs(FINAL_RESERVE_SECS);
        if Instant::now() >= stop_at {
            // Already there (the response was written into the reserve).
            tools_cancel.cancel();
        }
        let stopper = {
            let stop = tools_cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep_until(tokio::time::Instant::from_std(stop_at)).await;
                stop.cancel();
            })
        };
        let messages = execute_batch(
            app,
            config,
            c,
            &completion,
            &offered,
            &mcp,
            events,
            &tools_cancel,
            &mut tracker,
            &mut executed,
            &mut trace,
            &mut event_id,
            room,
        )
        .await;
        stopper.abort();
        timing.tools.push(json!({"ms":tool_started.elapsed().as_millis() as u64,"calls":completion.calls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>()}));
        if cancel.is_cancelled() {
            // The calls of a stopped question stay in the conversation with
            // what they returned (or `cancelled`): an MCP tool may have taken
            // effect (an issue filed), and the next question would otherwise
            // not know it was asked, and ask again.
            c.history.push(messages, true);
            bail!("cancelled");
        }
        let stopped = tools_cancel.is_cancelled()
            && messages.iter().any(|m| m["role"] == "tool" && m["content"].as_str().is_some_and(|c| c.contains("\"status\":\"cancelled\"")));
        if stopped {
            eprintln!("[agent] tool calls stopped at the final reserve");
            notice = Some(TOOLS_STOPPED.into());
        }
        c.history.push(messages, true);
    };
    // The answer is kept in history as written (table and chart references,
    // not filled rows): the context stays small and refers to steps.
    if last_is_partial(c) {
        c.history.bundles.pop_back();
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
    let mut log = json!({
        "v":5,"outcome":"answered","conversation_id":c.id,"rounds":rounds,
        "search":search_summary(&trace),
        "timing":{"total":total,"llm":timing.llm,"tools":timing.tools},
        "steps":trace.iter().map(log_step).collect::<Vec<_>>()
    });
    if search_first_asked {
        log["searchFirst"] = json!(true);
    }
    Ok(Answer {
        answer: answer_text,
        trace,
        refs,
        log,
    })
}

/// Takes back the text streamed for a response that is not part of the
/// answer. The pieces of a cut answer being continued are shown again, as the
/// answer goes on from them.
fn retract(events: &Events, partial: &[String]) {
    events.send(json!({"type":"answer_reset"}));
    if !partial.is_empty() {
        events.send(json!({"type":"answer_delta","text":partial.concat()}));
    }
}

/// A request that does not fit with every old bundle evicted, told by what
/// fills it: the frame alone (no question fits the configured context), the
/// question, or what this question gathered (its newest results or answer
/// pieces). Earlier questions have all left the context by then, so a new
/// conversation would fail the same way: only a narrower question helps.
fn too_long(frame_fits: bool, question_fits: bool) -> UserFacing {
    UserFacing(if !frame_fits {
        "모델 컨텍스트 설정이 너무 작아 답할 수 없습니다. 설정에서 컨텍스트와 출력 한도를 확인해주세요.".into()
    } else if !question_fits {
        "질문이 너무 길어 답할 수 없습니다. 질문을 줄여 다시 시도해주세요.".into()
    } else {
        "이번 질문에 필요한 자료가 한 번에 담기지 않아 답할 수 없습니다. 질문을 나누거나 범위를 좁혀 다시 시도해주세요.".into()
    })
}

/// Whether an answer says the registered material lacks what was asked: the
/// general-knowledge line of the system prompt, or words to that effect.
fn claims_unregistered(text: &str) -> bool {
    static PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"등록(?:된|되어\s*있는)\s*(?:지식|자료)[^\n.]{0,10}없").unwrap()
    });
    PATTERN.is_match(text)
}

/// How far the start of a streamed answer decides whether it opens with the
/// general-knowledge line.
#[derive(Debug, PartialEq)]
enum Lead {
    Undecided,
    Claims,
    Other,
}
fn lead(text: &str) -> Lead {
    let start = text.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '*' | '_' | '>' | '#'));
    if start.starts_with(UNREGISTERED_LEAD) {
        Lead::Claims
    } else if UNREGISTERED_LEAD.starts_with(start) {
        Lead::Undecided
    } else {
        Lead::Other
    }
}

/// The line an answer opens with, where the system prompt has the
/// general-knowledge line said: the first with content, past blank lines and
/// short headings (a title before it), and whether it has ended. None past
/// `OPENING_SKIP` characters of them: nothing there opens the answer.
fn opening_line(text: &str) -> Option<(&str, bool)> {
    let mut rest = text;
    let mut passed = 0usize;
    loop {
        let mut blank = rest.len();
        for (at, c) in rest.char_indices() {
            if !c.is_whitespace() {
                blank = at;
                break;
            }
            passed += 1;
            if passed > OPENING_SKIP {
                return None;
            }
        }
        let start = &rest[blank..];
        let Some((line, after)) = start.split_once('\n') else {
            return Some((start, false));
        };
        let title = line.starts_with('#') && line.chars().count() < OPENING_CHARS;
        if !title || claims_unregistered(line) {
            return Some((line, true));
        }
        passed += line.chars().count() + 1;
        if passed > OPENING_SKIP {
            return None;
        }
        rest = after;
    }
}

/// Whether an answer opens with words to the effect of the general-knowledge
/// line, as far as `text` tells; `done` when the response has ended. Judged
/// on the start of the opening line, a decision a prefix of the text makes
/// stays the decision for all of it: the relay holds no more than the
/// opening, and what it shows is never refused after the response ends.
fn opening(text: &str, done: bool) -> Lead {
    let Some((line, ended)) = opening_line(text) else {
        return Lead::Other;
    };
    let end = line.char_indices().nth(OPENING_CHARS).map_or(line.len(), |(i, _)| i);
    if claims_unregistered(&line[..end]) {
        Lead::Claims
    } else if done || ended || line.chars().count() >= OPENING_CHARS {
        Lead::Other
    } else {
        Lead::Undecided
    }
}

/// Whether this question has looked anything up: a search or a query as
/// they ran, or another tool that answered (a registered project's files, an
/// MCP tool). A call refused before it ran looked at nothing.
fn looked(trace: &[Value]) -> bool {
    trace.iter().any(|step| step.get("tool").is_none() || step["status"] == "ok")
}

/// Whether the newest bundle holds the pieces of an answer being continued.
fn last_is_partial(c: &Conversation) -> bool {
    c.history
        .bundles
        .back()
        .and_then(|b| b.messages.first())
        .is_some_and(|m| m["partial"] == true)
}

/// The agent's own tools a round defines at most (`offered_tools` with the
/// history tool): a request's other tools are the MCP tools'.
fn most_agent_tools(config: &Config) -> usize {
    let source = if config.projects.is_empty() { 0 } else { ToolRegistry::source_specs().iter().filter(|s| s.source).count() };
    voc_tools::specs().len() + source + 1
}

/// Tools defined this round: the knowledge and query tools always, the
/// source tools when projects exist, the history tool once something left
/// the context, then the question's MCP tools. A round that withholds them
/// still defines them.
fn offered_tools(config: &Config, c: &Conversation, mcp: &mcp::Snapshot) -> Vec<String> {
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
    names.extend(mcp.names().map(str::to_owned));
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
    // A cut answer is continued, in the final round too: a new final answer
    // would be joined to the pieces already written.
    let instruction = if !first_part {
        "이전 응답이 출력 한도에서 끊겼다. 끊긴 곳에서 바로 이어 써라. 앞부분을 반복하거나 머리말을 붙이지 말고, 이미 연 코드블록을 다시 열지 마라."
    } else if final_round {
        "도구를 더 쓸 수 없다. 지금까지 확보한 근거로 최종 답변을 써라. 확인하지 못한 부분은 그렇다고 밝혀라."
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
        state["search"] = json!("unavailable: 임베딩이 설정되지 않아 의미 검색을 쓸 수 없다. 제목·쿼리 이름·설명의 낱말 일치만 된다.");
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
    /// `renamed`: called by the server's own name for the tool, and the note
    /// telling the model the name to use.
    Mcp { args: Value, tool: Arc<mcp::Offered>, renamed: Option<String> },
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
    mcp: &mcp::Snapshot,
    events: &Events,
    cancel: &CancellationToken,
    tracker: &mut FailureTracker,
    executed: &mut HashMap<String, u64>,
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
    // MCP calls of this response (tool, arguments): a repeat is refused, as
    // a repeated query is — an MCP tool may file an issue or send a message.
    let mut mcp_runs: Vec<(String, Value)> = vec![];
    let root = |p: &Project| p.root.canonicalize().unwrap_or_else(|_| p.root.clone());
    let mut roots: BTreeMap<usize, String> = BTreeMap::new();
    for (index, call) in calls.iter().enumerate() {
        *event_id += 1;
        ids.push(*event_id);
        let raw = if call.arguments.trim().is_empty() { "{}" } else { call.arguments.as_str() };
        let parsed: std::result::Result<Value, String> = serde_json::from_str(raw).map_err(|e| {
            format!("invalid_tool_arguments: {e}; send one complete JSON object; nothing was executed")
        });
        let mut once = |tool: &mcp::Offered, args: &Value| -> std::result::Result<(), String> {
            // Compared as values: the same arguments in another order repeat.
            if mcp_runs.iter().any(|(name, known)| *name == tool.exposed && known == args) {
                return Err(format!("repeated_call: 이 응답 안에서 {}을(를) 같은 인수로 두 번 부르려 했다. 하나만 실행된다", tool.exposed));
            }
            mcp_runs.push((tool.exposed.clone(), args.clone()));
            Ok(())
        };
        let prepared_call = (|| -> std::result::Result<Prepared, String> {
            if !offered.contains(&call.name) {
                // A model that follows a server's own description calls its
                // tool by the server's name for it: the one MCP tool of that
                // name runs, and the result says the name to use — unless
                // the name is one of the agent's own tools, which it may mean.
                let known = ToolRegistry::specs().iter().any(|s| s.name == call.name);
                match if known { Ok(None) } else { mcp.find_raw(&call.name) } {
                    Ok(Some(tool)) => {
                        let args = parsed.clone()?;
                        tool.check(&args).map_err(|e| format!("{e:#}"))?;
                        once(&tool, &args)?;
                        let renamed = Some(format!("tool name {} was taken as {}; call it {}", call.name, tool.exposed, tool.exposed));
                        return Ok(Prepared::Mcp { args, tool, renamed });
                    }
                    Err(names) => {
                        return Err(format!("unsupported_tool: {} is a tool of several MCP servers; call one of {}", call.name, names.join(", ")));
                    }
                    Ok(None) => {}
                }
                // An MCP tool the conversation called before is told why it
                // is not there, not as one that does not exist.
                return Err(if known {
                    format!("unsupported_tool: {} is not offered now; use the offered tools", call.name)
                } else {
                    app.mcp.unoffered(&call.name).unwrap_or_else(|| tools::unknown_tool(&call.name, offered))
                });
            }
            let mut args = parsed.clone()?;
            if let Some(tool) = mcp.find(&call.name) {
                tool.check(&args).map_err(|e| format!("{e:#}"))?;
                once(&tool, &args)?;
                return Ok(Prepared::Mcp { args, tool, renamed: None });
            }
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
    // The MCP tool of each call, a call refused before it ran (an argument
    // missing) too, by either name: its progress line and trace name its
    // server and tool, under the name the model sees.
    let mcp_tools: Vec<Option<Arc<mcp::Offered>>> = prepared
        .iter()
        .enumerate()
        .map(|(i, p)| match p {
            Prepared::Mcp { tool, .. } => Some(tool.clone()),
            Prepared::Done(_) => mcp.find(&calls[i].name).or_else(|| {
                let known = ToolRegistry::specs().iter().any(|s| s.name == calls[i].name);
                if known { None } else { mcp.find_raw(&calls[i].name).ok().flatten() }
            }),
            _ => None,
        })
        .collect();
    let summaries: Vec<Option<String>> = mcp_tools
        .iter()
        .enumerate()
        .map(|(i, tool)| {
            tool.as_ref().map(|tool| match &prepared[i] {
                Prepared::Mcp { args, .. } => tool.summary(args),
                _ => tool.summary(&serde_json::from_str(&calls[i].arguments).unwrap_or(Value::Null)),
            })
        })
        .collect();
    let names: Vec<String> = calls
        .iter()
        .zip(&mcp_tools)
        .map(|(call, tool)| tool.as_ref().map_or_else(|| call.name.clone(), |tool| tool.exposed.clone()))
        .collect();
    // Start events, in call order.
    for (index, call) in calls.iter().enumerate() {
        let id = ids[index];
        let args = match &prepared[index] {
            Prepared::Voc { args } | Prepared::Source { args, .. } | Prepared::Mcp { args, .. } => args.clone(),
            Prepared::Done(_) => serde_json::from_str(&call.arguments).unwrap_or(Value::Null),
        };
        if let Some(summary) = &summaries[index] {
            events.send(json!({"type":"tool","id":id,"name":names[index],"summary":summary}));
            continue;
        }
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
    // MCP calls run as tasks of their own beside the source and knowledge
    // calls; each closes its progress line when it ends.
    let mcp_tasks: Vec<(usize, tokio::task::JoinHandle<Result<Value>>)> = prepared
        .iter()
        .enumerate()
        .filter_map(|(i, p)| match p {
            Prepared::Mcp { args, tool, .. } => {
                let tool = tool.clone();
                let args = args.clone();
                let cancel = cancel.clone();
                let events = events.clone();
                let (id, name) = (ids[i], names[i].clone());
                Some((
                    i,
                    tokio::spawn(async move {
                        let started = Instant::now();
                        let outcome = tool.call(args, &cancel).await;
                        let status = match &outcome {
                            Ok(_) => "ok",
                            Err(e) if tools::recovery::error_code(&e.to_string()) == "cancelled" => "cancelled",
                            Err(_) => "error",
                        };
                        events.send(json!({"type":"tool_done","id":id,"name":name,"status":status,"ms":started.elapsed().as_millis() as u64}));
                        outcome
                    }),
                ))
            }
            _ => None,
        })
        .collect();
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
            // The root before bounding: an archived result is shown with
            // paths relative to it, as the model receives the result.
            if call.name != "history" {
                result["root"] = json!(root_text.display().to_string());
            }
            let continued = continuation_args(&call.name, &clean, &workspace.project);
            let mut result = tools::limit_result(&mut workspace, &call, &continued, result, share);
            if call.name != "history" && result.get("root").is_none() {
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
    let started = std::sync::Mutex::new(BTreeSet::new());
    {
        let cx = voc_tools::Context {
            app,
            config,
            cancel,
            results: &c.results,
            executed,
            started: &started,
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
                executed.insert(signature, step);
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
    for (index, task) in mcp_tasks {
        // A task that panicked never closed its progress line.
        let outcome = task.await.unwrap_or_else(|_| {
            events.send(json!({"type":"tool_done","id":ids[index],"name":names[index],"status":"error"}));
            Err(anyhow::anyhow!("tool_worker_panic: the tool stopped unexpectedly"))
        });
        let (args, renamed) = match &prepared[index] {
            Prepared::Mcp { args, renamed, .. } => (args.clone(), renamed.clone()),
            _ => (Value::Null, None),
        };
        let mut result = tools::envelope(outcome);
        if let Some(note) = renamed {
            if result["data"].is_object() {
                result["data"]["adjusted_arguments"] = json!([note]);
            } else {
                result["adjusted_arguments"] = json!([note]);
            }
        }
        results[index] = Some(tools::bound_result(&mut workspace, &calls[index], &args, result, share));
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
            let summary = summaries[index].clone().unwrap_or_else(|| tools::call_summary(&root, &call.name, &call.arguments));
            trace.push(json!({"tool":names[index],"summary":summary,"status":result["status"]}));
            if let Prepared::Done(_) = &prepared[index] {
                events.send(json!({"type":"tool_done","id":ids[index],"name":names[index],"status":result["status"]}));
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
        .map(|p| !matches!(p, Prepared::Voc { .. } | Prepared::Source { .. } | Prepared::Mcp { .. }))
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
            Prepared::Voc { args } | Prepared::Mcp { args, .. } => args.clone(),
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
        if let Prepared::Source { project, .. } = &prepared[index] {
            args = continuation_args(&calls[index].name, &args, project);
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

/// The arguments a cut result's continuation repeats (a page of
/// code_outline, symbol_search or symbol_relations): with the project the
/// call ran in, which the call may have left out (a path found in one
/// project, the only project). Copied as given, a continuation without it is
/// refused where several projects are.
fn continuation_args(name: &str, args: &Value, project: &Project) -> Value {
    let mut args = args.clone();
    if name != "history" && args.is_object() {
        args["project"] = json!(project.name);
    }
    args
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
            FileCursor { project: "b".into(), path: "README.md".into(), hash: String::new(), start_line: 1, max_lines: 10, offset: 0, handed_out: 0 },
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
    fn a_restored_conversation_starts_with_a_question() {
        let mut c = Conversation::new("r".into());
        let turns: Vec<(String, String)> = [("assistant", "앞 답"), ("user", "질문"), ("assistant", "답")]
            .into_iter()
            .map(|(role, text)| (role.to_owned(), text.to_owned()))
            .collect();
        restore(&mut c, &turns);
        let roles: Vec<String> = c.history.active().iter().map(|m| m["role"].as_str().unwrap().to_owned()).collect();
        assert_eq!(roles, ["user", "assistant"]);
        // A question left out (blank) left its answer after the answer
        // before it: a reply after a reply, which strict chat templates refuse.
        let mut c = Conversation::new("r2".into());
        let turns: Vec<(String, String)> = [("user", "질문"), ("assistant", "답"), ("user", "  "), ("assistant", "빈 질문의 답"), ("user", "다음"), ("assistant", "다음 답")]
            .into_iter()
            .map(|(role, text)| (role.to_owned(), text.to_owned()))
            .collect();
        restore(&mut c, &turns);
        let kept: Vec<String> = c.history.active().iter().map(|m| m["content"].as_str().unwrap().to_owned()).collect();
        assert_eq!(kept, ["질문", "답", "다음", "다음 답"]);
    }

    #[test]
    fn the_general_knowledge_line_is_told_from_other_answers() {
        let line = "*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*\n일론 머스크는";
        assert!(claims_unregistered(line));
        for said in ["### 답변\n\n등록된 자료에서 찾을 수 없어 일반 지식으로 답합니다.", "등록되어 있는 지식에는 없지만", "> **등록된 지식에 없는 질문이라**"] {
            assert!(claims_unregistered(said), "{said}");
        }
        for other in ["배치 재시작은 등록된 지식의 절차를 따릅니다.", "등록된 쿼리로 조회했습니다. 결과가 없습니다.", "안녕하세요!"] {
            assert!(!claims_unregistered(other), "{other}");
        }
        // The line as the system prompt words it stops its request at once.
        for (start, expected) in [
            ("", Lead::Undecided),
            ("*", Lead::Undecided),
            ("**등록된 지식", Lead::Undecided),
            ("\n> *등록된 지식에 없는 내", Lead::Undecided),
            ("*등록된 지식에 없는 내용이라", Lead::Claims),
            ("등록된 쿼리", Lead::Other),
            ("등록된 지식에 없는지 찾아보겠다", Lead::Other),
            ("**요약**", Lead::Other),
            ("# 배치", Lead::Other),
        ] {
            assert_eq!(lead(start), expected, "{start:?}");
        }
    }

    #[test]
    fn only_the_opening_line_says_the_general_knowledge_line() {
        let quoted = "llm_agent는 사내 지식과 DB를 함께 보는 에이전트입니다.\n\n| 질문 | 동작 |\n|---|---|\n| 쿠버네티스가 뭐야 | 검색 후 일반 지식으로 답변 (\"등록된 지식에 없는 내용…\" 표시) |";
        let long_first = format!("{}등록된 지식에 없는 내용입니다.", "가".repeat(OPENING_CHARS));
        let long_title = format!("# {}\n등록된 지식에 없는 내용이라 일반 지식으로 답합니다.", "제목".repeat(OPENING_CHARS));
        for (text, done, expected) in [
            ("", false, Lead::Undecided),
            ("\n\n", false, Lead::Undecided),
            ("*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*\n일론 머스크는", false, Lead::Claims),
            ("죄송하지만 이 질문은 등록된 자료에서 찾을 수 없어", false, Lead::Claims),
            // A title before it is passed over, and is held as it comes.
            ("### 답변\n\n등록된 자료에서 찾을 수 없어 일반 지식으로 답합니다.", true, Lead::Claims),
            ("### 답변", false, Lead::Undecided),
            ("### 답변\n\n등록된 자료", false, Lead::Undecided),
            // An answer that opens otherwise, at its line's end or past its
            // first characters.
            (quoted, true, Lead::Other),
            ("**요약**\n등록된 지식에 없는 내용", false, Lead::Other),
            ("쿠버네티스는 컨테이너", false, Lead::Undecided),
            ("쿠버네티스는 컨테이너", true, Lead::Other),
            (long_first.as_str(), false, Lead::Other),
            (long_title.as_str(), true, Lead::Other),
        ] {
            assert_eq!(opening(text, done), expected, "{text:?} done={done}");
        }
        // A prefix that decides decides for the whole text: the relay never
        // shows what the finished response is refused for.
        for text in [
            quoted,
            GENERAL,
            "### 답변\n\n등록된 자료에서 찾을 수 없어 일반 지식으로 답합니다.",
            "## 등록된 지식에 없는 내용\n쿠버네티스는",
            long_first.as_str(),
            long_title.as_str(),
            "## 개요\r\n\r\n배치는 정상입니다.\n등록된 자료에 없",
        ] {
            let whole = opening(text, true);
            for (i, _) in text.char_indices().chain([(text.len(), ' ')]) {
                let decided = opening(&text[..i], false);
                assert!(decided == Lead::Undecided || decided == whole, "{:?} decided {decided:?}, the whole {whole:?}", &text[..i]);
            }
        }
    }

    const GENERAL: &str = "*등록된 지식에 없는 내용이라 일반 지식으로 답변합니다.*\n일론 머스크는 기업가입니다.";

    /// Backend review (leaks, panics, deadlocks), fourth pass: a response of
    /// heading or blank lines alone (a model repeating itself) was held by
    /// the relay whole and judged from its start again at every token, on
    /// the async runtime — 5,000 `###` lines took 3.5 s, 20,000 a minute.
    #[test]
    fn an_answer_opening_with_headings_or_blank_lines_alone_is_decided_soon() {
        for line in ["###\n", "\n", "# 제목\n", " \r\n", "  "] {
            // As the relay judges a streamed response, a piece at a time.
            let mut text = String::new();
            while opening(&text, false) == Lead::Undecided {
                text.push_str(line);
                assert!(text.chars().count() <= OPENING_SKIP + OPENING_CHARS, "{line:?} still held at {} characters", text.chars().count());
            }
            assert_eq!(opening(&text, false), Lead::Other, "{line:?}");
            let started = Instant::now();
            assert_eq!(opening(&line.repeat(50_000), true), Lead::Other, "{line:?}");
            assert!(started.elapsed() < Duration::from_millis(100), "{line:?}: {:?}", started.elapsed());
        }
        // A few headings before the line still leave it the opening.
        assert_eq!(opening("# 답변\n\n## 요약\n\n등록된 지식에 없는 내용이라 일반 지식으로 답합니다.", true), Lead::Claims);
        // Past the headings an answer opens with, the line opens nothing,
        // and no prefix decides otherwise.
        let late = format!("{}등록된 지식에 없는 내용이라 일반 지식으로 답합니다.", "###\n".repeat(100));
        assert_eq!(opening(&late, true), Lead::Other);
        for (i, _) in late.char_indices() {
            assert_ne!(opening(&late[..i], false), Lead::Claims, "{:?}", &late[..i]);
        }
    }

    #[test]
    fn a_call_refused_before_it_ran_looked_at_nothing() {
        assert!(!looked(&[]));
        assert!(!looked(&[json!({"tool":"nope","summary":"nope","status":"error"})]));
        for step in [
            json!({"search":"배치","targets":["knowledge"],"hits":{"knowledge":0}}),
            json!({"step":1,"query_name":"q","error":"조회 중 오류가 발생했습니다."}),
            json!({"tool":"file_read","summary":"[app] 파일 읽기 README.md","status":"ok"}),
            json!({"tool":"exa__web_search_exa","summary":"exa · web_search_exa","status":"ok"}),
        ] {
            assert!(looked(std::slice::from_ref(&step)), "{step}");
        }
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
