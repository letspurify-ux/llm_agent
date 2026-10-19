//! A server's messages made readable before they are parsed. What the SDK
//! cannot read is dropped over stdio (the call waits out its timeout), ends
//! the whole session over SSE and fails the call in plain JSON. So:
//! - a JavaScript server that cuts a text inside an emoji (`slice(0, n)`)
//!   sends half a surrogate pair as a `\ud83d` escape, which the JSON parser
//!   refuses: it becomes U+FFFD, as does a byte that is not UTF-8;
//! - a message without `"jsonrpc":"2.0"`, or with an error that is not
//!   `{code, message}`, is put right (the error keeps its text);
//! - a number JSON cannot write becomes null (`NaN`, `Infinity` — Python's
//!   `json.dumps` writes them; JavaScript and pydantic write null), or a
//!   string of its digits past a double's range; an answer the parser still refuses
//!   (nested past its 128 levels, a trailing comma) becomes an error
//!   answering its request, and one without a result (a JavaScript handler
//!   that returned `undefined`) has a null one;
//! - an HTTP error that answers no request (`"id": null`, a session the
//!   server no longer knows) fails that request, rather than leave it
//!   waiting for an answer that never comes.
//!
//! The HTTP client also reads an answer as far as one message may be (see
//! `Lenient::post`), paces the event streams it opens, and says when the
//! SDK initialized a new session in place of one the server forgot.

use futures_util::{Stream, StreamExt};
use rmcp::{
    ErrorData,
    model::{ClientJsonRpcMessage, ClientRequest, ErrorCode, RequestId, ServerJsonRpcMessage},
    transport::{
        common::{
            client_side_sse::BoxedSseResponse,
            http_header::{EVENT_STREAM_MIME_TYPE, HEADER_LAST_EVENT_ID, HEADER_SESSION_ID, JSON_MIME_TYPE},
        },
        streamable_http_client::{
            AuthRequiredError, InsufficientScopeError, StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
        },
    },
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

/// A message as the SDK can read it; `None` when it already can (or is no
/// JSON-RPC message at all, which the SDK drops anyway).
pub fn mend(json: &[u8]) -> Option<Vec<u8>> {
    let escaped = escapes_mended(json);
    let text = escaped.as_deref().unwrap_or(json);
    match serde_json::from_slice::<Head>(text) {
        Ok(head) => put_right(text, &head),
        Err(error) => readable(text, error),
    }
    .or(escaped)
}

/// The top of a message: its version, ID and error, the rest skipped unread.
#[derive(serde::Deserialize)]
struct Head {
    #[serde(default)]
    jsonrpc: Value,
    #[serde(default)]
    id: Value,
    #[serde(default)]
    error: Value,
    /// `Some(None)`: there, and null.
    #[serde(default, deserialize_with = "present")]
    result: Option<Option<Skipped>>,
    method: Option<serde::de::IgnoredAny>,
}

/// A field that is there, null or not.
fn present<'de, D: serde::Deserializer<'de>>(field: D) -> Result<Option<Option<Skipped>>, D::Error> {
    serde::Deserialize::deserialize(field).map(Some)
}

/// A value skipped as the SDK reads it: its numbers made doubles and its
/// nesting counted, so that a number past a double's range or nesting past
/// the parser's 128 levels fails here as there. (`IgnoredAny` passes both.)
struct Skipped;

impl<'de> serde::Deserialize<'de> for Skipped {
    fn deserialize<D: serde::Deserializer<'de>>(value: D) -> Result<Self, D::Error> {
        value.deserialize_any(Skipped)
    }
}

impl<'de> serde::de::Visitor<'de> for Skipped {
    type Value = Skipped;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_bool<E>(self, _: bool) -> Result<Skipped, E> {
        Ok(Skipped)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Skipped, E> {
        Ok(Skipped)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Skipped, E> {
        Ok(Skipped)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Skipped, E> {
        Ok(Skipped)
    }
    fn visit_str<E>(self, _: &str) -> Result<Skipped, E> {
        Ok(Skipped)
    }
    fn visit_unit<E>(self) -> Result<Skipped, E> {
        Ok(Skipped)
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut items: A) -> Result<Skipped, A::Error> {
        while items.next_element::<Skipped>()?.is_some() {}
        Ok(Skipped)
    }
    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut fields: A) -> Result<Skipped, A::Error> {
        while fields.next_entry::<serde::de::IgnoredAny, Skipped>()?.is_some() {}
        Ok(Skipped)
    }
}

/// The message with its version and error as JSON-RPC has them, when either
/// is not. Only such a message is read whole.
fn put_right(text: &[u8], head: &Head) -> Option<Vec<u8>> {
    // An answer without a result: what JSON.stringify writes of a JavaScript
    // handler's `undefined`. The SDK took it for no message (the call waited
    // out its timeout over stdio, the session ended over SSE); a null result
    // is read as an unexpected answer by a call, and as no tools by a list.
    let resultless = head.jsonrpc == "2.0"
        && (head.id.is_number() || head.id.is_string())
        && head.result.is_none()
        && head.method.is_none()
        && head.error.is_null();
    if !matches!(head.result, Some(Some(_))) && head.method.is_none() && head.error.is_null() && !resultless {
        return None;
    }
    // The SDK reads a code as a 32-bit integer: one past it, or written as a
    // float (-32602.0), fails the whole message.
    let code = |error: &Value| {
        let integral = error["code"].as_f64().filter(|c| c.fract() == 0.0).map(|c| c as i64);
        error["code"].as_i64().or(integral).and_then(|c| i32::try_from(c).ok())
    };
    let error_ok = head.error.is_null() || (head.error["code"].is_i64() && code(&head.error).is_some() && head.error["message"].is_string());
    // An error beside a null result (JSON-RPC 1.0 sends both, so does a Go
    // struct without omitempty) reads as a success with a null result, the
    // error lost: a tool list refused would be a list without tools.
    let null_result = !head.error.is_null() && matches!(head.result, Some(None));
    if head.jsonrpc == "2.0" && error_ok && !null_result && !resultless {
        return None;
    }
    let mut message: serde_json::Map<String, Value> = serde_json::from_slice(text).ok()?;
    message.insert("jsonrpc".into(), json!("2.0"));
    if null_result {
        message.remove("result");
    }
    if resultless {
        message.remove("error");
        message.insert("result".into(), Value::Null);
    }
    if !error_ok {
        let error = &head.error;
        let text = error["message"].as_str().map(str::to_owned).or_else(|| error.as_str().map(str::to_owned)).unwrap_or_else(|| error.to_string());
        let mut fixed = json!({"code":code(error).unwrap_or(-32603),"message":text});
        if !error["data"].is_null() {
            fixed["data"] = error["data"].clone();
        }
        message.insert("error".into(), fixed);
    }
    serde_json::to_vec(&message).ok()
}

/// A message the parser refuses, read as far as it can be. A number JSON
/// cannot write becomes null (`NaN`, `Infinity`), or a string of its digits
/// (past a double's range: an integer of 400 digits). An answer still refused (nested past the parser's 128 levels, a
/// trailing comma) becomes an error answering its request: the SDK dropped
/// it, and the call waited out its timeout over stdio, or the session ended
/// over SSE — with every other conversation's call on it. What is no
/// message (a line of text) is left as it is.
fn readable(text: &[u8], error: serde_json::Error) -> Option<Vec<u8>> {
    // A line cut short (a server that died writing it) is left to the
    // connection's end, which says so.
    if error.classify() != serde_json::error::Category::Syntax {
        return None;
    }
    let scan = Scan::of(text).filter(|scan| scan.answer || scan.method)?;
    let mut error = error;
    if !scan.unwritable.is_empty() {
        let mut nulled = Vec::with_capacity(text.len());
        let mut copied = 0;
        for token in &scan.unwritable {
            nulled.extend_from_slice(&text[copied..token.start]);
            let digits = text[token.start..token.end].iter().find(|b| **b != b'-').is_some_and(u8::is_ascii_digit);
            if digits {
                nulled.push(b'"');
                nulled.extend_from_slice(&text[token.clone()]);
                nulled.push(b'"');
            } else {
                nulled.extend_from_slice(b"null");
            }
            copied = token.end;
        }
        nulled.extend_from_slice(&text[copied..]);
        match serde_json::from_slice::<Head>(&nulled) {
            Ok(head) => return put_right(&nulled, &head).or(Some(nulled)),
            Err(again) => error = again,
        }
    }
    let id = scan.id.filter(|_| scan.answer && !scan.method)?;
    let message = format!("the server answered, but its answer could not be read as JSON ({error})");
    serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32700,"message":message}})).ok()
}

/// What a message the parser refuses shows of itself, read token by token.
#[derive(Default)]
struct Scan {
    /// The request it names (a number or a string).
    id: Option<Value>,
    /// It has a `result` or an `error`: an answer.
    answer: bool,
    method: bool,
    /// The numbers JSON cannot write, outside strings.
    unwritable: Vec<std::ops::Range<usize>>,
}

impl Scan {
    /// None unless the text is an object.
    fn of(text: &[u8]) -> Option<Self> {
        let first = text.iter().position(|b| !b.is_ascii_whitespace())?;
        if text[first] != b'{' {
            return None;
        }
        let mut scan = Scan::default();
        let mut depth = 0usize;
        // The top-level key whose value is being read.
        let mut key: &[u8] = b"";
        let mut at = first;
        while at < text.len() {
            match text[at] {
                b'"' => {
                    let end = string_end(text, at);
                    if depth == 1 && text[end..].iter().find(|b| !b.is_ascii_whitespace()) == Some(&b':') {
                        // Followed by a colon, the string was closed before it.
                        key = &text[at + 1..end - 1];
                        scan.answer |= matches!(key, b"result" | b"error");
                        scan.method |= key == b"method";
                    } else if depth == 1 && key == b"id" {
                        scan.id = serde_json::from_slice(&text[at..end]).ok();
                    }
                    at = end;
                    continue;
                }
                b'{' | b'[' => depth += 1,
                b'}' | b']' => depth = depth.saturating_sub(1),
                b if b.is_ascii_alphanumeric() || b == b'-' || b == b'+' => {
                    let end = at + text[at..].iter().take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'+' | b'.')).count();
                    let token = &text[at..end];
                    // Rust reads NaN, Infinity and 1e999 as doubles that are not finite.
                    match std::str::from_utf8(token).ok().and_then(|t| t.parse::<f64>().ok()) {
                        Some(number) if !number.is_finite() => scan.unwritable.push(at..end),
                        Some(_) if depth == 1 && key == b"id" => scan.id = serde_json::from_slice(token).ok(),
                        _ => {}
                    }
                    at = end;
                    continue;
                }
                _ => {}
            }
            at += 1;
        }
        Some(scan)
    }
}

/// Where the string starting at `at` ends: past its closing quote, or at
/// the end of the text.
fn string_end(text: &[u8], at: usize) -> usize {
    let mut i = at + 1;
    while i < text.len() {
        match text[i] {
            b'\\' => i += 2,
            b'"' => return i + 1,
            _ => i += 1,
        }
    }
    text.len()
}

/// JSON text with each escape of a lone surrogate replaced by `\ufffd`, and
/// bytes that are not UTF-8 by U+FFFD; `None` when it needs neither.
fn escapes_mended(json: &[u8]) -> Option<Vec<u8>> {
    let lossy = match std::str::from_utf8(json) {
        Ok(_) => None,
        Err(_) => Some(String::from_utf8_lossy(json).into_owned().into_bytes()),
    };
    let bytes = lossy.as_deref().unwrap_or(json);
    let unit = |at: usize| -> Option<u32> {
        let hex = bytes.get(at..at + 4)?;
        u32::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok().filter(|_| hex.iter().all(u8::is_ascii_hexdigit))
    };
    let mut mended: Option<Vec<u8>> = None;
    let mut copied = 0;
    let mut at = 0;
    // Backslashes appear only in strings, each starting a two-character
    // escape or a six-character `\uXXXX`.
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let Some(code) = (bytes.get(at + 1) == Some(&b'u')).then(|| unit(at + 2)).flatten() else {
            at += 2;
            continue;
        };
        let lone = match code {
            0xD800..=0xDBFF => {
                let low = bytes.get(at + 6) == Some(&b'\\') && bytes.get(at + 7) == Some(&b'u') && unit(at + 8).is_some_and(|c| (0xDC00..=0xDFFF).contains(&c));
                if low {
                    at += 12;
                    continue;
                }
                true
            }
            0xDC00..=0xDFFF => true,
            _ => false,
        };
        if lone {
            let out = mended.get_or_insert_with(|| Vec::with_capacity(bytes.len()));
            out.extend_from_slice(&bytes[copied..at]);
            out.extend_from_slice(b"\\ufffd");
            copied = at + 6;
        }
        at += 6;
    }
    match mended {
        Some(mut out) => {
            out.extend_from_slice(&bytes[copied..]);
            Some(out)
        }
        None => lossy,
    }
}

/// Event streams (GET) one connection opens at once, then one each
/// `STREAM_INTERVAL`. The SDK opens a stream again as soon as one breaks,
/// without a wait, and again at once when the server's `retry` says 0: a
/// server or proxy that broke each stream as it opened it was asked some
/// fourteen thousand times a second, for as long as the connection lasted,
/// while it showed ready.
const STREAMS_AT_ONCE: u32 = 8;
const STREAM_INTERVAL: Duration = Duration::from_secs(1);

/// Bytes of one answer read, as of a stdio server's line and of an SSE event
/// (the SDK's limit): rmcp read a plain JSON answer, and an HTTP error's
/// body, whole. A tool answering a gigabyte took three of the backend's
/// memory, and an error page without end took it all, until the system
/// killed the backend.
const MAX_ANSWER_BYTES: usize = super::MAX_LINE_BYTES;
/// Bytes of an HTTP error's body quoted in its message (a message is cut to
/// a thousand characters where it is shown).
const QUOTED_BYTES: usize = 64 * 1024;
/// The error an answer past `MAX_ANSWER_BYTES` is read as, answering its
/// request.
pub const TOO_LARGE: &str = "the server answered with more than 16 MiB, which is not read: the request ran on the server, but its answer is lost; ask for less (a narrower query, fewer rows or fields)";

/// The MCP HTTP client of one connection: rmcp's own (no redirects, no
/// idle connections), its answers mended and read within bounds (`post`).
#[derive(Clone)]
pub struct Lenient {
    client: reqwest13::Client,
    /// When the next event stream may open, the ones at once aside.
    next_stream: Arc<Mutex<tokio::time::Instant>>,
    /// Sessions initialized: past the first, the SDK made a new one for a
    /// session the server forgot (HTTP 404 — a server restarted, deployed
    /// again), without a word to its handler. `renewed` is rung for each.
    sessions: Arc<AtomicU64>,
    renewed: Arc<Notify>,
}

impl Lenient {
    /// Fails where the client cannot be built (no certificate store the
    /// platform verifier can load): the server's connection fails with why,
    /// rather than its supervisor or the admin's request with a panic.
    /// `direct` leaves out the proxy of the environment (`HTTP_PROXY`,
    /// `HTTPS_PROXY`, `.env` included).
    pub fn new(renewed: Arc<Notify>, direct: bool) -> Result<Self, reqwest13::Error> {
        let mut builder = reqwest13::Client::builder()
            .pool_max_idle_per_host(0)
            .redirect(reqwest13::redirect::Policy::none());
        if direct {
            builder = builder.no_proxy();
        }
        let client = builder.build()?;
        Ok(Self { client, next_stream: Arc::new(Mutex::new(tokio::time::Instant::now())), sessions: Arc::default(), renewed })
    }

    /// The sessions initialized so far.
    pub fn sessions(&self) -> Arc<AtomicU64> {
        self.sessions.clone()
    }

    /// Waits until an event stream may open: `STREAMS_AT_ONCE` right away,
    /// then one each `STREAM_INTERVAL`.
    async fn paced(&self) {
        let start = {
            let mut next = self.next_stream.lock().unwrap_or_else(|p| p.into_inner());
            let at = (*next).max(tokio::time::Instant::now());
            *next = at + STREAM_INTERVAL;
            at.checked_sub(STREAM_INTERVAL * (STREAMS_AT_ONCE - 1))
        };
        if let Some(start) = start {
            tokio::time::sleep_until(start).await;
        }
    }

    /// Posts a message as rmcp's client does, its answer read within
    /// `MAX_ANSWER_BYTES` and mended: a plain JSON answer as a stdio line is,
    /// the events of an SSE answer one by one (`bounded_events`). An answer
    /// past the limit is not read on: it answers its request with an error
    /// (`TOO_LARGE`), the session left as it is.
    async fn post(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: Headers,
        max_event_size: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<reqwest13::Error>> {
        let (asked, with_session, initialize) = (request_id(&message), session_id.is_some(), initializes(&message));
        let response = self.send(uri, &message, session_id, auth_header, custom_headers, max_event_size).await;
        let response = mended_response(asked, with_session, response);
        if initialize {
            self.initialized(&response);
        }
        response
    }

    /// rmcp's `post_message` for reqwest (3.5), but for how much is read.
    async fn send(
        &self,
        uri: Arc<str>,
        message: &ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: Headers,
        max_event_size: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<reqwest13::Error>> {
        use reqwest13::{
            StatusCode,
            header::{ACCEPT, CONTENT_TYPE, WWW_AUTHENTICATE},
        };
        let mut request = self.client.post(uri.as_ref()).header(ACCEPT, format!("{EVENT_STREAM_MIME_TYPE}, {JSON_MIME_TYPE}"));
        if let Some(token) = auth_header {
            request = request.bearer_auth(token);
        }
        for (name, value) in custom_headers {
            // The transport's own headers, but the protocol version it sets
            // through these.
            if ["accept", HEADER_SESSION_ID, HEADER_LAST_EVENT_ID].iter().any(|own| name.as_str().eq_ignore_ascii_case(own)) {
                return Err(StreamableHttpError::ReservedHeaderConflict(name.to_string()));
            }
            request = request.header(name, value);
        }
        let with_session = session_id.is_some();
        if let Some(session) = session_id {
            request = request.header(HEADER_SESSION_ID, session.as_ref());
        }
        let mut response = request.json(message).send().await?;
        let status = response.status();
        if let Some(challenge) = response.headers().get(WWW_AUTHENTICATE).filter(|_| matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)) {
            let challenge = challenge
                .to_str()
                .map_err(|_| StreamableHttpError::UnexpectedServerResponse("invalid www-authenticate header value".into()))?
                .to_owned();
            return Err(if status == StatusCode::UNAUTHORIZED {
                StreamableHttpError::AuthRequired(AuthRequiredError::new(challenge))
            } else {
                let scope = scope(&challenge);
                StreamableHttpError::InsufficientScope(InsufficientScopeError::new(challenge, scope))
            });
        }
        if matches!(status, StatusCode::ACCEPTED | StatusCode::NO_CONTENT) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if status == StatusCode::NOT_FOUND && with_session {
            return Err(StreamableHttpError::SessionExpired);
        }
        let header = |name| response.headers().get(name).map(|v: &reqwest13::header::HeaderValue| String::from_utf8_lossy(v.as_bytes()).into_owned());
        let (content_type, session) = (header(CONTENT_TYPE), header(reqwest13::header::HeaderName::from_static("mcp-session-id")));
        let asked = request_id(message);
        // Some servers answer a notification with an empty 200, not 202.
        if status.is_success() && response.content_length() == Some(0) && asked.is_none() {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        let json = content_type.as_deref().is_some_and(|t| t.starts_with(JSON_MIME_TYPE));
        if !status.is_success() {
            let (body, cut) = read_within(&mut response, MAX_ANSWER_BYTES).await.unwrap_or_else(|_| (b"<failed to read response body>".to_vec(), false));
            let body = String::from_utf8_lossy(&body);
            if !cut {
                if let Some(refused) = discover_refused(message, with_session, status, &body) {
                    return Ok(refused);
                }
                // A JSON-RPC error is the server's answer, whatever its status.
                if json && let Ok(error @ ServerJsonRpcMessage::Error(_)) = serde_json::from_str(&body) {
                    return Ok(StreamableHttpPostResponse::Json(error, session));
                }
            }
            let quoted = cut_at(&body, QUOTED_BYTES);
            let more = if cut || quoted.len() < body.len() { "…" } else { "" };
            return Err(StreamableHttpError::UnexpectedServerResponse(format!("HTTP {status}: {quoted}{more}").into()));
        }
        match content_type.as_deref() {
            Some(t) if t.starts_with(EVENT_STREAM_MIME_TYPE) => Ok(StreamableHttpPostResponse::Sse(bounded_events(response.bytes_stream(), max_event_size, asked), session)),
            Some(_) if json => {
                // Known too long, it is not read at all.
                let (body, cut) = match response.content_length() {
                    Some(length) if length > MAX_ANSWER_BYTES as u64 => (vec![], true),
                    _ => read_within(&mut response, MAX_ANSWER_BYTES).await?,
                };
                if cut {
                    return Ok(match asked {
                        Some(id) => StreamableHttpPostResponse::Json(too_large(id), session),
                        None => StreamableHttpPostResponse::Accepted,
                    });
                }
                let body = mend(&body).unwrap_or(body);
                match serde_json::from_slice::<ServerJsonRpcMessage>(&body) {
                    Ok(parsed) => Ok(StreamableHttpPostResponse::Json(parsed, session)),
                    // What answers no request needs no reading.
                    Err(_) if asked.is_none() => Ok(StreamableHttpPostResponse::Accepted),
                    Err(error) => Err(StreamableHttpError::UnexpectedServerResponse(
                        format!("could not parse JSON response as ServerJsonRpcMessage: {error}: {}", preview(&body)).into(),
                    )),
                }
            }
            _ => Err(StreamableHttpError::UnexpectedContentType(content_type)),
        }
    }

    /// Counts an initialization the server answered (not with an error).
    fn initialized(&self, response: &Result<StreamableHttpPostResponse, StreamableHttpError<reqwest13::Error>>) {
        if matches!(response, Ok(StreamableHttpPostResponse::Json(ServerJsonRpcMessage::Error(_), _)) | Err(_)) {
            return;
        }
        if self.sessions.fetch_add(1, Ordering::AcqRel) > 0 {
            self.renewed.notify_one();
        }
    }
}

fn initializes(message: &ClientJsonRpcMessage) -> bool {
    matches!(message, ClientJsonRpcMessage::Request(request) if matches!(request.request, ClientRequest::InitializeRequest(_)))
}

/// The body, `limit` bytes of it at most, and whether there was more (not
/// read: the response is dropped, its connection closed).
async fn read_within(response: &mut reqwest13::Response, limit: usize) -> Result<(Vec<u8>, bool), reqwest13::Error> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > limit {
            body.extend_from_slice(&chunk[..limit - body.len()]);
            return Ok((body, true));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, false))
}

/// The text's first `limit` bytes, on a character boundary.
fn cut_at(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The start of a body that could not be read, as rmcp quotes it.
fn preview(body: &[u8]) -> String {
    if body.is_empty() {
        return "<empty>".to_owned();
    }
    cut_at(&String::from_utf8_lossy(body), 256).to_owned()
}

/// The error answering request `id` in place of an answer past the limit.
fn too_large(id: RequestId) -> ServerJsonRpcMessage {
    ServerJsonRpcMessage::error(ErrorData::new(ErrorCode::INTERNAL_ERROR, TOO_LARGE, None), Some(id))
}

/// The `scope` a refusal's `WWW-Authenticate` challenge names, as rmcp
/// reads it.
fn scope(challenge: &str) -> Option<String> {
    let at = challenge.to_ascii_lowercase().find("scope=")? + "scope=".len();
    let value = &challenge[at..];
    match value.strip_prefix('"') {
        Some(quoted) => quoted.find('"').map(|end| quoted[..end].to_owned()),
        None => {
            let end = value.find(|c: char| c == ',' || c == ';' || c.is_whitespace()).unwrap_or(value.len());
            (end > 0).then(|| value[..end].to_owned())
        }
    }
}

/// A refused `server/discover` sent without a session, as rmcp reads it
/// (`legacy_discover_response`): the error answering it, so that the SDK
/// falls back to the older protocol.
fn discover_refused(message: &ClientJsonRpcMessage, with_session: bool, status: reqwest13::StatusCode, body: &str) -> Option<StreamableHttpPostResponse> {
    use reqwest13::StatusCode;
    if with_session || !status.is_client_error() || matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return None;
    }
    let ClientJsonRpcMessage::Request(request) = message else {
        return None;
    };
    if !matches!(request.request, ClientRequest::DiscoverRequest(_)) {
        return None;
    }
    let error = match serde_json::from_str::<ServerJsonRpcMessage>(body) {
        Ok(ServerJsonRpcMessage::Error(error)) => error.error,
        _ => ErrorData::invalid_request(format!("server/discover rejected with HTTP {status}: {body}"), None),
    };
    Some(StreamableHttpPostResponse::Json(ServerJsonRpcMessage::error(error, Some(request.id.clone())), None))
}

/// The size of the SSE event being read, as rmcp counts it: its lines but
/// comments, each with the newline that joins them.
struct EventSize {
    limit: usize,
    /// The event's lines so far, and the line being read.
    event: usize,
    line: usize,
    comment: bool,
    after_cr: bool,
}

impl EventSize {
    fn new(limit: usize) -> Self {
        Self { limit, event: 0, line: 0, comment: false, after_cr: false }
    }

    /// Where in `chunk` the event being read passes the limit, if it does.
    fn past(&mut self, chunk: &[u8]) -> Option<usize> {
        for (at, &byte) in chunk.iter().enumerate() {
            if std::mem::take(&mut self.after_cr) && byte == b'\n' {
                continue;
            }
            match byte {
                b'\r' | b'\n' => {
                    // An empty line ends the event.
                    if self.line == 0 {
                        self.event = 0;
                    } else if !self.comment {
                        self.event = self.event.saturating_add(self.line + 1);
                    }
                    self.line = 0;
                    self.comment = false;
                    self.after_cr = byte == b'\r';
                }
                _ => {
                    if self.line == 0 {
                        self.comment = byte == b':';
                    }
                    self.line += 1;
                }
            }
            if self.event.saturating_add(self.line) > self.limit {
                return Some(at);
            }
        }
        None
    }
}

/// An SSE answer's events, each within `limit` bytes. rmcp ends its own
/// stream at one past it, but knows only its own error for that: from
/// another it would open the stream again, and a server would send that
/// event again. So the event is ended before the line that passes the limit,
/// its data cut (unread), and an error answering the request (`TOO_LARGE`)
/// ends the stream. Lines go to the parser whole: half a line ("da") is an
/// error of the stream, which rmcp would also open again.
fn bounded_events(bytes: impl Stream<Item = Result<bytes::Bytes, reqwest13::Error>> + Send + 'static, limit: usize, asked: Option<RequestId>) -> BoxedSseResponse {
    let ends = |b: &u8| matches!(b, b'\n' | b'\r');
    // The bytes, the event's size, the line not yet passed on, and the
    // request answered — while the stream is open.
    let open = Some((bytes.boxed(), EventSize::new(limit), Vec::new(), asked));
    let bounded = futures_util::stream::unfold(open, move |open| async move {
        let (mut bytes, mut size, mut line, asked) = open?;
        loop {
            let chunk = match bytes.next().await {
                Some(Ok(chunk)) => chunk,
                Some(Err(error)) => return Some((Err(error), None)),
                // A last line without its end goes as it is.
                None => return (!line.is_empty()).then(|| (Ok(bytes::Bytes::from(line)), None)),
            };
            let past = size.past(&chunk);
            // The whole lines of the chunk (before the one past the limit).
            let whole = chunk[..past.unwrap_or(chunk.len())].iter().rposition(ends);
            let mut out = match whole {
                Some(end) => {
                    let mut out = std::mem::take(&mut line);
                    out.extend_from_slice(&chunk[..=end]);
                    out
                }
                None => vec![],
            };
            if past.is_none() {
                line.extend_from_slice(&chunk[whole.map_or(0, |end| end + 1)..]);
                if out.is_empty() {
                    continue;
                }
                return Some((Ok(bytes::Bytes::from(out)), Some((bytes, size, line, asked))));
            }
            // Two line ends: the first may end a CR's line.
            out.extend_from_slice(b"\n\n");
            if let Some(id) = asked {
                let error = serde_json::to_string(&too_large(id)).unwrap_or_default();
                out.extend_from_slice(format!("data: {error}\n\n").as_bytes());
            }
            return Some((Ok(bytes::Bytes::from(out)), None));
        }
    });
    sse_stream::SseStream::from_bytes_stream(bounded).boxed()
}

fn mended_events(stream: BoxedSseResponse) -> BoxedSseResponse {
    stream
        .map(|event| {
            event.map(|mut event| {
                if let Some(data) = &mut event.data
                    && let Some(mended) = mend(data.as_bytes())
                {
                    *data = String::from_utf8_lossy(&mended).into_owned();
                }
                event
            })
        })
        .boxed()
}

/// What the SDK cannot use in an answer. An error that answers no request
/// (`"id": null`) is how a server refuses a session it no longer knows —
/// the TypeScript SDK's example answers so (HTTP 400) after the server
/// restarts. The SDK would hold it for no request and the call would wait
/// out its timeout, every call after it too: it fails the request as a
/// lost connection instead, which makes a new session. A request sent
/// without a session (the initialization) has none to lose: such an error
/// refuses it (a server taking one initialization only, a token, a
/// protocol version).
fn mended_response(
    asked: Option<RequestId>,
    with_session: bool,
    response: Result<StreamableHttpPostResponse, StreamableHttpError<reqwest13::Error>>,
) -> Result<StreamableHttpPostResponse, StreamableHttpError<reqwest13::Error>> {
    match response? {
        StreamableHttpPostResponse::Sse(stream, session) => Ok(StreamableHttpPostResponse::Sse(mended_events(stream), session)),
        StreamableHttpPostResponse::Json(ServerJsonRpcMessage::Error(error), _) if asked.is_some() && error.id != asked => {
            let said = if with_session { ANSWERED_NO_REQUEST } else { REFUSED_NO_REQUEST };
            Err(StreamableHttpError::UnexpectedServerResponse(
                format!("{said}: {} (code {})", error.error.message, error.error.code.0).into(),
            ))
        }
        other => Ok(other),
    }
}

/// Said of an error answering no request (see `mended_response`) of a
/// session, and of a request sent without one.
pub const ANSWERED_NO_REQUEST: &str = "the server answered with an error for no request";
pub const REFUSED_NO_REQUEST: &str = "the server refused a request without a session with an error for no request";

/// The ID of a request, which its answer carries.
fn request_id(message: &ClientJsonRpcMessage) -> Option<RequestId> {
    match message {
        ClientJsonRpcMessage::Request(request) => Some(request.id.clone()),
        _ => None,
    }
}

type Headers = HashMap<reqwest13::header::HeaderName, reqwest13::header::HeaderValue>;

impl StreamableHttpClient for Lenient {
    type Error = reqwest13::Error;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: Headers,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        self.post(uri, message, session_id, auth_header, custom_headers, MAX_ANSWER_BYTES).await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: Headers,
        max_sse_event_size: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        self.post(uri, message, session_id, auth_header, custom_headers, max_sse_event_size).await
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
        custom_headers: Headers,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        self.client.delete_session(uri, session_id, auth_header, custom_headers).await
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: Headers,
    ) -> Result<BoxedSseResponse, StreamableHttpError<Self::Error>> {
        self.paced().await;
        self.client.get_stream(uri, session_id, last_event_id, auth_header, custom_headers).await.map(mended_events)
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: Headers,
        max_sse_event_size: usize,
    ) -> Result<BoxedSseResponse, StreamableHttpError<Self::Error>> {
        self.paced().await;
        self.client
            .get_stream_with_max_sse_event_size(uri, session_id, last_event_id, auth_header, custom_headers, max_sse_event_size)
            .await
            .map(mended_events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mended(text: &str) -> String {
        String::from_utf8(mend(text.as_bytes()).unwrap_or_else(|| text.as_bytes().to_vec())).unwrap()
    }

    #[test]
    fn lone_surrogates_become_replacement_characters() {
        assert_eq!(mended(r#"{"text":"잘림 \ud83d"}"#), r#"{"text":"잘림 \ufffd"}"#);
        assert_eq!(mended(r#"["\ude00x", "\uD83D\uDE00", "\ud83d\u0041"]"#), r#"["\ufffdx", "\uD83D\uDE00", "\ufffd\u0041"]"#);
        // An escaped backslash before "u" is text, not an escape.
        assert!(mend(br#"{"path":"C:\\ud83d"}"#).is_none());
        assert!(mend(br#"{"ok":"\u00e9\n\"\\"}"#).is_none());
        // Cut short or not hex: left for the parser to refuse.
        assert!(mend(br#""\ud8"#).is_none());
        assert_eq!(mended(r#""\ud83d"#), r#""\ufffd"#);
        let parsed: serde_json::Value = serde_json::from_str(&mended(r#"{"t":"a\udc00b\ud800"}"#)).unwrap();
        assert_eq!(parsed["t"], "a\u{fffd}b\u{fffd}");
    }

    #[test]
    fn slips_of_the_protocol_are_put_right() {
        let fixed = |text: &str| -> Value { serde_json::from_slice(&mend(text.as_bytes()).expect(text)).unwrap() };
        assert_eq!(fixed(r#"{"id":1,"result":{"a":1}}"#), json!({"jsonrpc":"2.0","id":1,"result":{"a":1}}));
        assert_eq!(fixed(r#"{"jsonrpc":"1.0","id":1,"result":{}}"#)["jsonrpc"], "2.0");
        assert_eq!(fixed(r#"{"jsonrpc":"2.0","id":1,"error":{"message":"no code"}}"#)["error"], json!({"code":-32603,"message":"no code"}));
        assert_eq!(fixed(r#"{"jsonrpc":"2.0","id":1,"error":{"code":"E1","message":"m","data":[1]}}"#)["error"], json!({"code":-32603,"message":"m","data":[1]}));
        assert_eq!(fixed(r#"{"jsonrpc":"2.0","id":1,"error":"just text"}"#)["error"], json!({"code":-32603,"message":"just text"}));
        assert_eq!(fixed(r#"{"jsonrpc":"2.0","id":1,"error":{"code":5}}"#)["error"], json!({"code":5,"message":"{\"code\":5}"}));
        // The SDK reads a code as a 32-bit integer: one past it, or written
        // as a float, would drop the whole message.
        for (code, read) in [("5000000000", -32603), ("-32602.0", -32602), ("1.5", -32603)] {
            let text = format!(r#"{{"jsonrpc":"2.0","id":1,"error":{{"code":{code},"message":"m"}}}}"#);
            assert_eq!(fixed(&text)["error"], json!({"code":read,"message":"m"}), "{code}");
            assert!(serde_json::from_slice::<ServerJsonRpcMessage>(&mend(text.as_bytes()).unwrap()).is_ok(), "{code}");
        }
        // An error beside a null result is the error (JSON-RPC 1.0 sends both).
        assert_eq!(fixed(r#"{"jsonrpc":"2.0","id":1,"result":null,"error":{"code":-32602,"message":"m"}}"#), json!({"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"m"}}));
        assert_eq!(fixed(r#"{"id":1,"result":null,"error":{"code":-1,"message":"m"}}"#), json!({"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"m"}}));
        assert!(mend(br#"{"jsonrpc":"2.0","id":1,"result":{},"error":null}"#).is_none(), "a result beside no error reads as it is");
        assert!(mend(br#"{"jsonrpc":"2.0","id":1,"result":null}"#).is_none());
        // Already right, or not a message: left alone, read once.
        assert!(mend(br#"{"jsonrpc":"2.0","id":1,"result":{"content":[]}}"#).is_none());
        assert!(mend(br#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad"}}"#).is_none());
        assert!(mend(b"starting up (not json)").is_none());
        assert!(mend(br#"[{"jsonrpc":"2.0","id":1,"result":{}}]"#).is_none());
        assert!(mend(br#"{"t":"no message"}"#).is_none());
        assert_eq!(fixed(r#"{"method":"notifications/message","params":{}}"#)["jsonrpc"], "2.0");
        // Both mended at once.
        assert_eq!(fixed(r#"{"id":1,"result":{"t":"\ud83d"}}"#), json!({"jsonrpc":"2.0","id":1,"result":{"t":"\u{fffd}"}}));
    }

    #[test]
    fn an_error_answering_no_request_fails_the_request() {
        use rmcp::model::{ErrorCode, ErrorData, JsonRpcError, NumberOrString};
        let error = |id: Option<RequestId>| {
            Ok(StreamableHttpPostResponse::Json(
                ServerJsonRpcMessage::Error(JsonRpcError::new(id, ErrorData::new(ErrorCode(-32000), "Bad Request: No valid session ID provided", None))),
                None,
            ))
        };
        let asked = Some(NumberOrString::Number(7));
        // A server's restart: its answer names no request (id null).
        let refused = mended_response(asked.clone(), true, error(None)).expect_err("fails the request").to_string();
        assert!(refused.contains(ANSWERED_NO_REQUEST) && refused.contains("No valid session ID provided (code -32000)"), "{refused}");
        assert!(mended_response(asked.clone(), true, error(Some(NumberOrString::Number(8)))).is_err(), "another request's");
        // Without a session (the initialization) there is none to lose.
        let refused = mended_response(asked.clone(), false, error(None)).expect_err("fails the request").to_string();
        assert!(refused.contains(REFUSED_NO_REQUEST) && !refused.contains(ANSWERED_NO_REQUEST), "{refused}");
        // The answer to the request, and errors to what awaits none, go on.
        assert!(mended_response(asked, true, error(Some(NumberOrString::Number(7)))).is_ok());
        assert!(mended_response(None, true, error(None)).is_ok(), "a notification's");
        assert!(matches!(mended_response(None, true, Ok(StreamableHttpPostResponse::Accepted)), Ok(StreamableHttpPostResponse::Accepted)));
    }

    /// Twenty-fourth pass: over stdio the SDK dropped these answers and the
    /// call waited out its timeout; over SSE they ended the session.
    #[test]
    fn answers_json_cannot_hold_still_answer_their_request() {
        let fixed = |text: &str| -> Value {
            let mended = mend(text.as_bytes()).unwrap_or_else(|| panic!("{text}"));
            assert!(serde_json::from_slice::<ServerJsonRpcMessage>(&mended).is_ok(), "the SDK reads it: {}", String::from_utf8_lossy(&mended));
            serde_json::from_slice(&mended).unwrap()
        };
        // Python's json.dumps writes NaN and Infinity; a double ends near 1.8e308.
        assert_eq!(
            fixed(r#"{"jsonrpc":"2.0","id":1,"result":{"a":NaN,"b":[Infinity,-Infinity,1e999,-2E400],"c":"NaN, 1e999 stay text","d":1.5e300,"e":true}}"#),
            json!({"jsonrpc":"2.0","id":1,"result":{"a":null,"b":[null,null,"1e999","-2E400"],"c":"NaN, 1e999 stay text","d":1.5e300,"e":true}})
        );
        // Python writes an integer of any size: factorial(200) has 375 digits.
        let factorial = format!("78865786{}", "0".repeat(367));
        assert_eq!(fixed(&format!(r#"{{"jsonrpc":"2.0","id":4,"result":{{"n":{factorial}}}}}"#))["result"]["n"], json!(factorial));
        assert_eq!(fixed(r#"{"id":"x","result":{"v":NaN}}"#), json!({"jsonrpc":"2.0","id":"x","result":{"v":null}}), "put right as well");
        assert_eq!(fixed(r#"{"jsonrpc":"2.0","id":2,"method":"sampling/createMessage","params":{"t":NaN}}"#)["params"]["t"], Value::Null, "a request too");
        // Nested past the parser's 128 levels, a trailing comma: an error
        // answering the request it names.
        let deep = format!(r#"{{"jsonrpc":"2.0","result":{{"v":{}1{}}},"id":7}}"#, "[".repeat(200), "]".repeat(200));
        let answered = fixed(&deep);
        assert_eq!((answered["id"].clone(), answered["error"]["code"].clone()), (json!(7), json!(-32700)), "{answered}");
        assert!(answered["error"]["message"].as_str().unwrap().contains("recursion limit exceeded"), "{answered}");
        let answered = fixed(r#"{"jsonrpc":"2.0","id":"a\"b","result":{"v":NaN,"w":[1,]}}"#);
        assert_eq!((answered["id"].clone(), answered["error"]["code"].clone()), (json!("a\"b"), json!(-32700)), "{answered}");
        // Without a result (JavaScript's undefined): a null one.
        assert_eq!(fixed(r#"{"jsonrpc":"2.0","id":3}"#), json!({"jsonrpc":"2.0","id":3,"result":null}));
        assert_eq!(fixed(r#"{"jsonrpc":"2.0","id":"q","error":null}"#), json!({"jsonrpc":"2.0","id":"q","result":null}));
        // No answer to a request: left as it is.
        for line in [
            "starting up (not json)",
            r#"{"level":"info","id":3}"#,
            r#"{"msg":"a log line","v":NaN}"#,
            r#"{"jsonrpc":"2.0","id":null}"#,
            r#"{"jsonrpc":"2.0","method":"x","params":[1,]}"#,
            r#"{"jsonrpc":"2.0","id":{"x":1},"result":[1,]}"#,
            "{", "{\"", "\"", "", "{\"id\":",
            // Cut short: the server died writing it.
            r#"{"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"cut"#,
        ] {
            assert!(mend(line.as_bytes()).is_none(), "{line}");
        }
    }

    /// Around the parser's nesting limit and a double's range, an answer is
    /// left as it is exactly when the SDK reads it, and mended into one it
    /// reads otherwise.
    #[test]
    fn the_sdk_reads_each_answer_as_it_is_or_mended() {
        let sdk = |text: &[u8]| serde_json::from_slice::<ServerJsonRpcMessage>(text).is_ok();
        let mut answers: Vec<String> = (100..160)
            .flat_map(|depth| {
                [
                    format!(r#"{{"jsonrpc":"2.0","id":1,"result":{{"v":{}1{}}}}}"#, "[".repeat(depth), "]".repeat(depth)),
                    format!(r#"{{"jsonrpc":"2.0","id":1,"result":{}{}}}"#, r#"{"a":"#.repeat(depth), "}".repeat(depth)),
                    format!(r#"{{"jsonrpc":"2.0","id":1,"error":{{"code":1,"message":"m","data":{}1{}}}}}"#, "[".repeat(depth), "]".repeat(depth)),
                ]
            })
            .collect();
        answers.extend((300..320).map(|digits| format!(r#"{{"jsonrpc":"2.0","id":1,"result":{{"n":1{}}}}}"#, "0".repeat(digits))));
        answers.extend((300..320).map(|exponent| format!(r#"{{"jsonrpc":"2.0","id":1,"result":{{"n":-1.7e{exponent}}}}}"#)));
        for answer in answers {
            match mend(answer.as_bytes()) {
                None => assert!(sdk(answer.as_bytes()), "left as it is, unread: {answer}"),
                Some(mended) => assert!(!sdk(answer.as_bytes()) && sdk(&mended), "mended: {answer}"),
            }
        }
    }

    /// Answers built of whole values, some numbers JSON cannot write among
    /// them: mended, each reads as the value with those numbers null (or
    /// their digits), its strings as they were; without one it is left as
    /// it is.
    #[test]
    fn random_unwritable_numbers_become_null_and_nothing_else_changes() {
        use rand::{Rng, SeedableRng};
        fn value(rng: &mut rand::rngs::StdRng, depth: usize, unwritable: &mut bool) -> (String, Value) {
            let texts = [("NaN", "NaN"), (r#"\"Infinity\""#, "\"Infinity\""), (r"\\", "\\"), ("1e999", "1e999"), ("가", "가"), ("{[:,", "{[:,"), (r"A", "A")];
            match rng.gen_range(0..if depth > 3 { 4 } else { 6 }) {
                0 => {
                    *unwritable = true;
                    let token = ["NaN", "Infinity", "-Infinity", "1e999", "-2E400"][rng.gen_range(0..5)];
                    (token.to_owned(), if token.contains('e') || token.contains('E') { json!(token) } else { Value::Null })
                }
                1 => {
                    let n: i64 = rng.gen_range(-1_000_000..1_000_000);
                    (n.to_string(), json!(n))
                }
                2 => {
                    let parts: Vec<(&str, &str)> = (0..rng.gen_range(0..4)).map(|_| texts[rng.gen_range(0..texts.len())]).collect();
                    (format!("\"{}\"", parts.iter().map(|p| p.0).collect::<String>()), json!(parts.iter().map(|p| p.1).collect::<String>()))
                }
                3 => {
                    let (raw, read) = [("true", json!(true)), ("null", Value::Null), ("1.5e300", json!(1.5e300))][rng.gen_range(0..3)].clone();
                    (raw.to_owned(), read)
                }
                4 => {
                    let items: Vec<(String, Value)> = (0..rng.gen_range(0..4)).map(|_| value(rng, depth + 1, unwritable)).collect();
                    (format!("[{}]", items.iter().map(|i| i.0.as_str()).collect::<Vec<_>>().join(",")), Value::Array(items.into_iter().map(|i| i.1).collect()))
                }
                _ => {
                    let fields: Vec<(String, (String, Value))> = (0..rng.gen_range(0..4)).map(|i| (format!("k{i}"), value(rng, depth + 1, unwritable))).collect();
                    let raw = fields.iter().map(|(k, (raw, _))| format!("\"{k}\": {raw}")).collect::<Vec<_>>().join(", ");
                    (format!("{{{raw}}}"), Value::Object(fields.into_iter().map(|(k, (_, v))| (k, v)).collect()))
                }
            }
        }
        let mut rng = rand::rngs::StdRng::seed_from_u64(24);
        for round in 0..20_000 {
            let mut unwritable = false;
            let (raw, expected) = value(&mut rng, 0, &mut unwritable);
            let text = format!(r#"{{"jsonrpc":"2.0","id":{round},"result":{{"v":{raw}}}}}"#);
            match mend(text.as_bytes()) {
                Some(mended) => {
                    assert!(unwritable, "{text}");
                    let read: Value = serde_json::from_slice(&mended).unwrap_or_else(|e| panic!("{text}: {e}"));
                    assert_eq!((&read["id"], &read["result"]["v"]), (&json!(round), &expected), "{text}");
                }
                None => assert!(!unwritable, "{text}"),
            }
        }
    }

    /// Twenty-fifth pass: the SDK opened a broken event stream again
    /// without a wait, some fourteen thousand times a second.
    #[tokio::test(start_paused = true)]
    async fn event_streams_open_eight_at_once_then_one_a_second() {
        super::super::install_tls();
        let client = Lenient::new(Arc::default(), false).unwrap();
        let opened = async || {
            let started = tokio::time::Instant::now();
            let mut at = vec![];
            for _ in 0..11 {
                client.paced().await;
                at.push(started.elapsed().as_secs());
            }
            at
        };
        assert_eq!(opened().await, [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
        // Streams that lasted leave room for as many at once again.
        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(opened().await, [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
    }

    /// Twenty-sixth pass: an SSE answer's events pass whole within the limit
    /// (split anywhere, CRLF, comments not counted); one past it is cut there
    /// and the request is answered with an error, nothing read after it.
    #[tokio::test]
    async fn sse_events_pass_within_the_limit_and_one_past_it_answers_its_request() {
        use rmcp::model::NumberOrString;
        let events = |chunks: Vec<&'static [u8]>, endless: bool, asked: Option<RequestId>| async move {
            let head = futures_util::stream::iter(chunks.into_iter().map(|c| Ok::<_, reqwest13::Error>(bytes::Bytes::from_static(c))));
            // A server that would go on without end past the limit.
            let tail = futures_util::stream::repeat_with(|| Ok(bytes::Bytes::from_static(b"yyyyyyyy"))).take(if endless { usize::MAX } else { 0 });
            bounded_events(head.chain(tail), 16, asked).map(|e| e.unwrap().data.unwrap_or_default()).collect::<Vec<_>>().await
        };
        let id = Some(NumberOrString::Number(7));
        // Within the limit: an event's lines, each with its newline, 16
        // bytes in all; comments are not counted.
        let within = events(vec![b"data:1", b"\r\n: cmt\r\ndata:12", b"3\r", b"\n\r\n", b"data: next\n\n"], false, id.clone()).await;
        assert_eq!(within, ["1\n123", "next"]);
        // Past it: the event before stays, the long one ends before its line
        // past the limit (split anywhere, its field name too), its request
        // answered with an error; the rest is not read (the tail is endless).
        for long in [vec![b"data: first\n\ndata:12\nda".as_slice(), b"ta:0123456789"], vec![b"data: first\n\ndata:12\ndata:0123456789".as_slice()]] {
            let past = events(long.clone(), true, id.clone()).await;
            assert_eq!(past.len(), 3, "{past:?}");
            assert_eq!(past[..2], ["first", "12"]);
            let error: Value = serde_json::from_str(&past[2]).unwrap();
            assert_eq!((error["id"].clone(), error["error"]["message"].clone()), (json!(7), json!(TOO_LARGE)));
            // Answering no request, it ends there.
            assert_eq!(events(long, true, None).await, ["first", "12"]);
        }
        // A line past the limit on its own, comment or not.
        for long in [b": a comment past the limit\n\n".as_slice(), b"data:0123456789012345\n\n"] {
            let past = events(vec![long], false, id.clone()).await;
            assert_eq!(past.len(), 1, "{past:?}");
            assert!(past[0].contains("more than 16 MiB"), "{past:?}");
        }
    }

    /// Random event streams split anywhere read as they read whole: the
    /// same events, never an error of the stream, and past the limit the
    /// whole lines before it, then the error answering the request.
    #[tokio::test]
    async fn random_event_streams_read_alike_however_split() {
        use rand::{Rng, SeedableRng};
        use std::ops::Not;
        let mut rng = rand::rngs::StdRng::seed_from_u64(26);
        let read = |chunks: Vec<Vec<u8>>, limit: Option<usize>| async move {
            let source = futures_util::stream::iter(chunks.into_iter().map(|c| Ok::<_, reqwest13::Error>(bytes::Bytes::from(c))));
            let events: Vec<_> = match limit {
                Some(limit) => bounded_events(source, limit, Some(RequestId::Number(1))).collect().await,
                None => sse_stream::SseStream::from_bytes_stream(source).boxed().collect().await,
            };
            // Each event's data (what an event without data does is nothing).
            events.into_iter().map(|e| e.map(|e| e.data).map_err(|e| e.to_string())).filter(|e| e.as_ref().is_ok_and(Option::is_none).not()).collect::<Vec<_>>()
        };
        for _ in 0..3_000 {
            // Valid streams: an empty line after a CR is a CR too (a LF
            // would join it into one line end).
            let mut text: Vec<u8> = vec![];
            let end = |text: &mut Vec<u8>, rng: &mut rand::rngs::StdRng| {
                let ending = if text.last() == Some(&b'\r') { "\r" } else { ["\n", "\r\n", "\r"][rng.gen_range(0..3)] };
                text.extend_from_slice(ending.as_bytes());
            };
            for _ in 0..rng.gen_range(0..6) {
                if rng.gen_bool(0.3) {
                    text.extend_from_slice(format!("id: {}", rng.gen_range(0..99)).as_bytes());
                    end(&mut text, &mut rng);
                }
                for _ in 0..rng.gen_range(0..4) {
                    let line = if rng.gen_bool(0.2) { ":".to_owned() } else { "data:".to_owned() } + &"가x".repeat(rng.gen_range(0..12));
                    text.extend_from_slice(line.as_bytes());
                    let ending = ["\n", "\r\n", "\r"][rng.gen_range(0..3)];
                    text.extend_from_slice(ending.as_bytes());
                }
                end(&mut text, &mut rng);
            }
            let limit = rng.gen_range(8..80);
            // As the stream reads unsplit, cut where the limit is passed.
            let expected = match EventSize::new(limit).past(&text) {
                Some(at) => {
                    let mut kept = text[..text[..at].iter().rposition(|b| matches!(b, b'\n' | b'\r')).map_or(0, |end| end + 1)].to_vec();
                    kept.extend_from_slice(b"\n\n");
                    let mut events = read(vec![kept], None).await;
                    events.push(Ok(Some(serde_json::to_string(&too_large(RequestId::Number(1))).unwrap())));
                    events
                }
                None => read(vec![text.clone()], None).await,
            };
            let mut chunks = vec![];
            let mut rest = text.as_slice();
            while !rest.is_empty() {
                let (chunk, after) = rest.split_at(rng.gen_range(0..=rest.len().min(9)));
                chunks.push(chunk.to_vec());
                rest = after;
            }
            // An error of the stream would be the text's own, never one of
            // the cut.
            assert_eq!(read(chunks, Some(limit)).await, expected, "limit {limit}: {:?}", String::from_utf8_lossy(&text));
        }
    }

    #[test]
    fn bytes_that_are_not_utf8_are_replaced() {
        let mended = mend(b"{\"t\":\"\xff\xfe ok\"}").unwrap();
        assert_eq!(String::from_utf8(mended).unwrap(), "{\"t\":\"\u{fffd}\u{fffd} ok\"}");
    }

    /// Built of whole escapes: the mended text always parses, to the same
    /// value as the original wherever that parsed.
    #[test]
    fn random_escapes_parse_after_mending() {
        use rand::{Rng, SeedableRng};
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        let parts = [r"\ud83d", r"\ude00", r"\uD83D\uDE00", r"\\", r"\\u", r"\n", r"\u0041", "가", "a", r#"\""#, "\u{1F600}"];
        for _ in 0..20_000 {
            let body: String = (0..rng.gen_range(0..8)).map(|_| parts[rng.gen_range(0..parts.len())]).collect();
            let text = format!(r#"{{"t":"{body}"}}"#);
            let fixed = mended(&text);
            let parsed: serde_json::Value = serde_json::from_str(&fixed).unwrap_or_else(|e| panic!("{text} → {fixed}: {e}"));
            if let Ok(original) = serde_json::from_str::<serde_json::Value>(&text) {
                assert_eq!(parsed, original, "{text}");
            }
        }
    }
}
