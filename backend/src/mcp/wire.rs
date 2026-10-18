//! A server's messages made readable before they are parsed. What the SDK
//! cannot read is dropped over stdio (the call waits out its timeout) and
//! ends the whole session over SSE. So:
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

use futures_util::StreamExt;
use rmcp::{
    model::{ClientJsonRpcMessage, RequestId, ServerJsonRpcMessage},
    transport::{
        common::client_side_sse::BoxedSseResponse,
        streamable_http_client::{StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse},
    },
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};

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

/// The MCP HTTP client: rmcp's own (no redirects, no idle connections) with
/// the events of its SSE responses mended. A plain JSON response is parsed
/// inside rmcp, out of reach: one that cannot be read fails that call only.
#[derive(Clone)]
pub struct Lenient(reqwest13::Client);

impl Lenient {
    /// Fails where the client cannot be built (no certificate store the
    /// platform verifier can load): the server's connection fails with why,
    /// rather than its supervisor or the admin's request with a panic.
    pub fn new() -> Result<Self, reqwest13::Error> {
        let client = reqwest13::Client::builder()
            .pool_max_idle_per_host(0)
            .redirect(reqwest13::redirect::Policy::none())
            .build()?;
        Ok(Self(client))
    }
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
        let (asked, with_session) = (request_id(&message), session_id.is_some());
        mended_response(asked, with_session, self.0.post_message(uri, message, session_id, auth_header, custom_headers).await)
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
        let (asked, with_session) = (request_id(&message), session_id.is_some());
        let response = self
            .0
            .post_message_with_max_sse_event_size(uri, message, session_id, auth_header, custom_headers, max_sse_event_size)
            .await;
        mended_response(asked, with_session, response)
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
        custom_headers: Headers,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        self.0.delete_session(uri, session_id, auth_header, custom_headers).await
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: Headers,
    ) -> Result<BoxedSseResponse, StreamableHttpError<Self::Error>> {
        self.0.get_stream(uri, session_id, last_event_id, auth_header, custom_headers).await.map(mended_events)
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
        self.0
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
        let refused = mended_response(asked.clone(), true, error(None)).err().expect("fails the request").to_string();
        assert!(refused.contains(ANSWERED_NO_REQUEST) && refused.contains("No valid session ID provided (code -32000)"), "{refused}");
        assert!(mended_response(asked.clone(), true, error(Some(NumberOrString::Number(8)))).is_err(), "another request's");
        // Without a session (the initialization) there is none to lose.
        let refused = mended_response(asked.clone(), false, error(None)).err().expect("fails the request").to_string();
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
