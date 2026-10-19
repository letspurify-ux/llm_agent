//! LLM and embedding requests over HTTP, against a keep-alive HTTP/1.1
//! server that counts the connections it accepts: which connections they
//! take, and how much of an answer they read.

use llm_agent::{
    config::{EMBEDDING_DIMENSIONS, EmbeddingConfig, LlmConfig},
    embedding,
    llm::{LlmClient, OpenAiClient},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

/// How the server answers a request.
#[derive(Clone, Copy, PartialEq)]
enum Reply {
    /// The whole stream, its end sent a moment after [DONE] as servers do;
    /// for embeddings, a vector for each input.
    Whole,
    /// The whole stream, then the connection closed (no `Connection: close`
    /// said): a server ending an idle connection.
    WholeThenClose,
    /// The start of a stream that never goes on.
    Stalls,
    /// The vectors, padded with this many spaces.
    Padded(usize),
    /// A refusal of this status whose body goes on without end.
    RefusesEndlessly(u16),
}

struct Server {
    port: u16,
    accepted: Arc<AtomicUsize>,
    replies: Arc<Mutex<Vec<Reply>>>,
}

/// Requests are answered by the next of `replies`, then by Whole.
async fn server(replies: Vec<Reply>) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let replies = Arc::new(Mutex::new(replies));
    let (count, queue) = (accepted.clone(), replies.clone());
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            count.fetch_add(1, Ordering::SeqCst);
            let queue = queue.clone();
            tokio::spawn(async move {
                let mut bytes: Vec<u8> = vec![];
                let mut buffer = [0u8; 65536];
                loop {
                    let (head, body) = loop {
                        if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&bytes[..at]).into_owned();
                            let length = head
                                .lines()
                                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                                .unwrap_or(0);
                            if bytes.len() >= at + 4 + length {
                                let body = bytes[at + 4..at + 4 + length].to_vec();
                                bytes.drain(..at + 4 + length);
                                break (head, body);
                            }
                        }
                        let n = socket.read(&mut buffer).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buffer[..n]);
                    };
                    let body: Value = serde_json::from_slice(&body).unwrap();
                    let reply = {
                        let mut queue = queue.lock().unwrap();
                        if queue.is_empty() { Reply::Whole } else { queue.remove(0) }
                    };
                    let chunk = |text: &str| format!("{:x}\r\n{text}\r\n", text.len());
                    if let Reply::RefusesEndlessly(status) = reply {
                        let head = format!("HTTP/1.1 {status} Refused\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n");
                        let mut sent = socket.write_all(format!("{head}{}", chunk("refused: ")).as_bytes()).await;
                        let filler = chunk(&"x".repeat(60_000));
                        while sent.is_ok() {
                            sent = socket.write_all(filler.as_bytes()).await;
                        }
                        return;
                    }
                    if head.contains("/embeddings") {
                        let mut vector = vec![0.0f32; EMBEDDING_DIMENSIONS];
                        vector[0] = 1.0;
                        let data: Vec<Value> = (0..body["input"].as_array().unwrap().len()).map(|i| json!({"index":i,"embedding":vector})).collect();
                        let padding = match reply {
                            Reply::Padded(spaces) => " ".repeat(spaces),
                            _ => String::new(),
                        };
                        let text = format!("{{\"data\":{}{padding}}}", json!(data));
                        let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}", text.len());
                        if socket.write_all(reply.as_bytes()).await.is_err() {
                            return;
                        }
                        continue;
                    }
                    let event = |v: Value| format!("data: {v}\n\n");
                    let start = event(json!({"choices":[{"delta":{"content":"답"},"finish_reason":null}]}));
                    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
                    if reply == Reply::Stalls {
                        let _ = socket.write_all(format!("{head}{}", chunk(&start)).as_bytes()).await;
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    let rest = format!("{}data: [DONE]\n\n", event(json!({"choices":[{"delta":{},"finish_reason":"stop"}]})));
                    if socket.write_all(format!("{head}{}", chunk(&format!("{start}{rest}"))).as_bytes()).await.is_err() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    if socket.write_all(b"0\r\n\r\n").await.is_err() || reply == Reply::WholeThenClose {
                        return;
                    }
                }
            });
        }
    });
    Server { port, accepted, replies }
}

fn llm(port: u16) -> LlmConfig {
    LlmConfig {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        model: "connections".into(),
        disable_proxy: true,
        retries: 0,
        request_timeout_secs: 1,
        ..LlmConfig::default()
    }
}

fn embeddings(port: u16) -> EmbeddingConfig {
    EmbeddingConfig {
        url: format!("http://127.0.0.1:{port}/v1"),
        ..EmbeddingConfig::default()
    }
}

async fn ask(config: &LlmConfig) -> anyhow::Result<String> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let request = json!({"model":"connections","messages":[{"role":"user","content":"질문"}]});
    Ok(OpenAiClient.complete(request, config, CancellationToken::new(), tx).await?.text)
}

/// Resource review, seventh pass: every LLM and embedding request made an
/// HTTP client of its own, which opened and closed a connection of its own
/// — a TCP (and TLS) handshake and a DNS lookup per request (49 ms instead
/// of 26 ms a chat request over a 20 ms link), and a socket left in
/// TIME_WAIT each time. A streamed response was dropped at its [DONE],
/// before the end that follows, which closes its connection too.
#[tokio::test]
async fn requests_take_the_connection_the_previous_one_left() {
    let server = server(vec![]).await;
    let config = llm(server.port);
    for _ in 0..5 {
        assert_eq!(ask(&config).await.unwrap(), "답");
        // The next request follows the tools a response called.
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(server.accepted.swap(0, Ordering::SeqCst), 1, "five chat requests on one connection");
    for i in 0..5 {
        embedding::embed(&embeddings(server.port), &[format!("text {i}")], &CancellationToken::new()).await.unwrap();
    }
    assert_eq!(server.accepted.load(Ordering::SeqCst), 1, "five embedding requests on one connection");
}

/// What a connection taken again must not be: one whose response was left
/// unfinished, or one the server has closed since.
#[tokio::test]
async fn a_connection_left_unfinished_or_closed_is_not_taken_again() {
    let server = server(vec![Reply::Stalls, Reply::Whole, Reply::WholeThenClose, Reply::WholeThenClose]).await;
    let config = llm(server.port);
    let stalled = ask(&config).await.unwrap_err().to_string();
    assert!(stalled.starts_with("request_timeout"), "{stalled}");
    for _ in 0..3 {
        assert_eq!(ask(&config).await.unwrap(), "답");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // The stalled one, one for the next two replies (closed after the
    // second), and a new one for the last.
    assert_eq!(server.accepted.load(Ordering::SeqCst), 3);
    assert!(server.replies.lock().unwrap().is_empty());
}

/// Resource review, seventh pass: an embedding answer was read to 256 MiB
/// whatever was asked, and parsed into JSON values about ten times its size
/// — gigabytes from a wrong server for one search's vector. A connection
/// check's refusal was read whole before it was cut, until the request
/// timeout ran out, and then said nothing of it.
#[tokio::test]
async fn answers_are_read_as_far_as_their_request_needs() {
    let embedder = server(vec![Reply::Padded(2 * 1024 * 1024), Reply::Padded(64 * 1024), Reply::RefusesEndlessly(503)]).await;
    let config = embeddings(embedder.port);
    let one = |text: &str| vec![text.to_owned()];
    let large = embedding::embed(&config, &one("검색어"), &CancellationToken::new()).await.unwrap_err();
    assert_eq!((large.message.as_str(), large.retriable), ("임베딩 응답이 너무 큽니다", false));
    // An answer as servers may write it is read whole.
    assert_eq!(embedding::embed(&config, &one("검색어"), &CancellationToken::new()).await.unwrap().len(), 1);
    let started = Instant::now();
    let refused = embedding::embed(&config, &one("검색어"), &CancellationToken::new()).await.unwrap_err();
    assert!(refused.message.starts_with("embeddings API 503: refused: xxx") && refused.retriable, "{}", refused.message);
    assert!(started.elapsed() < Duration::from_secs(5), "a refusal's start is enough: {:?}", started.elapsed());

    let refusing = server(vec![Reply::RefusesEndlessly(400)]).await;
    let mut checked = llm(refusing.port);
    checked.request_timeout_secs = 10;
    let started = Instant::now();
    let refused = OpenAiClient.probe(&checked).await.unwrap_err().to_string();
    assert!(refused.contains("http_400: refused: xxx"), "{refused}");
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
}
