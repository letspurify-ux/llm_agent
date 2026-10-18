//! A server's messages made readable before they are parsed. What the SDK
//! cannot read is dropped over stdio (the call waits out its timeout) and
//! ends the whole session over SSE. So:
//! - a JavaScript server that cuts a text inside an emoji (`slice(0, n)`)
//!   sends half a surrogate pair as a `\ud83d` escape, which the JSON parser
//!   refuses: it becomes U+FFFD, as does a byte that is not UTF-8;
//! - a message without `"jsonrpc":"2.0"`, or with an error that is not
//!   `{code, message}`, is put right (the error keeps its text);
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
    put_right(text).or(escaped)
}

/// The top of a message: its version and error, the rest skipped unread.
#[derive(serde::Deserialize)]
struct Head {
    #[serde(default)]
    jsonrpc: Value,
    #[serde(default)]
    error: Value,
    /// `Some(None)`: there, and null.
    #[serde(default, deserialize_with = "present")]
    result: Option<Option<serde::de::IgnoredAny>>,
    method: Option<serde::de::IgnoredAny>,
}

/// A field that is there, null or not.
fn present<'de, D: serde::Deserializer<'de>>(field: D) -> Result<Option<Option<serde::de::IgnoredAny>>, D::Error> {
    serde::Deserialize::deserialize(field).map(Some)
}

/// The message with its version and error as JSON-RPC has them, when either
/// is not. Only such a message is read whole.
fn put_right(text: &[u8]) -> Option<Vec<u8>> {
    let head: Head = serde_json::from_slice(text).ok()?;
    if !matches!(head.result, Some(Some(_))) && head.method.is_none() && head.error.is_null() {
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
    if head.jsonrpc == "2.0" && error_ok && !null_result {
        return None;
    }
    let mut message: serde_json::Map<String, Value> = serde_json::from_slice(text).ok()?;
    message.insert("jsonrpc".into(), json!("2.0"));
    if null_result {
        message.remove("result");
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
