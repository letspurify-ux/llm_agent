//! HTTP: /api/health, /api/chat (NDJSON progress stream or one JSON body)
//! and /api/admin. The chat contract is the former Node server's, with an
//! optional `conversation_id` that keeps the conversation on the server.

use crate::{
    agent::{self, Answer, Events, MAX_QUESTION_LEN, ONE_SHOT_PREFIX, Question, UserFacing},
    app::App,
    text::{js_trim, strip_lone_surrogate_escapes, utf16_len},
};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{FutureExt, StreamExt};
use serde_json::{Value, json};
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const NDJSON: &str = "application/x-ndjson";
const SERVER_ERROR: &str = "처리 중 오류가 발생했습니다.";
const MAX_PENDING_LOGS: usize = 1000;
/// Request body limit of /api/chat (the former 1mb).
const CHAT_BODY_LIMIT: usize = 1024 * 1024;
/// How long shutdown waits for open connections. Answers in progress are
/// cancelled by the signal and end at once; a connection that sent only part
/// of a request has no read timeout and would keep the process running.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// TCP keepalive of accepted connections: a client that went away without
/// closing (sleep, network loss) is found within about two minutes, instead
/// of its connection and task being held until the process exits.
const KEEPALIVE: socket2::TcpKeepalive = socket2::TcpKeepalive::new()
    .with_time(Duration::from_secs(60))
    .with_interval(Duration::from_secs(10))
    .with_retries(6);

/// How long a connection may go without a request under way: idle between
/// requests, or sending its request head or body. axum's server set no
/// timer, and hyper's own header timeout needs one: a connection that sent
/// nothing (or part of a request) was kept for good, and an idle keep-alive
/// one as long as its client liked. Each held a descriptor, and 250 took a
/// backend at macOS's default limit of 256 out of service. A browser opens a
/// new connection for its next request; an answer being streamed is not
/// limited.
pub const CONNECTION_IDLE: Duration = Duration::from_secs(30);

/// Serves the router until `signal` resolves, then shuts down: connections
/// still open after SHUTDOWN_GRACE are dropped rather than waited for.
pub async fn serve(
    listener: tokio::net::TcpListener,
    app: Arc<App>,
    signal: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    serve_within(listener, app, signal, CONNECTION_IDLE).await
}

/// `serve` with connections closed past `idle` without a request under way
/// (see `CONNECTION_IDLE`).
pub async fn serve_within(
    listener: tokio::net::TcpListener,
    app: Arc<App>,
    signal: impl std::future::Future<Output = ()> + Send + 'static,
    idle: Duration,
) -> std::io::Result<()> {
    use axum::serve::{Listener, ListenerExt};
    use hyper_util::{
        rt::{TokioExecutor, TokioIo, TokioTimer},
        server::conn::auto::Builder,
        service::TowerToHyperService,
    };
    // A request body that stops coming ends the request (the timeout is
    // between its parts, not on the whole of a large upload).
    let service = TowerToHyperService::new(tower_http::timeout::RequestBodyTimeout::new(router(app), idle));
    let mut listener = listener.tap_io(keep_alive);
    let connections = tokio_util::task::TaskTracker::new();
    let stopping = CancellationToken::new();
    tokio::pin!(signal);
    loop {
        let (io, _) = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = &mut signal => break,
        };
        let (service, stopping) = (service.clone(), stopping.clone());
        connections.spawn(async move {
            // HTTP/1 only, as axum serves it here: told apart from HTTP/2
            // first, a connection that sent nothing waited for its first
            // bytes with no limit.
            let mut builder = Builder::new(TokioExecutor::new()).http1_only();
            builder.http1().timer(TokioTimer::new()).header_read_timeout(idle);
            let connection = builder.serve_connection(TokioIo::new(WriteStall::new(io, idle)), service);
            tokio::pin!(connection);
            tokio::select! {
                _ = connection.as_mut() => return,
                _ = stopping.cancelled() => connection.as_mut().graceful_shutdown(),
            }
            let _ = connection.await;
        });
    }
    drop(listener);
    stopping.cancel();
    connections.close();
    if tokio::time::timeout(SHUTDOWN_GRACE, connections.wait()).await.is_err() {
        eprintln!("[shutdown] connections still open after {}s were closed", SHUTDOWN_GRACE.as_secs());
    }
    Ok(())
}

/// A connection whose client stopped reading: a write that makes no
/// progress for `limit` fails, and the connection with it. Nothing else
/// ended one — the idle limit is for reading a request, and TCP keepalive
/// is answered by a client that keeps its receive window shut — so each
/// was kept for good, with its descriptor and what was left of its response
/// (20 connections asking for the screen's script and reading none of it:
/// all 20 still open after 105 s). A response still being written, however
/// long, or slow to be read, is not limited.
struct WriteStall<T> {
    inner: T,
    limit: Duration,
    stalled: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
}

impl<T> WriteStall<T> {
    fn new(inner: T, limit: Duration) -> Self {
        Self { inner, limit, stalled: None }
    }

    /// `written` as the inner write left it, a pending one failed once it
    /// has waited `limit`.
    fn bound<R>(&mut self, written: std::task::Poll<std::io::Result<R>>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<R>> {
        use std::task::Poll;
        if written.is_ready() {
            self.stalled = None;
            return written;
        }
        let limit = self.limit;
        let stalled = self.stalled.get_or_insert_with(|| Box::pin(tokio::time::sleep(limit)));
        match stalled.as_mut().poll(cx) {
            Poll::Ready(()) => Poll::Ready(Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "the client stopped reading"))),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl<T: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for WriteStall<T> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<T: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for WriteStall<T> {
    fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        let written = std::pin::Pin::new(&mut self.inner).poll_write(cx, buf);
        self.bound(written, cx)
    }

    fn poll_write_vectored(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let written = std::pin::Pin::new(&mut self.inner).poll_write_vectored(cx, bufs);
        self.bound(written, cx)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        let flushed = std::pin::Pin::new(&mut self.inner).poll_flush(cx);
        self.bound(flushed, cx)
    }

    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        let shut = std::pin::Pin::new(&mut self.inner).poll_shutdown(cx);
        self.bound(shut, cx)
    }
}

fn keep_alive(stream: &mut tokio::net::TcpStream) {
    if let Err(e) = socket2::SockRef::from(&*stream).set_tcp_keepalive(&KEEPALIVE) {
        eprintln!("[listen] could not enable TCP keepalive on a connection: {e}");
    }
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route("/api/health", get(|| async { Json(json!({"ok":true})) }))
        .route("/api/chat", post(chat).layer(DefaultBodyLimit::max(CHAT_BODY_LIMIT)))
        .nest("/api/admin", crate::admin::router(app.clone()))
        .fallback(fallback)
        .with_state(app)
}

/// Unknown API paths answer JSON; any other GET is the built-in screen.
async fn fallback(method: Method, uri: Uri) -> Response {
    let api = uri.path() == "/api" || uri.path().starts_with("/api/");
    if api || !matches!(method, Method::GET | Method::HEAD) {
        return error(StatusCode::NOT_FOUND, "요청한 경로를 찾을 수 없습니다.");
    }
    crate::ui::serve(uri).await
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}

/// Saves a chat_log row in the background; when the management DB falls
/// behind, new rows are skipped rather than queued without bound.
pub fn record_chat_log(app: &Arc<App>, question: &str, answer: Option<String>, trace: Value) {
    if app.pending_logs.fetch_add(1, Ordering::AcqRel) >= MAX_PENDING_LOGS {
        app.pending_logs.fetch_sub(1, Ordering::AcqRel);
        eprintln!("[chat_log] {MAX_PENDING_LOGS} rows are still being written — skipping this one; check the management DB");
        return;
    }
    let app = app.clone();
    let question = crate::text::clip_utf16(question, MAX_QUESTION_LEN).to_owned();
    tokio::spawn(async move {
        let config = app.config();
        if let Err(e) =
            crate::db::insert_chat_log(&app.db, &config.mariadb, &question, answer.as_deref(), &trace).await
        {
            eprintln!("[chat_log] failed to record: {e}");
        }
        app.pending_logs.fetch_sub(1, Ordering::AcqRel);
    });
}

fn rejected(app: &Arc<App>, question: &str, reason: &str, length: Option<usize>) {
    let mut trace = json!({"v":5,"outcome":"rejected","reason":reason});
    if let Some(length) = length {
        trace["length"] = json!(length);
    }
    record_chat_log(app, question, None, trace);
}

fn conversation_id(body: &Value) -> String {
    body["conversation_id"]
        .as_str()
        .map(str::trim)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 100
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{ONE_SHOT_PREFIX}{}", uuid::Uuid::new_v4()))
}

fn history(body: &Value) -> Vec<(String, String)> {
    body["history"]
        .as_array()
        .map(|turns| {
            turns
                .iter()
                .filter_map(|t| Some((t["role"].as_str()?.to_owned(), t["text"].as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

async fn chat(State(app): State<Arc<App>>, headers: HeaderMap, body: Result<Bytes, axum::extract::rejection::BytesRejection>) -> Response {
    // JSON as JSON: another site's page can make the browser send a form or
    // text/plain POST here without asking first (a JSON one it must ask
    // about, and is refused), and read as JSON whatever its type, that ran a
    // question of its words — the model, registered queries, MCP tools that
    // file or send. The former server read only application/json bodies.
    if !is_json(&headers) {
        rejected(&app, "", "bad_content_type", None);
        return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "잘못된 요청입니다.");
    }
    let bytes = match body {
        Ok(bytes) => bytes,
        Err(rejection) => {
            let too_large = rejection.status() == StatusCode::PAYLOAD_TOO_LARGE;
            rejected(&app, "", if too_large { "body_too_large" } else { "bad_body" }, None);
            return if too_large {
                error(StatusCode::PAYLOAD_TOO_LARGE, "요청이 너무 큽니다. 새 대화로 다시 시도해주세요.")
            } else {
                error(StatusCode::BAD_REQUEST, "잘못된 요청입니다.")
            };
        }
    };
    let parsed: Option<Value> = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|text| serde_json::from_str(&strip_lone_surrogate_escapes(text)).ok());
    let Some(body) = parsed.filter(Value::is_object) else {
        rejected(&app, "", "bad_body", None);
        return error(StatusCode::BAD_REQUEST, "잘못된 요청입니다.");
    };
    let Some(raw) = body["message"].as_str() else {
        rejected(&app, "", "no_message", None);
        return error(StatusCode::BAD_REQUEST, "message가 필요합니다.");
    };
    let message = js_trim(raw).to_owned();
    if message.is_empty() {
        rejected(&app, raw, "empty_message", None);
        return error(StatusCode::BAD_REQUEST, "message가 필요합니다.");
    }
    let length = utf16_len(&message);
    if length > MAX_QUESTION_LEN {
        rejected(&app, &message, "too_long", Some(length));
        return error(StatusCode::BAD_REQUEST, "질문이 너무 깁니다 (최대 20,000자).");
    }
    let question = Question {
        conversation_id: conversation_id(&body),
        message: message.clone(),
        history: history(&body),
    };
    let stream = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains(NDJSON));
    let cancel = app.shutdown.child_token();
    if !stream {
        // The run has a task of its own, as in the stream below: a request
        // the client drops cancels it (the guard), and it then stops at its
        // next checkpoint and records the chat log. Dropped with the request
        // instead, it would stop mid-await — with a tool batch holding the
        // conversation's history on its thread, the conversation would keep
        // an empty one.
        let _guard = cancel.clone().drop_guard();
        let task_app = app.clone();
        let run = tokio::spawn(async move {
            let result = guarded(agent::answer(&task_app, question, Events::new(None), cancel.clone())).await;
            finish(&task_app, &message, result, &cancel)
        });
        return match run.await {
            Ok(Ok(done)) => Json(done).into_response(),
            Ok(Err((status, message))) => error(status, &message),
            Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, SERVER_ERROR),
        };
    }
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let task_app = app.clone();
    tokio::spawn(async move {
        let events = Events::new(Some(tx.clone()));
        let run = guarded(agent::answer(&task_app, question, events, cancel.clone()));
        tokio::pin!(run);
        let result = tokio::select! {
            result = &mut run => result,
            // The browser closed the stream (stop button, home, timeout).
            _ = tx.closed() => {
                cancel.cancel();
                run.await
            }
        };
        match finish(&task_app, &message, result, &cancel) {
            Ok(mut done) => {
                done["type"] = json!("done");
                let _ = tx.send(done);
            }
            Err((_, message)) if !cancel.is_cancelled() => {
                let _ = tx.send(json!({"type":"error","error":message}));
            }
            Err(_) => {}
        }
    });
    let lines = tokio_stream_from(rx).map(|event| {
        let mut line = event.to_string();
        line.push('\n');
        Ok::<_, std::convert::Infallible>(Bytes::from(line))
    });
    let mut response = Response::new(Body::from_stream(lines));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-ndjson; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform"));
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    response
}

/// Whether a request says its body is JSON (`application/json`, any
/// parameters after it).
fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|essence| essence.trim().eq_ignore_ascii_case("application/json"))
}

/// A run that panics ends as an error: the stream then still gets its error
/// event and the question its chat log, instead of a stream that just stops.
async fn guarded(run: impl std::future::Future<Output = anyhow::Result<Answer>>) -> anyhow::Result<Answer> {
    std::panic::AssertUnwindSafe(run)
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("panic: the run stopped unexpectedly")))
}

fn tokio_stream_from(mut rx: tokio::sync::mpsc::UnboundedReceiver<Value>) -> impl futures_util::Stream<Item = Value> {
    futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx))
}

/// The response body of a finished question, or the error to show; records
/// the chat log either way.
fn finish(app: &Arc<App>, message: &str, result: anyhow::Result<Answer>, cancel: &CancellationToken) -> Result<Value, (StatusCode, String)> {
    match result {
        Ok(answer) => {
            record_chat_log(app, message, Some(answer.answer.clone()), answer.log);
            let mut body = json!({"answer":answer.answer,"trace":answer.trace});
            if !answer.refs.is_empty() {
                body["refs"] = json!(answer.refs);
            }
            Ok(body)
        }
        Err(e) if cancel.is_cancelled() || e.to_string() == "cancelled" => {
            record_chat_log(app, message, None, json!({"v":5,"outcome":"cancelled"}));
            Err((StatusCode::INTERNAL_SERVER_ERROR, "cancelled".into()))
        }
        Err(e) => {
            let shown = match e.downcast_ref::<UserFacing>() {
                Some(user) => user.0.clone(),
                None => {
                    eprintln!("[chat error] {e:#}");
                    SERVER_ERROR.to_owned()
                }
            };
            record_chat_log(app, message, None, json!({"v":5,"outcome":"error","error":format!("{e:#}")}));
            Err((StatusCode::INTERNAL_SERVER_ERROR, shown))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn accepted_connections_probe_their_peer() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let _client = tokio::net::TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        let (mut accepted, _) = listener.accept().await.unwrap();
        assert!(!socket2::SockRef::from(&accepted).keepalive().unwrap());
        keep_alive(&mut accepted);
        assert!(socket2::SockRef::from(&accepted).keepalive().unwrap());
    }
}
