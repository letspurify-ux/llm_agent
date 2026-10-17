//! A server's messages made readable before they are parsed. What the SDK
//! cannot read is dropped over stdio (the call waits out its timeout) and
//! ends the whole session over SSE. So:
//! - a JavaScript server that cuts a text inside an emoji (`slice(0, n)`)
//!   sends half a surrogate pair as a `\ud83d` escape, which the JSON parser
//!   refuses: it becomes U+FFFD, as does a byte that is not UTF-8;
//! - a message without `"jsonrpc":"2.0"`, or with an error that is not
//!   `{code, message}`, is put right (the error keeps its text).

use futures_util::StreamExt;
use rmcp::{
    model::ClientJsonRpcMessage,
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
    result: Option<serde::de::IgnoredAny>,
    method: Option<serde::de::IgnoredAny>,
}

/// The message with its version and error as JSON-RPC has them, when either
/// is not. Only such a message is read whole.
fn put_right(text: &[u8]) -> Option<Vec<u8>> {
    let head: Head = serde_json::from_slice(text).ok()?;
    if head.result.is_none() && head.method.is_none() && head.error.is_null() {
        return None;
    }
    let error_ok = head.error.is_null() || (head.error["code"].is_i64() && head.error["message"].is_string());
    if head.jsonrpc == "2.0" && error_ok {
        return None;
    }
    let mut message: serde_json::Map<String, Value> = serde_json::from_slice(text).ok()?;
    message.insert("jsonrpc".into(), json!("2.0"));
    if !error_ok {
        let error = &head.error;
        let text = error["message"].as_str().map(str::to_owned).or_else(|| error.as_str().map(str::to_owned)).unwrap_or_else(|| error.to_string());
        let mut fixed = json!({"code":error["code"].as_i64().unwrap_or(-32603),"message":text});
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
    pub fn new() -> Self {
        let client = reqwest13::Client::builder()
            .pool_max_idle_per_host(0)
            .redirect(reqwest13::redirect::Policy::none())
            .build()
            .expect("the MCP HTTP client builds once TLS is installed");
        Self(client)
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

fn mended_response(response: StreamableHttpPostResponse) -> StreamableHttpPostResponse {
    match response {
        StreamableHttpPostResponse::Sse(stream, session) => StreamableHttpPostResponse::Sse(mended_events(stream), session),
        other => other,
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
        self.0.post_message(uri, message, session_id, auth_header, custom_headers).await.map(mended_response)
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
        self.0
            .post_message_with_max_sse_event_size(uri, message, session_id, auth_header, custom_headers, max_sse_event_size)
            .await
            .map(mended_response)
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
