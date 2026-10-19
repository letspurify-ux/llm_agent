use crate::config::LlmConfig as Config;
use anyhow::{Result, bail};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    error::Error as StdError,
    fmt::{Display, Formatter},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

mod dns;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}
pub const MAX_TOOL_CALL_ID_BYTES: usize = 256;
pub const MAX_TOOL_NAME_BYTES: usize = 128;
pub const MAX_COMPLETION_BYTES: usize = 8 * 1024 * 1024;
/// Safety bound on the calls assembled from one response. The agent runs
/// every call of a response; only a response past this bound is rejected
/// as malformed.
pub const MAX_TOOL_CALLS: usize = 256;

pub fn validate_completion_bounds(completion: &Completion) -> Result<()> {
    if completion.calls.len() > MAX_TOOL_CALLS {
        bail!("tool_call_batch_limit: at most {MAX_TOOL_CALLS} calls");
    }
    let mut bytes = completion.text.len();
    for call in &completion.calls {
        if call.id.len() > MAX_TOOL_CALL_ID_BYTES || call.name.len() > MAX_TOOL_NAME_BYTES {
            bail!("malformed_tool_call: call ID or name is too long");
        }
        bytes = bytes
            .saturating_add(call.id.len())
            .saturating_add(call.name.len())
            .saturating_add(call.arguments.len());
    }
    if bytes > MAX_COMPLETION_BYTES {
        bail!("response_size_limit");
    }
    Ok(())
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input: usize,
    pub output: usize,
    pub cached: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptAction {
    Retry,
    JsonModeFallback,
    UnstructuredFallback,
    /// Withheld tools sent again without their definitions, for a provider
    /// that refuses tool_choice "none".
    ToolChoiceFallback,
    /// Sent again without an optional parameter the provider refused by name.
    ParameterFallback,
    Stop,
}

/// A failed provider attempt, retained even when a later attempt succeeds.
#[derive(Clone, Debug, Serialize)]
pub struct AttemptDiagnostic {
    pub attempt: usize,
    pub code: String,
    pub reason: String,
    pub action: AttemptAction,
}

/// Marks a gateway error event that arrived before any output; see
/// [`unstarted_stream_error`].
const UNSTARTED_STREAM: &str = "no output yet;";

/// An in-stream 429 or 5xx error event received before any output, tool call
/// or usage: the gateway relayed a refusal, nothing was generated.
fn unstarted_stream_error(text: &str) -> bool {
    text.strip_prefix("provider_stream_error: ")
        .is_some_and(|rest| rest.starts_with(UNSTARTED_STREAM))
}

/// An attempt the provider refused with an HTTP status, or with an error
/// event before any output, never started generating, so it is not billed
/// and needs no usage estimate. Later in-stream failures, timeouts and
/// invalid output may have consumed tokens.
fn unbilled_attempts(diagnostics: &[AttemptDiagnostic]) -> usize {
    diagnostics
        .iter()
        .filter(|attempt| {
            attempt.code.starts_with("http_") || unstarted_stream_error(&attempt.reason)
        })
        .count()
}

#[derive(Clone, Debug, Default)]
pub struct Completion {
    pub text: String,
    pub calls: Vec<ToolCall>,
    pub usage: Option<Usage>,
    pub attempts: usize,
    pub attempt_diagnostics: Vec<AttemptDiagnostic>,
    pub length_limited: bool,
    pub discarded_tool_calls: bool,
    /// Reasoning tokens the provider reported inside the output usage.
    pub reasoning_tokens: Option<usize>,
    /// Characters of streamed reasoning text, for providers that send it.
    pub reasoning_chars: usize,
    /// The request withheld its tools and was answered without their
    /// definitions (the provider refuses or ignores tool_choice "none"): its
    /// usage counts none of them.
    pub tools_dropped: bool,
}

impl Completion {
    /// Failed attempts before this successful one that may have been billed.
    pub fn billable_failed_attempts(&self) -> usize {
        self.attempts
            .saturating_sub(1)
            .saturating_sub(unbilled_attempts(&self.attempt_diagnostics))
    }
}

/// The provider may retry a request several times before returning an error.
/// Keep the attempt count for budgeting and diagnostics for successful retries
/// as well as terminal failures. Display remains the terminal error message.
#[derive(Debug)]
pub struct CompletionError {
    source: anyhow::Error,
    attempts: usize,
    transient: bool,
    attempt_diagnostics: Vec<AttemptDiagnostic>,
    tools_dropped: bool,
}
impl CompletionError {
    pub(crate) fn new(source: anyhow::Error, attempts: usize, transient: bool) -> Self {
        Self {
            source,
            attempts,
            transient,
            attempt_diagnostics: Vec::new(),
            tools_dropped: false,
        }
    }

    /// The failed request withheld its tools and was sent without their
    /// definitions, as `Completion::tools_dropped`: a size the provider
    /// states in its refusal counts none of them.
    pub fn tools_dropped(&self) -> bool {
        self.tools_dropped
    }

    pub fn attempts(&self) -> usize {
        self.attempts.max(1)
    }

    /// Attempts that may have been billed. Without diagnostics every attempt
    /// counts, so the estimate stays conservative.
    pub fn billable_attempts(&self) -> usize {
        self.attempts()
            .saturating_sub(unbilled_attempts(&self.attempt_diagnostics))
    }

    pub fn attempt_diagnostics(&self) -> &[AttemptDiagnostic] {
        &self.attempt_diagnostics
    }

    pub(crate) fn with_diagnostics(mut self, diagnostics: Vec<AttemptDiagnostic>) -> Self {
        self.attempt_diagnostics = diagnostics;
        self
    }

    /// The provider or the connection failed (overload, 5xx, timeout, a
    /// dropped stream), not the request: it may be sent again after a longer
    /// wait. A stream that failed after its text reached the user was not
    /// retried here (the text cannot be taken back from the stream); the
    /// caller takes it back from the screen and asks again.
    pub(crate) fn transient(&self) -> bool {
        self.transient
    }
}

/// A request that got no answer in time: no stream data within the request
/// timeout, a gateway timeout or an upstream idle timeout.
pub(crate) fn timeout_error(text: &str) -> bool {
    text.starts_with("request_timeout")
        || text.starts_with("http_504")
        || text.contains("\"code\":504")
        || text.to_ascii_lowercase().contains("idle timeout")
}

/// An in-stream error from an overloaded or rate-limited provider. Like a
/// timeout, it says nothing about the response format.
fn overload_error(text: &str) -> bool {
    text.contains("\"code\":429")
        || text.contains("\"code\":503")
        || text.contains("\"error_type\":\"provider_overloaded\"")
}

/// A provider's refusal of a request longer than the context it serves, as
/// OpenAI, vLLM, llama.cpp, LM Studio, OpenRouter, Anthropic, Gemini, Z.ai
/// and Text Generation Inference word it (or a proxy refusing the body's
/// size).
pub fn context_overflow(error: &str) -> bool {
    if error.starts_with("http_413") {
        return true;
    }
    if !(error.starts_with("http_4") || error.starts_with("provider_error")) {
        return false;
    }
    let text = error.to_ascii_lowercase();
    [
        "context_length_exceeded",
        "context length",
        "context window",
        "context size",
        "prompt is too long",
        "input is too long",
        "too many tokens",
        "exceeds the maximum number of tokens",
        "reduce the length of the messages",
        "maximum prompt length",
        "exceeds max length",
        "`inputs` tokens + `max_new_tokens`",
        "`inputs` must have less than",
    ]
    .iter()
    .any(|phrase| text.contains(phrase))
}

/// The prompt tokens a provider counted for a request it refused as longer
/// than its context, as its refusal states them (OpenAI, vLLM, llama.cpp,
/// LM Studio, OpenRouter, Anthropic, Gemini, Text Generation Inference) —
/// the input alone, without the output it would have reserved. No usage
/// comes back with a refusal: this is the request's only measure.
pub fn overflow_prompt_tokens(error: &str) -> Option<usize> {
    static PATTERNS: std::sync::LazyLock<Vec<regex::Regex>> = std::sync::LazyLock::new(|| {
        [
            // OpenAI and older vLLM: "(29012 in the messages, 4000 in the
            // completion)", with the tools apart when they are counted apart.
            r"(?i)\(([\d,]+) in the messages(?:, ([\d,]+) in the functions)?",
            r"(?i)your messages resulted in ([\d,]+) tokens",
            r"(?i)you requested ([\d,]+) tokens in the messages",
            r"(?i)your request has ([\d,]+) input tokens",
            // OpenRouter: "(136000 of text input, 900 of tool input, …)".
            r"(?i)\(([\d,]+) of text input(?:, ([\d,]+) of tool input)?",
            r#""n_prompt_tokens"\s*:\s*(\d+)"#,
            r"(?i)keep the first ([\d,]+) tokens",
            r"(?i)prompt is too long: ([\d,]+) tokens",
            r"(?i)input token count \(([\d,]+)\)",
            r"(?i)given: ([\d,]+) `inputs` tokens",
            r"(?i)`inputs` must have less than [\d,]+ tokens\. given: ([\d,]+)",
        ]
        .iter()
        .map(|pattern| regex::Regex::new(pattern).unwrap())
        .collect()
    });
    PATTERNS.iter().find_map(|pattern| {
        let found = pattern.captures(error)?;
        let number = |group: usize| found.get(group).and_then(|m| m.as_str().replace(',', "").parse::<usize>().ok());
        Some(number(1)?.saturating_add(number(2).unwrap_or(0)))
    })
}

/// Failures of the provider or the connection, not of the request itself.
fn transient_error(text: &str) -> bool {
    text.starts_with("provider_stream_error:")
        || text.starts_with("stream_interrupted:")
        || text.starts_with("request_timeout")
        || text.starts_with("http_429")
        || text.starts_with("http_5")
        || text.contains("error sending request")
}
impl Display for CompletionError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        self.source.fmt(f)
    }
}
impl StdError for CompletionError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        Some(self.source.as_ref())
    }
}
#[async_trait]
pub trait LlmClient: Send + Sync {
    async fn complete(
        &self,
        request: Value,
        config: &Config,
        cancel: CancellationToken,
        delta: mpsc::Sender<String>,
    ) -> Result<Completion>;
}
#[derive(Default)]
pub struct OpenAiClient;
pub(crate) const STREAM_DELTAS_MARKER: &str = "__stream_deltas";
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;
const MAX_DIAGNOSTIC_CHARS: usize = 512;

fn record_attempt_failure(
    diagnostics: &mut Vec<AttemptDiagnostic>,
    request_id: &str,
    attempt: usize,
    error: &str,
    action: AttemptAction,
    c: &Config,
) {
    // Providers sometimes echo credentials in an error body. Redact before
    // clipping so a prefix of a long key cannot leak through truncation.
    let redacted = if let Some(key) = OpenAiClient::key(c) {
        error.replace(&key, "[redacted]")
    } else {
        error.to_owned()
    };
    let prefix = redacted.split(':').next().unwrap_or("");
    let code = if !prefix.is_empty()
        && prefix.len() <= 64
        && prefix
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        prefix.to_owned()
    } else {
        "request_error".into()
    };
    let reason = redacted.chars().take(MAX_DIAGNOSTIC_CHARS).collect();
    let diagnostic = AttemptDiagnostic {
        attempt,
        code,
        reason,
        action,
    };
    // Group interleaved attempts from concurrent requests without logging the
    // request payload. JSON also keeps provider newlines on one log line.
    eprintln!(
        "[llm] {}",
        json!({"request_id":request_id,"attempt_failure":diagnostic})
    );
    diagnostics.push(diagnostic);
}

fn apply_thinking_settings(request: &mut Value, c: &Config) {
    if c.enable_thinking {
        if let Some(effort) = &c.reasoning_effort {
            request["reasoning_effort"] = json!(effort);
        }
    } else {
        // OpenAI-compatible providers, including OpenRouter/Qwen, map the
        // standard `none` effort to the model's non-thinking mode. This must
        // override a stale effort value kept in settings for re-enabling.
        request["reasoning_effort"] = json!("none");
    }
}

/// Request parameters a server may not know. They are left out for a server
/// that refuses one by name, which `apply_optional_parameters` remembers.
const OPTIONAL_PARAMETERS: [&str; 2] = ["reasoning_effort", "stream_options"];

/// Endpoints (base URL and model) with a parameter they refused by name and
/// then answered without.
static OPTIONAL_PARAMETER_REJECTED: std::sync::Mutex<SchemaCache> =
    std::sync::Mutex::new(SchemaCache(VecDeque::new()));

fn optional_parameter_key(c: &Config, parameter: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in [c.base_url.as_str(), c.model.as_str(), parameter] {
        hash.update(part.len().to_le_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize().into()
}

/// The thinking settings and usage request on `request`, without what the
/// endpoint refused before.
fn apply_optional_parameters(request: &mut Value, c: &Config, stream: bool) {
    if stream && c.stream_usage {
        request["stream_options"] = json!({"include_usage":true});
    }
    apply_thinking_settings(request, c);
    if let (Some(fields), Ok(mut rejected)) = (request.as_object_mut(), OPTIONAL_PARAMETER_REJECTED.lock()) {
        for parameter in OPTIONAL_PARAMETERS {
            if fields.contains_key(parameter) && rejected.contains(&optional_parameter_key(c, parameter)) {
                fields.remove(parameter);
            }
        }
    }
}

/// The optional parameter of `request` a refusal names: an HTTP 400 or 422
/// such as "Unrecognized request argument supplied: reasoning_effort" or
/// "Unsupported parameter: 'reasoning_effort' is not supported with this
/// model". The request is sent again without it.
fn rejected_parameter(error: &str, request: &Value) -> Option<&'static str> {
    if !(error.starts_with("http_400:") || error.starts_with("http_422:")) || context_overflow(error) {
        return None;
    }
    let error = error.to_ascii_lowercase();
    OPTIONAL_PARAMETERS
        .into_iter()
        .find(|parameter| request.get(parameter).is_some() && error.contains(parameter))
}

/// Remembers the parameters a request had to leave out to be answered.
fn remember_rejected_parameters(c: &Config, parameters: &[&str]) {
    if let Ok(mut rejected) = OPTIONAL_PARAMETER_REJECTED.lock() {
        for parameter in parameters {
            rejected.insert(optional_parameter_key(c, parameter));
        }
    }
}

/// A response whose tool calls cannot be used (arguments that are not one
/// JSON object, an empty or repeated call ID or name, too many calls):
/// nothing of it runs. The client sends the request again only while none
/// of its text has gone out; the caller may take the text back and ask again.
pub fn unusable_tool_calls(error: &str) -> bool {
    ["invalid_tool_arguments:", "malformed_tool_call:", "tool_call_batch_limit:"]
        .iter()
        .any(|code| error.starts_with(code))
}

/// A refusal of the tool calls the model wrote, not of the request: a
/// provider that validates them (Groq's `tool_use_failed`, "tool call
/// validation failed", with the `failed_generation`) refuses the request
/// with HTTP 400 when one does not match its tool. The tool it names was
/// defined well; asked again, the model may write the call right.
pub fn refused_generation(error: &str) -> bool {
    if !(error.starts_with("http_400:") || error.starts_with("http_422:")) {
        return false;
    }
    let error = error.to_ascii_lowercase();
    ["tool_use_failed", "failed_generation", "tool call validation failed"].iter().any(|said| error.contains(said))
}

fn response_format_rejected(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    // OpenAI-compatible servers do not agree on the error body: some name
    // response_format, while others return only a generic parameter 400/422.
    error.starts_with("http_400:")
        || error.starts_with("http_422:")
        || (error.starts_with("http_4")
            && (error.contains("response_format")
                || error.contains("json_object")
                || error.contains("unsupported parameter")))
}

/// Endpoints (base URL and model) that rejected strict JSON Schema output.
/// Later requests use plain JSON mode directly instead of paying a failed
/// attempt each time.
static JSON_SCHEMA_REJECTED: std::sync::Mutex<SchemaCache> =
    std::sync::Mutex::new(SchemaCache(VecDeque::new()));

/// Some providers fail a particular strict grammar inside an otherwise valid
/// SSE response. Remember only a successful JSON-mode recovery, per schema;
/// a provider outage alone must not disable all structured output.
static JSON_SCHEMA_STREAM_RECOVERED: std::sync::Mutex<SchemaCache> =
    std::sync::Mutex::new(SchemaCache(VecDeque::new()));

/// Schemas recovered by JSON mode once. An outage that clears before the
/// comparison attempt looks the same as a grammar failure (a live run lost
/// strict output for a whole run after three in-stream 502s), so a schema
/// moves to JSON_SCHEMA_STREAM_RECOVERED only when a second request needs the
/// same recovery; a strict response that succeeds clears the suspicion.
static JSON_SCHEMA_STREAM_SUSPECTED: std::sync::Mutex<SchemaCache> =
    std::sync::Mutex::new(SchemaCache(VecDeque::new()));

/// Endpoints (base URL and model) that rejected every response_format,
/// strict schema and plain JSON mode alike. Recorded only after the same
/// request then succeeded without one, so an unrelated 400 cannot disable
/// JSON mode. A live run otherwise paid a failed attempt on every structured call.
static RESPONSE_FORMAT_REJECTED: std::sync::Mutex<SchemaCache> =
    std::sync::Mutex::new(SchemaCache(VecDeque::new()));

/// Endpoints where tool_choice "none" does not withhold tools: a request with
/// it was refused and then succeeded without the tools, or the model still
/// called tools. Their withheld requests leave the tools out instead (the
/// prompt then loses the prefix the provider cached with them).
static TOOL_CHOICE_NONE_UNSUPPORTED: std::sync::Mutex<SchemaCache> =
    std::sync::Mutex::new(SchemaCache(VecDeque::new()));

/// Endpoints that do not apply an output limit sent as
/// `max_completion_tokens` (Ollama reads only `max_tokens`): a reply's answer
/// went past it. Their later requests send the limit as `max_tokens`.
static COMPLETION_LIMIT_IGNORED: std::sync::Mutex<SchemaCache> =
    std::sync::Mutex::new(SchemaCache(VecDeque::new()));

/// Tokens an answer may run past the limit without showing it was ignored
/// (a server that counts the end token, rounding).
const OUTPUT_LIMIT_SLACK: usize = 16;

/// The name the output limit is sent under: `max_tokens` when the settings
/// ask for it or the endpoint showed it ignores `max_completion_tokens`.
fn output_limit_field(c: &Config) -> &'static str {
    let ignored = COMPLETION_LIMIT_IGNORED
        .lock()
        .is_ok_and(|mut ignored| ignored.contains(&schema_endpoint(c)));
    if c.legacy_max_tokens || ignored {
        "max_tokens"
    } else {
        "max_completion_tokens"
    }
}

/// A request that withholds its tools with tool_choice "none".
fn withholds_tools(request: &Value) -> bool {
    request["tool_choice"] == "none"
}

fn drop_withheld_tools(request: &mut Value) {
    if let Some(fields) = request.as_object_mut() {
        fields.remove("tools");
        fields.remove("tool_choice");
    }
}

struct SchemaCache(VecDeque<[u8; 32]>);
impl SchemaCache {
    const MAX_ENTRIES: usize = 128;

    fn contains(&mut self, key: &[u8; 32]) -> bool {
        let Some(index) = self.0.iter().position(|known| known == key) else {
            return false;
        };
        let key = self.0.remove(index).unwrap();
        self.0.push_back(key);
        true
    }

    fn remove(&mut self, key: &[u8; 32]) -> bool {
        let Some(index) = self.0.iter().position(|known| known == key) else {
            return false;
        };
        self.0.remove(index);
        true
    }

    fn insert(&mut self, key: [u8; 32]) {
        if self.contains(&key) {
            return;
        }
        if self.0.len() == Self::MAX_ENTRIES {
            self.0.pop_front();
        }
        self.0.push_back(key);
    }
}

fn schema_endpoint(c: &Config) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in [&c.base_url, &c.model] {
        hash.update(part.len().to_le_bytes());
        hash.update(part.as_bytes());
    }
    hash.finalize().into()
}

fn schema_cache_key(c: &Config, format: &Value) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(schema_endpoint(c));
    hash.update(format.to_string().as_bytes());
    hash.finalize().into()
}

/// Record how a strict-schema request finished. A JSON-mode recovery after
/// the SSE fallback caches the schema only when the same schema already
/// needed it on an earlier request; a strict success clears that suspicion.
fn note_schema_stream_result(key: &[u8; 32], request: &Value, stream_fallback: bool) {
    let Ok(mut suspected) = JSON_SCHEMA_STREAM_SUSPECTED.lock() else {
        return;
    };
    match request["response_format"]["type"].as_str() {
        Some("json_schema") => {
            suspected.remove(key);
        }
        Some("json_object") if stream_fallback => {
            if suspected.remove(key) {
                if let Ok(mut recovered) = JSON_SCHEMA_STREAM_RECOVERED.lock() {
                    recovered.insert(*key);
                }
            } else {
                suspected.insert(*key);
            }
        }
        _ => {}
    }
}

fn downgrade_json_schema(request: &mut Value) -> bool {
    if request["response_format"]["type"] != "json_schema" {
        return false;
    }
    request["response_format"] = json!({"type":"json_object"});
    true
}

#[derive(Default)]
pub struct SseDecoder {
    line: Vec<u8>,
    data: String,
    event_bytes: usize,
    skip_lf: bool,
    started: bool,
    has_data: bool,
}
impl SseDecoder {
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>> {
        let mut result = vec![];
        for &byte in bytes {
            if let Some(event) = self.feed_byte(byte)? {
                result.push(event);
            }
        }
        Ok(result)
    }

    // Deliver each event before decoding later bytes so a consumer can stop
    // at its terminator, even when the rest of that HTTP chunk is malformed.
    fn feed_byte(&mut self, byte: u8) -> Result<Option<String>> {
        // SSE permits CR, LF and CRLF, including a split CRLF.
        if self.skip_lf {
            self.skip_lf = false;
            if byte == b'\n' {
                return Ok(None);
            }
        }
        self.event_bytes += 1;
        if self.event_bytes > MAX_COMPLETION_BYTES {
            bail!("response_size_limit: SSE event too large");
        }
        if matches!(byte, b'\r' | b'\n') {
            let event = self.finish_line()?;
            self.skip_lf = byte == b'\r';
            Ok(event)
        } else {
            self.line.push(byte);
            Ok(None)
        }
    }

    fn finish_line(&mut self) -> Result<Option<String>> {
        let mut line = std::str::from_utf8(&self.line)?;
        if !self.started {
            line = line.strip_prefix('\u{feff}').unwrap_or(line);
            self.started = true;
        }
        let mut event = None;
        if line.is_empty() {
            if self.has_data {
                self.data.pop(); // Remove only the final data-line delimiter.
                event = Some(std::mem::take(&mut self.data));
                self.has_data = false;
            }
            self.event_bytes = 0;
        } else {
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            if field == "data" {
                self.data.push_str(value.strip_prefix(' ').unwrap_or(value));
                self.data.push('\n');
                self.has_data = true;
            }
        }
        self.line.clear();
        Ok(event)
    }
}
/// How long a connection back from a request waits for the next one before
/// it is closed. Under the 5 s most servers keep an idle connection open
/// (uvicorn, which vLLM runs on, Node, llama.cpp's server; Node's own client
/// keeps 4 s), so a request does not take a connection as the server closes
/// it.
pub(crate) const IDLE_CONNECTION_TTL: Duration = Duration::from_secs(4);
/// How long the end of a streamed response is read for after its [DONE].
const STREAM_END_WAIT: Duration = Duration::from_secs(1);

/// HTTP clients kept so that a request takes the connection the previous
/// one left. A client made for each request opened and closed a connection
/// of its own every time: a TCP and TLS handshake and a DNS lookup (on a
/// thread of its own) per request, and a socket left in TIME_WAIT. Kept by
/// runtime, whose tasks run a client's connections, and by `K`; the last few.
pub(crate) struct ClientCache<K>(std::sync::Mutex<VecDeque<(ClientKey<K>, reqwest::Client)>>);
type ClientKey<K> = (Option<tokio::runtime::Id>, K);
impl<K: PartialEq> ClientCache<K> {
    const MAX_CLIENTS: usize = 4;

    pub(crate) const fn new() -> Self {
        Self(std::sync::Mutex::new(VecDeque::new()))
    }

    /// The client for `key`, made by `build` when none is kept.
    pub(crate) fn get(&self, key: K, build: impl FnOnce() -> reqwest::Result<reqwest::Client>) -> reqwest::Result<reqwest::Client> {
        let key = (tokio::runtime::Handle::try_current().ok().map(|runtime| runtime.id()), key);
        let mut clients = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(at) = clients.iter().position(|(known, _)| *known == key) {
            let entry = clients.remove(at).unwrap();
            let client = entry.1.clone();
            clients.push_back(entry);
            return Ok(client);
        }
        let client = build()?;
        if clients.len() == Self::MAX_CLIENTS {
            clients.pop_front();
        }
        clients.push_back((key, client.clone()));
        Ok(client)
    }
}

/// The clients of LLM requests, by proxy setting (a settings check may try
/// another).
static CLIENTS: ClientCache<(bool, Option<String>)> = ClientCache::new();

impl OpenAiClient {
    fn client(c: &Config) -> Result<reqwest::Client> {
        let proxy = if c.disable_proxy { None } else { c.proxy.clone().filter(|p| !p.trim().is_empty()) };
        Ok(CLIENTS.get((c.disable_proxy, proxy.clone()), || {
            let mut b = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .pool_idle_timeout(IDLE_CONNECTION_TTL)
                .dns_resolver(Arc::new(dns::SystemDns::default()));
            if c.disable_proxy {
                b = b.no_proxy();
            } else if let Some(proxy) = &proxy {
                b = b.proxy(reqwest::Proxy::all(proxy)?)
            }
            b.build()
        })?)
    }
    pub fn has_key(c: &Config) -> bool {
        Self::key(c).is_some()
    }
    fn key(c: &Config) -> Option<String> {
        c.api_key
            .as_ref()
            .map(|s| s.0.clone())
            .filter(|value| !value.trim().is_empty())
    }
    async fn attempt(
        &self,
        mut request: Value,
        c: &Config,
        cancel: CancellationToken,
        delta: mpsc::Sender<String>,
        emitted_text: Arc<AtomicBool>,
        stream_deltas: bool,
    ) -> Result<Completion> {
        request["stream"] = json!(true);
        request[output_limit_field(c)] = json!(c.output_tokens);
        let mut req = Self::client(c)?.post(c.completion_url()?).json(&request);
        if let Some(key) = Self::key(c) {
            req = req.bearer_auth(key)
        }
        // request_timeout_secs bounds waiting for response headers and each
        // silent gap in the stream, not the whole response: a long reasoning
        // answer that keeps streaming (or sends keepalives) is not cut off.
        // The run deadline bounds total duration.
        let idle = Duration::from_secs(c.request_timeout_secs);
        let response = tokio::select! {
            _ = cancel.cancelled() => bail!("cancelled"),
            r = tokio::time::timeout(idle, req.send()) => r.map_err(|_| {
                anyhow::anyhow!("request_timeout: no response within {}s", c.request_timeout_secs)
            })??,
        };
        if !response.status().is_success() {
            let status = response.status();
            // Error responses can have a slow or unbounded body too. Keep
            // cancellation responsive while collecting a bounded diagnostic.
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while bytes.len() < MAX_ERROR_BODY_BYTES {
                let next = tokio::select! {
                    _ = cancel.cancelled() => bail!("cancelled"),
                    chunk = tokio::time::timeout(idle, stream.next()) => chunk,
                };
                let Ok(Some(chunk)) = next else {
                    break;
                };
                let Ok(chunk) = chunk else { break };
                let remaining = MAX_ERROR_BODY_BYTES - bytes.len();
                bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            }
            let body = String::from_utf8_lossy(&bytes).into_owned();
            bail!(
                "http_{}: {}",
                status.as_u16(),
                body.chars().take(1000).collect::<String>()
            );
        }
        let mut stream = response.bytes_stream();
        let mut parser = SseDecoder::default();
        let mut out = Completion::default();
        let mut calls: BTreeMap<usize, ToolCall> = BTreeMap::new();
        let mut done = false;
        let mut finish_reason: Option<String> = None;
        let mut expects_calls = false;
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => bail!("cancelled"),
                chunk = tokio::time::timeout(idle, stream.next()) => chunk.map_err(|_| {
                    anyhow::anyhow!("request_timeout: no stream data for {}s", c.request_timeout_secs)
                })?,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|e| anyhow::anyhow!("stream_interrupted: {e}"))?;
            for &byte in chunk.iter() {
                let Some(event) = parser.feed_byte(byte)? else {
                    continue;
                };
                if event.is_empty() {
                    continue;
                }
                if event == "[DONE]" {
                    done = true;
                    break;
                }
                let v: Value = serde_json::from_str(&event)
                    .map_err(|e| anyhow::anyhow!("invalid_stream_event: {e}"))?;
                if !v["error"].is_null() {
                    // Gateways such as OpenRouter open the stream with 200 and
                    // report an upstream overload or rate limit as an error
                    // event. Classify it like the matching HTTP status so the
                    // transient retry applies; other errors stay terminal.
                    let code = v["error"]["code"]
                        .as_u64()
                        .or_else(|| v["error"]["code"].as_str().and_then(|c| c.parse().ok()));
                    if code.is_some_and(|code| code == 429 || (500..600).contains(&code)) {
                        // Before any output, tool call or usage arrived the
                        // gateway refused as an HTTP status would have, so
                        // nothing was generated or billed. A live run charged
                        // two such 503 events as full request inputs.
                        let unstarted = out.text.is_empty()
                            && calls.is_empty()
                            && out.usage.is_none()
                            && out.reasoning_chars == 0
                            && finish_reason.is_none();
                        if unstarted {
                            bail!("provider_stream_error: {UNSTARTED_STREAM} {}", v["error"]);
                        }
                        bail!("provider_stream_error: {}", v["error"]);
                    }
                    bail!("provider_error: {}", v["error"]);
                }
                if let Some(u) = v.get("usage").filter(|u| !u.is_null())
                    && let (Some(input), Some(output)) =
                        (u["prompt_tokens"].as_u64(), u["completion_tokens"].as_u64())
                {
                    out.usage = Some(Usage {
                        input: input as usize,
                        output: output as usize,
                        cached: u["prompt_tokens_details"]["cached_tokens"]
                            .as_u64()
                            .map(|n| n as usize),
                    });
                    out.reasoning_tokens = u["completion_tokens_details"]["reasoning_tokens"]
                        .as_u64()
                        .map(|n| n as usize);
                }
                let Some(choice) = v["choices"].as_array().and_then(|a| a.first()) else {
                    continue;
                };
                if finish_reason.is_some()
                    && (choice["delta"]["content"]
                        .as_str()
                        .is_some_and(|text| !text.is_empty())
                        || choice["delta"]["tool_calls"]
                            .as_array()
                            .is_some_and(|calls| !calls.is_empty()))
                {
                    bail!("incomplete_completion: delta after finish reason");
                }
                if let Some(reason) = choice["finish_reason"].as_str() {
                    if let Some(previous) = finish_reason.as_deref() {
                        if previous != reason {
                            bail!(
                                "incomplete_completion: multiple finish reasons ({previous}, {reason})"
                            );
                        }
                    } else {
                        if !["stop", "tool_calls", "length"].contains(&reason) {
                            if reason == "error" {
                                bail!("provider_stream_error: finish_reason=error");
                            }
                            bail!("incomplete_completion: {reason}");
                        }
                        out.length_limited = reason == "length";
                        expects_calls = reason == "tool_calls";
                        finish_reason = Some(reason.to_owned());
                    }
                }
                // OpenRouter streams reasoning as `reasoning`; others use
                // `reasoning_content`. Only its size is kept.
                if let Some(reasoning) = choice["delta"]["reasoning"]
                    .as_str()
                    .or_else(|| choice["delta"]["reasoning_content"].as_str())
                {
                    out.reasoning_chars += reasoning.chars().count();
                }
                if let Some(text) = choice["delta"]["content"].as_str() {
                    out.text.push_str(text);
                    if stream_deltas
                        && delta.send(text.to_string()).await.is_ok()
                        && !text.is_empty()
                    {
                        emitted_text.store(true, Ordering::Relaxed);
                    }
                }
                if let Some(entries) = choice["delta"]["tool_calls"].as_array() {
                    for call in entries {
                        let index = call["index"]
                            .as_u64()
                            .ok_or_else(|| anyhow::anyhow!("tool call missing index"))?
                            as usize;
                        let target = calls.entry(index).or_insert(ToolCall {
                            id: String::new(),
                            name: String::new(),
                            arguments: String::new(),
                        });
                        if let Some(id) = call["id"].as_str() {
                            target.id = id.into();
                        }
                        if let Some(name) = call["function"]["name"].as_str() {
                            target.name.push_str(name);
                        }
                        if let Some(args) = call["function"]["arguments"].as_str() {
                            target.arguments.push_str(args);
                        }
                        if target.id.len() > MAX_TOOL_CALL_ID_BYTES
                            || target.name.len() > MAX_TOOL_NAME_BYTES
                        {
                            bail!("malformed_tool_call: call ID or name is too long");
                        }
                    }
                }
                if calls.len() > MAX_TOOL_CALLS {
                    bail!("tool_call_batch_limit: at most {MAX_TOOL_CALLS} calls");
                }
                let bytes = calls.values().fold(out.text.len(), |bytes, call| {
                    bytes
                        .saturating_add(call.id.len())
                        .saturating_add(call.name.len())
                        .saturating_add(call.arguments.len())
                });
                if bytes > MAX_COMPLETION_BYTES {
                    bail!("response_size_limit");
                }
            }
            if done {
                break;
            }
        }
        if done {
            // The response's end follows [DONE], often a moment later: read
            // apart, so its connection goes back for the next request without
            // the answer waiting (a response dropped unread closes it).
            tokio::spawn(async move {
                let _ = tokio::time::timeout(STREAM_END_WAIT, async { while let Some(Ok(_)) = stream.next().await {} }).await;
            });
        }
        if !done || finish_reason.is_none() {
            bail!("stream_interrupted: missing completion terminator");
        }
        if out.length_limited {
            // A length-limited batch may contain syntactically valid but unfinished
            // instructions. Never expose any of its calls for execution.
            out.discarded_tool_calls = !calls.is_empty();
            return Ok(out);
        }
        if expects_calls && calls.is_empty() {
            bail!("incomplete_completion: tool_calls finish without a call");
        }
        // Some OpenAI-compatible providers finish a complete tool-call
        // response with `stop` instead of `tool_calls`. The calls are still
        // checked for IDs, names and complete JSON objects below before the
        // agent can use them.
        let mut ids = std::collections::BTreeSet::new();
        for call in calls.values_mut() {
            // Providers send "" for a call without arguments; that is an
            // empty object, so the executor can name any required field.
            if call.arguments.trim().is_empty() {
                call.arguments = "{}".into();
            }
            if call.id.is_empty() || call.name.is_empty() {
                bail!(
                    "malformed_tool_call: a tool call has an empty {}; every call needs a unique ID and an exact tool name",
                    if call.id.is_empty() {
                        "ID"
                    } else {
                        "tool name"
                    }
                );
            }
            if !ids.insert(call.id.clone()) {
                bail!(
                    "malformed_tool_call: call ID {:?} is used by more than one call in this response; call IDs must be unique",
                    call.id
                );
            }
            let _: serde_json::Map<String, Value> =
                serde_json::from_str(&call.arguments).map_err(|e| {
                    anyhow::anyhow!(
                        "invalid_tool_arguments: {} arguments are not one complete JSON object ({e}); use double-quoted property names and close every string, array and object",
                        call.name
                    )
                })?;
        }
        out.calls = calls.into_values().collect();
        validate_completion_bounds(&out)?;
        Ok(out)
    }
    pub async fn probe(&self, c: &Config) -> Result<String> {
        c.runnable()?;
        // The request timeout measures silence. A server that keeps sending
        // SSE comments can otherwise keep a connection check alive forever.
        let timeout_secs = c.request_timeout_secs.saturating_mul(3);
        tokio::time::timeout(Duration::from_secs(timeout_secs), self.probe_roundtrip(c))
            .await
            .map_err(|_| {
                anyhow::anyhow!("connection_probe_timeout: check exceeded {timeout_secs}s")
            })?
    }
    /// The body of a plain (non-streaming) answer as JSON.
    async fn read_plain_answer(response: reqwest::Response, c: &Config) -> Result<Value> {
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) =
            tokio::time::timeout(Duration::from_secs(c.request_timeout_secs), stream.next())
                .await
                .map_err(|_| {
                    anyhow::anyhow!("plain response probe failed: response body timeout")
                })?
        {
            let chunk =
                chunk.map_err(|error| anyhow::anyhow!("plain response probe failed: {error}"))?;
            if bytes.len().saturating_add(chunk.len()) > MAX_COMPLETION_BYTES {
                bail!("plain response probe failed: response_size_limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|error| {
            anyhow::anyhow!("plain response probe failed: invalid JSON: {error}")
        })
    }
    async fn probe_roundtrip(&self, c: &Config) -> Result<String> {
        let mut body = json!({"model":c.model,"messages":[{"role":"user","content":"Reply OK"}],"stream":false});
        body[output_limit_field(c)] = json!(c.output_tokens);
        apply_optional_parameters(&mut body, c, false);
        let mut left_out: Vec<&str> = vec![];
        let mut transient_retries = 0usize;
        // As a chat request does, an overloaded or rate-limited provider is
        // asked again; the free models of a gateway often are for a while.
        loop {
            let mut req = Self::client(c)?.post(c.completion_url()?).json(&body);
            if let Some(k) = Self::key(c) {
                req = req.bearer_auth(k)
            }
            let response =
                tokio::time::timeout(Duration::from_secs(c.request_timeout_secs), req.send()).await??;
            let status = response.status();
            let problem = if status.is_success() {
                // HTTP 200 alone can be an HTML proxy page or a provider
                // error. Read and validate the plain answer before testing
                // streaming/tool support.
                let answer = Self::read_plain_answer(response, c).await?;
                match plain_answer_problem(&answer) {
                    None => break,
                    Some(problem) => problem,
                }
            } else {
                // Read as far as a chat request reads a refusal: the whole
                // body, which a server may make as large as it likes, was
                // taken in before it was cut.
                let detail = tokio::time::timeout(Duration::from_secs(c.request_timeout_secs), async {
                    let mut stream = response.bytes_stream();
                    let mut bytes = Vec::new();
                    while bytes.len() < MAX_ERROR_BODY_BYTES
                        && let Some(Ok(chunk)) = stream.next().await
                    {
                        bytes.extend_from_slice(&chunk[..chunk.len().min(MAX_ERROR_BODY_BYTES - bytes.len())]);
                    }
                    String::from_utf8_lossy(&bytes).chars().take(1000).collect::<String>()
                })
                .await
                .unwrap_or_default();
                let refusal = format!("http_{}: {detail}", status.as_u16());
                // As a chat request does: an optional parameter refused by
                // name is left out.
                if let Some(parameter) = rejected_parameter(&refusal, &body) {
                    body.as_object_mut().unwrap().remove(parameter);
                    left_out.push(parameter);
                    continue;
                }
                format!("http_{}: {}", status.as_u16(), detail.chars().take(300).collect::<String>())
            };
            if transient_error(&problem) && transient_retries < c.retries {
                transient_retries = transient_retries.saturating_add(1);
                tokio::time::sleep(Duration::from_millis(500 * (1 << transient_retries.min(5)))).await;
                continue;
            }
            bail!("plain response probe failed: {problem}");
        }
        remember_rejected_parameters(c, &left_out);
        let (tx, mut rx) = mpsc::channel(32);
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        let tool = json!({"type":"function","function":{"name":"connection_echo","description":"Return the supplied text","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}});
        let mut request = json!({"model":c.model,"messages":[{"role":"user","content":"Call connection_echo with text OK"}],"tools":[tool],"tool_choice":{"type":"function","function":{"name":"connection_echo"}}});
        let completion = self
            .complete(request.clone(), c, CancellationToken::new(), tx.clone())
            .await?;
        if completion.calls.len() != 1 || completion.calls[0].name != "connection_echo" {
            bail!("tool probe did not return expected call");
        }
        let arguments: Value = serde_json::from_str(&completion.calls[0].arguments)?;
        if arguments["text"].as_str() != Some("OK") {
            bail!("tool probe did not return the requested text argument");
        }
        request.as_object_mut().unwrap().remove("tool_choice");
        let call = &completion.calls[0];
        request["messages"].as_array_mut().unwrap().extend([json!({"role":"assistant","content":null,"tool_calls":[{"id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments}}]}),json!({"role":"tool","tool_call_id":call.id,"content":"OK"})]);
        let final_response = self
            .complete(request, c, CancellationToken::new(), tx)
            .await?;
        if final_response.length_limited {
            bail!("incomplete_completion: length during connection probe");
        }
        if !final_response.calls.is_empty() || final_response.text.trim().is_empty() {
            bail!("tool round-trip probe failed: expected a complete text response without tools");
        }
        Ok("Plain response, SSE streaming and tool round-trip succeeded".into())
    }
}

/// Why a plain (non-streaming) answer is no complete text response, if it is
/// none. An `error` object under HTTP 200 is how gateways such as OpenRouter
/// relay an upstream overload or rate limit ("Upstream error from Nvidia:
/// Service temporarily overloaded", code 503); it is worded like the HTTP
/// status it stands for, so [`transient_error`] tells it from a refusal.
fn plain_answer_problem(answer: &Value) -> Option<String> {
    let clip = |text: &str| text.chars().take(300).collect::<String>();
    if !answer["error"].is_null() {
        let error = &answer["error"];
        let message = clip(error["message"].as_str().map_or_else(|| error.to_string(), str::to_owned).as_str());
        let code = error["code"]
            .as_u64()
            .or_else(|| error["code"].as_str().and_then(|code| code.parse().ok()));
        return Some(match code {
            Some(code) => format!("http_{code}: {message}"),
            None => format!("provider_error: {message}"),
        });
    }
    let Some(choice) = answer["choices"].as_array().and_then(|choices| choices.first()) else {
        return Some(format!("no choices in the answer: {}", clip(&answer.to_string())));
    };
    let message = &choice["message"];
    if message["tool_calls"].as_array().is_some_and(|calls| !calls.is_empty()) {
        return Some("the answer is a tool call, not text".into());
    }
    match choice["finish_reason"].as_str() {
        Some("stop") => {}
        Some("length") => {
            return Some(
                "the answer was cut at the output limit (finish_reason=length); raise the output tokens or lower the reasoning effort".into(),
            );
        }
        other => return Some(format!("finish_reason={} (expected stop)", other.unwrap_or("missing"))),
    }
    if message["content"].as_str().is_none_or(|text| text.trim().is_empty()) {
        let reasoned = ["reasoning", "reasoning_content"]
            .into_iter()
            .any(|field| message[field].as_str().is_some_and(|text| !text.trim().is_empty()));
        return Some(if reasoned {
            "the answer has reasoning but no text".into()
        } else {
            "the answer has no text".into()
        });
    }
    None
}

#[async_trait]
impl LlmClient for OpenAiClient {
    async fn complete(
        &self,
        mut request: Value,
        c: &Config,
        cancel: CancellationToken,
        delta: mpsc::Sender<String>,
    ) -> Result<Completion> {
        // The client is also called directly (outside the agent's guards).
        c.validate()?;
        if !request.is_object() {
            bail!("invalid_request: completion request must be a JSON object");
        }
        let stream_deltas = request
            .get(STREAM_DELTAS_MARKER)
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if let Some(fields) = request.as_object_mut() {
            fields.remove(STREAM_DELTAS_MARKER);
        }
        let schema_key = (request["response_format"]["type"] == "json_schema")
            .then(|| schema_cache_key(c, &request["response_format"]));
        if JSON_SCHEMA_REJECTED
            .lock()
            .is_ok_and(|mut rejected| rejected.contains(&schema_endpoint(c)))
            || schema_key.as_ref().is_some_and(|key| {
                JSON_SCHEMA_STREAM_RECOVERED
                    .lock()
                    .is_ok_and(|mut recovered| recovered.contains(key))
            })
        {
            downgrade_json_schema(&mut request);
        }
        let format_rejected = request.get("response_format").is_some()
            && RESPONSE_FORMAT_REJECTED
                .lock()
                .is_ok_and(|mut rejected| rejected.contains(&schema_endpoint(c)));
        if format_rejected && let Some(fields) = request.as_object_mut() {
            fields.remove("response_format");
        }
        apply_optional_parameters(&mut request, c, true);
        let mut parameters_left_out: Vec<&str> = vec![];
        let withheld = withholds_tools(&request);
        if withheld
            && TOOL_CHOICE_NONE_UNSUPPORTED
                .lock()
                .is_ok_and(|mut unsupported| unsupported.contains(&schema_endpoint(c)))
        {
            drop_withheld_tools(&mut request);
        }
        let mut tool_choice_fallback = false;
        let emitted_text = Arc::new(AtomicBool::new(false));
        let mut attempt = 0usize;
        // The optional response-format fallback is a compatibility attempt,
        // not one of the configured transient retries. Keep its attempt in
        // the usage accounting, but track retry budget separately so a
        // fallback cannot either consume all retries or make retries=0 loop
        // forever after a subsequent 429/5xx response.
        let mut transient_retries = 0usize;
        let mut response_format_fallback = format_rejected;
        let mut schema_stream_fallback = false;
        let request_id = uuid::Uuid::new_v4().to_string();
        let mut attempt_diagnostics = Vec::new();
        loop {
            // Cancellation must cover every await inside an attempt, including
            // response-body reads and backpressure on the delta channel.
            let result = tokio::select! {
                biased;
                _ = cancel.cancelled() => bail!("cancelled"),
                result = self.attempt(
                    request.clone(),
                    c,
                    cancel.clone(),
                    delta.clone(),
                    emitted_text.clone(),
                    stream_deltas,
                ) => result,
            };
            match result {
                Ok(mut r) => {
                    if let Some(key) = &schema_key {
                        note_schema_stream_result(key, &request, schema_stream_fallback);
                    }
                    // This request recovered by dropping a rejected format.
                    if response_format_fallback
                        && !format_rejected
                        && let Ok(mut rejected) = RESPONSE_FORMAT_REJECTED.lock()
                    {
                        rejected.insert(schema_endpoint(c));
                    }
                    // Recovered without the tools it refused to withhold, or
                    // called tools it was told not to call.
                    let ignored = withholds_tools(&request) && (!r.calls.is_empty() || r.discarded_tool_calls);
                    if (tool_choice_fallback || ignored)
                        && let Ok(mut unsupported) = TOOL_CHOICE_NONE_UNSUPPORTED.lock()
                    {
                        unsupported.insert(schema_endpoint(c));
                    }
                    remember_rejected_parameters(c, &parameters_left_out);
                    // An answer past the limit sent as max_completion_tokens
                    // shows the server never applied it (reasoning a
                    // provider reports apart may run past an answer's limit).
                    if let Some(usage) = &r.usage
                        && output_limit_field(c) == "max_completion_tokens"
                        && usage.output.saturating_sub(r.reasoning_tokens.unwrap_or(0)) > c.output_tokens.saturating_add(OUTPUT_LIMIT_SLACK)
                        && let Ok(mut ignored) = COMPLETION_LIMIT_IGNORED.lock()
                    {
                        eprintln!(
                            "[llm] {} wrote {} tokens, past max_completion_tokens {}: the limit goes as max_tokens from now on",
                            c.model, usage.output, c.output_tokens
                        );
                        ignored.insert(schema_endpoint(c));
                    }
                    r.tools_dropped = withheld && request.get("tools").is_none();
                    r.attempts = attempt.saturating_add(1);
                    r.attempt_diagnostics = attempt_diagnostics;
                    return Ok(r);
                }
                Err(e) => {
                    let text = e.to_string();
                    // An optional parameter the server does not know, named
                    // in its refusal: sent again without it, and left out for
                    // this endpoint once that is answered.
                    if let Some(parameter) = rejected_parameter(&text, &request) {
                        if let Some(fields) = request.as_object_mut() {
                            fields.remove(parameter);
                        }
                        parameters_left_out.push(parameter);
                        record_attempt_failure(
                            &mut attempt_diagnostics,
                            &request_id,
                            attempt.saturating_add(1),
                            &text,
                            AttemptAction::ParameterFallback,
                            c,
                        );
                        attempt = attempt.saturating_add(1);
                        continue;
                    }
                    // Not every provider takes tool_choice "none" (some accept
                    // only "auto"): a refused request is sent once more
                    // without the withheld tools, and the endpoint is
                    // remembered only if that succeeds. A refusal for its size
                    // stays the caller's to handle.
                    if !tool_choice_fallback
                        && withholds_tools(&request)
                        && (text.starts_with("http_400:") || text.starts_with("http_422:"))
                        && !context_overflow(&text)
                    {
                        drop_withheld_tools(&mut request);
                        tool_choice_fallback = true;
                        record_attempt_failure(
                            &mut attempt_diagnostics,
                            &request_id,
                            attempt.saturating_add(1),
                            &text,
                            AttemptAction::ToolChoiceFallback,
                            c,
                        );
                        attempt = attempt.saturating_add(1);
                        continue;
                    }
                    // OpenAI-compatible local servers are not uniform about
                    // JSON mode. Retry once without the optional structured
                    // output hint when the server explicitly rejects it;
                    // finish() still validates the returned object.
                    // Strict schemas degrade to plain JSON mode first, then to
                    // no response format; each step is one compatibility attempt.
                    if request.get("response_format").is_some()
                        && response_format_rejected(&text)
                        && downgrade_json_schema(&mut request)
                    {
                        if let Ok(mut rejected) = JSON_SCHEMA_REJECTED.lock() {
                            rejected.insert(schema_endpoint(c));
                        }
                        record_attempt_failure(
                            &mut attempt_diagnostics,
                            &request_id,
                            attempt.saturating_add(1),
                            &text,
                            AttemptAction::JsonModeFallback,
                            c,
                        );
                        attempt = attempt.saturating_add(1);
                        continue;
                    }
                    if !response_format_fallback
                        && request.get("response_format").is_some()
                        && response_format_rejected(&text)
                    {
                        request
                            .as_object_mut()
                            .expect("request was validated as an object")
                            .remove("response_format");
                        response_format_fallback = true;
                        record_attempt_failure(
                            &mut attempt_diagnostics,
                            &request_id,
                            attempt.saturating_add(1),
                            &text,
                            AttemptAction::UnstructuredFallback,
                            c,
                        );
                        attempt = attempt.saturating_add(1);
                        continue;
                    }
                    // A dropped connection or missing terminator is transient
                    // too. Retrying is safe only before any text reached the
                    // user; the partial response is discarded, never merged.
                    let silent = !emitted_text.load(Ordering::Relaxed);
                    let transient = transient_error(&text);
                    // A follow-up answer is asked again with a smaller request
                    // instead; another attempt would wait out the same timeout.
                    let unanswered = !c.retry_timeouts && timeout_error(&text);
                    // Exhaust ordinary transient retries first, then make one
                    // compatibility attempt for an SSE grammar failure. The
                    // caller still validates the complete response schema.
                    // An overload is no grammar failure: after three Nvidia
                    // "Service temporarily overloaded" errors, a live run's
                    // JSON-mode attempt returned an unfinished `{"issues":{}`.
                    if silent
                        && !unanswered
                        && !overload_error(&text)
                        && !schema_stream_fallback
                        && text.starts_with("provider_stream_error:")
                        && transient_retries >= c.retries
                        && downgrade_json_schema(&mut request)
                    {
                        schema_stream_fallback = true;
                        record_attempt_failure(
                            &mut attempt_diagnostics,
                            &request_id,
                            attempt.saturating_add(1),
                            &text,
                            AttemptAction::JsonModeFallback,
                            c,
                        );
                        attempt = attempt.saturating_add(1);
                        continue;
                    }
                    let retry = silent
                        && !unanswered
                        && (transient
                            || (attempt == 0 && text.starts_with("invalid_tool_arguments:"))
                            || (attempt == 0 && text.starts_with("invalid_stream_event:")));
                    if !retry || transient_retries >= c.retries {
                        record_attempt_failure(
                            &mut attempt_diagnostics,
                            &request_id,
                            attempt.saturating_add(1),
                            &text,
                            AttemptAction::Stop,
                            c,
                        );
                        let mut failure = CompletionError::new(
                            e,
                            attempt.saturating_add(1),
                            transient,
                        )
                        .with_diagnostics(attempt_diagnostics);
                        failure.tools_dropped = withheld && request.get("tools").is_none();
                        return Err(failure.into());
                    }
                    record_attempt_failure(
                        &mut attempt_diagnostics,
                        &request_id,
                        attempt.saturating_add(1),
                        &text,
                        AttemptAction::Retry,
                        c,
                    );
                    transient_retries = transient_retries.saturating_add(1);
                    attempt = attempt.saturating_add(1);
                    tokio::select! {_=cancel.cancelled()=>bail!("cancelled"),_=tokio::time::sleep(Duration::from_millis(500*(1<<attempt.min(5))))=>{}}
                }
            }
        }
    }
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    use crate::config::Secret;

    #[test]
    fn provider_diagnostics_redact_credentials_before_clipping() {
        let key = "test_api_key";
        let config = Config {
            api_key: Some(Secret(key.into())),
            ..Config::default()
        };
        let mut diagnostics = Vec::new();
        for error in [
            format!("http_503: rejected {key}\n{}", "긴 오류 메시지".repeat(150)),
            key.into(),
        ] {
            record_attempt_failure(
                &mut diagnostics,
                "redaction-test",
                1,
                &error,
                AttemptAction::Retry,
                &config,
            );
        }
        assert!(!json!(diagnostics).to_string().contains(key));
        assert!(
            diagnostics[0]
                .reason
                .starts_with("http_503: rejected [redacted]")
        );
        assert_eq!(diagnostics[0].reason.chars().count(), MAX_DIAGNOSTIC_CHARS);
        assert_eq!(diagnostics[1].code, "request_error");
        assert_eq!(diagnostics[1].reason, "[redacted]");
    }

    #[test]
    fn context_overflow_refusals_are_told_from_other_errors() {
        for refused in [
            r#"http_400: {"error":{"message":"This model's maximum context length is 128000 tokens. However, your messages resulted in 140213 tokens.","code":"context_length_exceeded"}}"#,
            r#"http_400: {"object":"error","message":"This model's maximum context length is 32768 tokens. However, you requested 33012 tokens (29012 in the messages, 4000 in the completion).","code":400}"#,
            r#"http_400: {"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}"#,
            r#"http_400: {"error":{"message":"This endpoint's maximum context length is 131072 tokens. However, you requested about 150000 tokens","code":400}}"#,
            r#"http_400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}"#,
            r#"http_400: [{"error":{"code":400,"message":"The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}]"#,
            r#"http_400: {"error":{"code":"1261","message":"Prompt exceeds max length"}}"#,
            "http_413: Request Entity Too Large",
            r#"provider_error: {"code":400,"message":"This endpoint's maximum context length is 65536 tokens."}"#,
            // Text Generation Inference (and providers serving with it).
            r#"http_422: {"error":"Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 31000 `inputs` tokens and 4000 `max_new_tokens`","error_type":"validation"}"#,
            r#"http_422: {"error":"Input validation error: `inputs` must have less than 8192 tokens. Given: 9000","error_type":"validation"}"#,
        ] {
            assert!(context_overflow(refused), "{refused}");
        }
        for other in [
            r#"http_401: {"error":{"message":"Incorrect API key provided"}}"#,
            r#"http_400: {"error":{"message":"Invalid schema for function 'search'","code":"invalid_function_parameters"}}"#,
            r#"http_429: {"error":{"message":"Rate limit reached"}}"#,
            r#"http_500: {"error":{"message":"maximum context length exceeded while loading"}}"#,
            "stream_interrupted: missing completion terminator",
        ] {
            assert!(!context_overflow(other), "{other}");
        }
    }

    #[test]
    fn a_refusal_of_the_calls_written_is_told_from_one_of_the_request() {
        for refused in [
            r#"http_400: {"error":{"message":"tool call validation failed: parameters for tool jira__search did not match schema: errors: [missing properties: 'query']","type":"invalid_request_error","code":"tool_use_failed","failed_generation":"..."}}"#,
            r#"http_400: {"error":{"message":"tool call validation failed: attempted to call tool 'jira__find' which was not in request.tools","type":"invalid_request_error","code":"tool_use_failed"}}"#,
            r#"http_400: {"error":{"message":"Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.","type":"invalid_request_error","code":"tool_use_failed","failed_generation":"<function=jira__search>{}</function>"}}"#,
        ] {
            assert!(refused_generation(refused), "{refused}");
        }
        for other in [
            r#"http_400: {"error":{"message":"Invalid schema for function 'jira__search': array schema missing items","code":"invalid_function_parameters"}}"#,
            r#"http_400: {"error":{"message":"This model's maximum context length is 128000 tokens.","code":"context_length_exceeded"}}"#,
            r#"http_500: {"error":{"message":"tool_use_failed upstream"}}"#,
        ] {
            assert!(!refused_generation(other), "{other}");
        }
    }

    /// Context management review, thirteenth pass: a refusal for size was
    /// told only by its words, so a request the provider counted past the
    /// context never calibrated the estimate (no usage comes back with it).
    #[test]
    fn refusals_say_what_the_provider_counted() {
        for (refused, counted) in [
            (r#"http_400: {"error":{"message":"This model's maximum context length is 128000 tokens. However, your messages resulted in 140213 tokens.","code":"context_length_exceeded"}}"#, Some(140_213)),
            (r#"http_400: {"error":{"message":"This model's maximum context length is 8192 tokens. However, you requested 9500 tokens (7200 in the messages, 300 in the functions, and 2000 in the completion).","code":"context_length_exceeded"}}"#, Some(7_500)),
            (r#"http_400: {"object":"error","message":"This model's maximum context length is 32768 tokens. However, you requested 33012 tokens (29012 in the messages, 4000 in the completion).","code":400}"#, Some(29_012)),
            (r#"http_400: {"object":"error","message":"This model's maximum context length is 32768 tokens. However, you requested 40100 tokens in the messages, Please reduce the length of the messages.","code":400}"#, Some(40_100)),
            (r#"http_400: {"object":"error","message":"'max_tokens' or 'max_completion_tokens' is too large: 4000. This model's maximum context length is 32768 tokens and your request has 29012 input tokens (4000 > 32768 - 29012).","code":400}"#, Some(29_012)),
            (r#"http_400: {"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error","n_prompt_tokens":17001,"n_ctx":16384}}"#, Some(17_001)),
            (r#"http_400: {"error":"Trying to keep the first 17001 tokens when context the overflows. However, the model is loaded with context length of only 16384 tokens, which is not enough."}"#, Some(17_001)),
            (r#"http_400: {"error":{"message":"This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens (135100 of text input, 900 of tool input, 4000 in the output). Please reduce the length of either one.","code":400}}"#, Some(136_000)),
            (r#"http_400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210,012 tokens > 200,000 maximum"}}"#, Some(210_012)),
            (r#"http_400: [{"error":{"code":400,"message":"The input token count (1100000) exceeds the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}]"#, Some(1_100_000)),
            (r#"http_422: {"error":"Input validation error: `inputs` tokens + `max_new_tokens` must be <= 32768. Given: 31000 `inputs` tokens and 4000 `max_new_tokens`","error_type":"validation"}"#, Some(31_000)),
            (r#"http_422: {"error":"Input validation error: `inputs` must have less than 8192 tokens. Given: 9000","error_type":"validation"}"#, Some(9_000)),
            // Words without a count.
            (r#"http_400: {"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error"}}"#, None),
            (r#"http_400: {"error":{"code":"1261","message":"Prompt exceeds max length"}}"#, None),
            ("http_413: Request Entity Too Large", None),
            // A count past any context (a garbled number) adds up to the
            // most there is, not past it.
            (r#"http_400: {"error":{"message":"This model's maximum context length is 8192 tokens. However, you requested 18446744073709551615 tokens (18446744073709551615 in the messages, 300 in the functions, and 2000 in the completion).","code":"context_length_exceeded"}}"#, Some(usize::MAX)),
        ] {
            assert!(context_overflow(refused), "{refused}");
            assert_eq!(overflow_prompt_tokens(refused), counted, "{refused}");
        }
    }
}

#[cfg(test)]
mod tool_choice_tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// How the fake provider treats a request with tool_choice "none".
    #[derive(Clone, Copy)]
    enum Provider {
        Honors,
        Refuses,
        Ignores,
        TooLong,
        /// The stream drops after its first words.
        Drops,
        /// Refuses reasoning_effort by name, as OpenAI does for a model
        /// without reasoning.
        RefusesEffort,
        /// Refuses tool_choice "none", then the request without its tools
        /// as too long, saying what it counted.
        RefusesThenTooLong,
        /// Reads the output limit only as max_tokens, as Ollama does: under
        /// max_completion_tokens alone it writes 500 tokens.
        IgnoresCompletionLimit,
        /// Writes 500 tokens of which 450 are reasoning, as a provider whose
        /// limit bounds only the answer does.
        ReasonsPastTheLimit,
    }

    /// An OpenAI-compatible server on a fresh port (so the endpoint caches
    /// start empty), recording every request body.
    async fn serve(provider: Provider) -> (Config, Arc<Mutex<Vec<Value>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(vec![]));
        let record = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let record = record.clone();
                tokio::spawn(async move {
                    let mut bytes = vec![];
                    let mut buffer = [0u8; 8192];
                    let body = loop {
                        let n = socket.read(&mut buffer).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buffer[..n]);
                        let text = String::from_utf8_lossy(&bytes).into_owned();
                        if let Some((head, body)) = text.split_once("\r\n\r\n") {
                            let length = head
                                .lines()
                                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                                .unwrap_or(0);
                            if body.len() >= length {
                                break serde_json::from_str::<Value>(body).unwrap();
                            }
                        }
                    };
                    let withheld = body["tool_choice"] == "none";
                    let effort = body.get("reasoning_effort").is_some();
                    let body_limit = body["max_tokens"].as_u64();
                    record.lock().unwrap().push(body);
                    let event = |v: Value| format!("data: {v}\n\n");
                    let reply = match provider {
                        Provider::Refuses | Provider::RefusesThenTooLong if withheld => {
                            let error = r#"{"error":{"code":"1210","message":"Invalid API parameter"}}"#;
                            format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{error}", error.len())
                        }
                        Provider::RefusesThenTooLong => {
                            let error = r#"{"error":{"message":"This model's maximum context length is 8192 tokens. However, your messages resulted in 9100 tokens.","code":"context_length_exceeded"}}"#;
                            format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{error}", error.len())
                        }
                        Provider::TooLong => {
                            let error = r#"{"error":{"message":"This model's maximum context length is 8192 tokens.","code":"context_length_exceeded"}}"#;
                            format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{error}", error.len())
                        }
                        Provider::RefusesEffort if effort => {
                            let error = r#"{"error":{"message":"Unrecognized request argument supplied: reasoning_effort","type":"invalid_request_error"}}"#;
                            format!("HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{error}", error.len())
                        }
                        Provider::IgnoresCompletionLimit | Provider::ReasonsPastTheLimit => {
                            let written = match provider {
                                Provider::IgnoresCompletionLimit => body_limit.unwrap_or(500),
                                _ => 500,
                            };
                            let reasoning = matches!(provider, Provider::ReasonsPastTheLimit).then_some(450);
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}{}{}data: [DONE]\n\n",
                                event(json!({"choices":[{"delta":{"content":"답"},"finish_reason":null}]})),
                                event(json!({"choices":[{"delta":{},"finish_reason":"stop"}]})),
                                event(json!({"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":written,"completion_tokens_details":{"reasoning_tokens":reasoning}}}))
                            )
                        }
                        Provider::Drops => format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}",
                            event(json!({"choices":[{"delta":{"content":"쓰던 "},"finish_reason":null}]}))
                        ),
                        Provider::Ignores if withheld => format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}{}data: [DONE]\n\n",
                            event(json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"search","arguments":"{}"}}]},"finish_reason":null}]})),
                            event(json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}))
                        ),
                        _ => format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}{}data: [DONE]\n\n",
                            event(json!({"choices":[{"delta":{"content":"답"},"finish_reason":null}]})),
                            event(json!({"choices":[{"delta":{},"finish_reason":"stop"}]}))
                        ),
                    };
                    let _ = socket.write_all(reply.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        let config = Config {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            model: "tool-choice-test".into(),
            disable_proxy: true,
            retries: 0,
            ..Config::default()
        };
        (config, seen)
    }

    fn withheld() -> Value {
        json!({"model":"tool-choice-test","messages":[{"role":"user","content":"질문"}],
            "tools":[{"type":"function","function":{"name":"search","description":"찾기","parameters":{"type":"object","properties":{}}}}],
            "tool_choice":"none"})
    }

    async fn complete(config: &Config, request: Value) -> Result<Completion> {
        let (tx, mut rx) = mpsc::channel(64);
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        OpenAiClient.complete(request, config, CancellationToken::new(), tx).await
    }

    fn shapes(seen: &Arc<Mutex<Vec<Value>>>) -> Vec<(bool, bool)> {
        seen.lock().unwrap().iter().map(|r| (r.get("tools").is_some(), r.get("tool_choice").is_some())).collect()
    }

    #[tokio::test]
    async fn withheld_tools_stay_defined_where_tool_choice_none_works() {
        let (config, seen) = serve(Provider::Honors).await;
        for _ in 0..2 {
            let reply = complete(&config, withheld()).await.unwrap();
            assert_eq!((reply.text.as_str(), reply.tools_dropped), ("답", false));
        }
        assert_eq!(shapes(&seen), [(true, true), (true, true)], "the tools keep the prompt's prefix");
    }

    #[tokio::test]
    async fn a_provider_refusing_tool_choice_none_gets_the_request_without_tools() {
        // Z.ai documents tool_choice "auto" only.
        let (config, seen) = serve(Provider::Refuses).await;
        let reply = complete(&config, withheld()).await.unwrap();
        assert_eq!((reply.text.as_str(), reply.tools_dropped), ("답", true), "its usage counts no tools");
        assert_eq!(shapes(&seen), [(true, true), (false, false)]);
        // Remembered: the next withheld request leaves the tools out at once.
        let reply = complete(&config, withheld()).await.unwrap();
        assert_eq!((reply.text.as_str(), reply.tools_dropped), ("답", true));
        assert_eq!(shapes(&seen)[2], (false, false));
    }

    #[tokio::test]
    async fn a_provider_ignoring_tool_choice_none_is_remembered() {
        // Ollama's OpenAI API does not read tool_choice: the model may call tools.
        let (config, seen) = serve(Provider::Ignores).await;
        let first = complete(&config, withheld()).await.unwrap();
        assert_eq!(first.calls.len(), 1, "the caller handles calls it withheld");
        assert!(!first.tools_dropped);
        let reply = complete(&config, withheld()).await.unwrap();
        assert_eq!((reply.text.as_str(), reply.tools_dropped), ("답", true));
        assert_eq!(shapes(&seen), [(true, true), (false, false)]);
    }

    #[tokio::test]
    async fn a_refusal_for_size_is_not_taken_for_tool_choice() {
        let (config, seen) = serve(Provider::TooLong).await;
        let error = complete(&config, withheld()).await.unwrap_err();
        assert!(context_overflow(&error.to_string()), "{error}");
        assert_eq!(shapes(&seen), [(true, true)], "the caller evicts and asks again");
        assert!(!error.downcast_ref::<CompletionError>().unwrap().tools_dropped(), "sent with its tools");
    }

    /// Context management review, thirteenth pass: the count in a refusal
    /// is of the request as sent — without the tools, here — and the caller
    /// calibrates against that request.
    #[tokio::test]
    async fn a_refusal_says_whether_the_tools_were_sent() {
        let (config, seen) = serve(Provider::RefusesThenTooLong).await;
        let error = complete(&config, withheld()).await.unwrap_err();
        assert_eq!(shapes(&seen), [(true, true), (false, false)]);
        assert_eq!(overflow_prompt_tokens(&error.to_string()), Some(9_100));
        assert!(error.downcast_ref::<CompletionError>().unwrap().tools_dropped(), "{error}");
    }

    #[tokio::test]
    async fn a_stream_cut_after_its_text_is_a_transient_failure_left_to_the_caller() {
        // Its text has gone out: the client does not send the request again
        // (the stream would repeat it), but the caller may, taking it back.
        let (config, seen) = serve(Provider::Drops).await;
        let config = Config { retries: 2, ..config };
        let (tx, mut rx) = mpsc::channel(64);
        let error = OpenAiClient.complete(withheld(), &config, CancellationToken::new(), tx).await.unwrap_err();
        assert_eq!(rx.recv().await.as_deref(), Some("쓰던 "));
        let failure = error.downcast_ref::<CompletionError>().expect("a completion error");
        assert!(failure.transient(), "{error}");
        assert_eq!(seen.lock().unwrap().len(), 1, "not retried by the client");
    }

    /// Context management review, sixteenth pass: Ollama reads the output
    /// limit only as max_tokens. Sent as max_completion_tokens it was never
    /// applied — an answer ran past the output the context budget keeps for
    /// it (Ollama then shifts out the start of the prompt), a cut answer was
    /// never continued and a thinking model thought until the question's
    /// time ran out. A reply past the limit shows it was ignored.
    #[tokio::test]
    async fn an_output_limit_the_server_ignores_is_sent_as_max_tokens() {
        let (config, seen) = serve(Provider::IgnoresCompletionLimit).await;
        let config = Config { output_tokens: 100, ..config };
        for _ in 0..2 {
            assert_eq!(complete(&config, withheld()).await.unwrap().text, "답");
        }
        let limits: Vec<(Option<u64>, Option<u64>)> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|r| (r["max_completion_tokens"].as_u64(), r["max_tokens"].as_u64()))
            .collect();
        assert_eq!(limits, [(Some(100), None), (None, Some(100))], "learned from the first reply");
        // Reasoning past the limit, with the answer within it, is no sign.
        let (config, seen) = serve(Provider::ReasonsPastTheLimit).await;
        let config = Config { output_tokens: 100, ..config };
        for _ in 0..2 {
            complete(&config, withheld()).await.unwrap();
        }
        assert!(seen.lock().unwrap().iter().all(|r| r["max_completion_tokens"] == 100 && r.get("max_tokens").is_none()));
    }

    #[tokio::test]
    async fn an_optional_parameter_refused_by_name_is_left_out() {
        // README: a server that does not know reasoning_effort gets the
        // request again without it, and later requests leave it out.
        let (config, seen) = serve(Provider::RefusesEffort).await;
        for _ in 0..2 {
            let reply = complete(&config, withheld()).await.unwrap();
            assert_eq!(reply.text, "답");
        }
        let sent: Vec<(bool, bool, bool)> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|r| (r.get("reasoning_effort").is_some(), r.get("stream_options").is_some(), r.get("tools").is_some()))
            .collect();
        assert_eq!(sent, [(true, true, true), (false, true, true), (false, true, true)], "only the parameter named goes, and stays gone");
        // A refusal that names no optional parameter is no reason to drop one.
        let (config, seen) = serve(Provider::Refuses).await;
        complete(&config, withheld()).await.unwrap();
        assert!(seen.lock().unwrap().iter().all(|r| r.get("reasoning_effort").is_some()));
    }
}

#[cfg(test)]
mod probe_tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const OVERLOADED: &str = r#"{"id":"gen-1","error":{"message":"Upstream error from Nvidia: Service temporarily overloaded","code":503,"metadata":{"error_type":"provider_overloaded"}}}"#;
    const ANSWER: &str = r#"{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"OK","reasoning":"The user wants OK."}}]}"#;

    /// An OpenAI-compatible server on a fresh port. The plain (non-streaming)
    /// requests get `plain` in turn (the last one repeats); the streaming
    /// ones get the tool call and then the text the probe's later stages ask
    /// for. Returns the number of plain requests it answered.
    async fn serve(plain: Vec<&'static str>) -> (Config, Arc<Mutex<usize>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let plain_requests = Arc::new(Mutex::new(0usize));
        let counter = plain_requests.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let counter = counter.clone();
                let plain = plain.clone();
                tokio::spawn(async move {
                    let mut bytes = vec![];
                    let mut buffer = [0u8; 8192];
                    let body = loop {
                        let n = socket.read(&mut buffer).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buffer[..n]);
                        let text = String::from_utf8_lossy(&bytes).into_owned();
                        if let Some((head, body)) = text.split_once("\r\n\r\n") {
                            let length = head
                                .lines()
                                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                                .unwrap_or(0);
                            if body.len() >= length {
                                break serde_json::from_str::<Value>(body).unwrap();
                            }
                        }
                    };
                    let event = |v: Value| format!("data: {v}\n\n");
                    let reply = if body["stream"] == json!(false) {
                        let mut count = counter.lock().unwrap();
                        let answer = plain[(*count).min(plain.len() - 1)];
                        *count += 1;
                        // A gateway's keep-alive blanks come before the JSON.
                        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n \n{answer}")
                    } else if body["messages"].as_array().is_some_and(|m| m.iter().any(|m| m["role"] == "tool")) {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n: PROCESSING\n\n{}{}data: [DONE]\n\n",
                            event(json!({"choices":[{"delta":{"content":"OK"},"finish_reason":null}]})),
                            event(json!({"choices":[{"delta":{},"finish_reason":"stop"}]}))
                        )
                    } else {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{}{}data: [DONE]\n\n",
                            event(json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"connection_echo","arguments":"{\"text\":\"OK\"}"}}]},"finish_reason":null}]})),
                            event(json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}))
                        )
                    };
                    let _ = socket.write_all(reply.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        let config = Config {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            model: "probe-test".into(),
            disable_proxy: true,
            retries: 0,
            ..Config::default()
        };
        (config, plain_requests)
    }

    #[test]
    fn a_plain_answer_says_why_it_is_not_a_complete_text() {
        let problem = |answer: &str| plain_answer_problem(&serde_json::from_str(answer).unwrap());
        assert_eq!(problem(ANSWER), None);
        // The case a live run hit: a gateway relays an overload as HTTP 200.
        let overloaded = problem(OVERLOADED).unwrap();
        assert_eq!(overloaded, "http_503: Upstream error from Nvidia: Service temporarily overloaded");
        assert!(transient_error(&overloaded));
        let quota = problem(r#"{"error":{"message":"Rate limit exceeded","code":"429"}}"#).unwrap();
        assert!(transient_error(&quota), "{quota}");
        // Other refusals are the provider's answer, not a reason to ask again.
        let key = problem(r#"{"error":{"message":"No auth credentials found","code":401}}"#).unwrap();
        assert!(!transient_error(&key) && key.contains("No auth credentials found"), "{key}");
        let bare = problem(r#"{"error":"quota used up"}"#).unwrap();
        assert!(bare.starts_with("provider_error:") && bare.contains("quota used up"), "{bare}");
        // A model that spends its limit reasoning leaves no text.
        let length = problem(r#"{"choices":[{"finish_reason":"length","message":{"content":null,"reasoning":"hmm"}}]}"#).unwrap();
        assert!(length.contains("finish_reason=length") && length.contains("output tokens"), "{length}");
        let reasoned = problem(r#"{"choices":[{"finish_reason":"stop","message":{"content":null,"reasoning":"hmm"}}]}"#).unwrap();
        assert_eq!(reasoned, "the answer has reasoning but no text");
        assert_eq!(
            problem(r#"{"choices":[{"finish_reason":"stop","message":{"content":" "}}]}"#).unwrap(),
            "the answer has no text"
        );
        assert!(problem(r#"{"choices":[{"finish_reason":"tool_calls","message":{"tool_calls":[{"id":"c"}]}}]}"#).unwrap().contains("tool call"));
        assert!(problem(r#"{"choices":[{"message":{"content":"OK"}}]}"#).unwrap().contains("finish_reason=missing"));
        assert!(problem(r#"{"choices":[]}"#).unwrap().starts_with("no choices"));
    }

    #[tokio::test]
    async fn an_overload_relayed_with_http_200_is_asked_again() {
        let (config, plain_requests) = serve(vec![OVERLOADED, ANSWER]).await;
        let config = Config { retries: 1, ..config };
        let done = OpenAiClient.probe(&config).await.unwrap();
        assert!(done.contains("succeeded"), "{done}");
        assert_eq!(*plain_requests.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn a_probe_that_stays_overloaded_names_the_providers_error() {
        let (config, plain_requests) = serve(vec![OVERLOADED]).await;
        let error = OpenAiClient.probe(&config).await.unwrap_err().to_string();
        assert!(error.contains("Service temporarily overloaded") && error.contains("503"), "{error}");
        assert!(!error.contains("expected a complete text response"), "{error}");
        assert_eq!(*plain_requests.lock().unwrap(), 1, "no retries are configured");
        // A refusal that is no overload is not asked again, retries or not.
        let (config, plain_requests) = serve(vec![r#"{"error":{"message":"No auth credentials found","code":401}}"#]).await;
        let config = Config { retries: 2, ..config };
        let error = OpenAiClient.probe(&config).await.unwrap_err().to_string();
        assert!(error.contains("No auth credentials found"), "{error}");
        assert_eq!(*plain_requests.lock().unwrap(), 1);
    }
}
