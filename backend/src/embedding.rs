//! OpenAI-compatible embeddings (Ollama by default). Vectors are checked for
//! the table width and normalized in float32, as stored.

use crate::config::{EMBEDDING_DIMENSIONS, EmbeddingConfig};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

/// Longest text embedded (UTF-16 units); longer texts are cut.
pub const MAX_EMBED_TEXT_LEN: usize = 4000;
const MAX_RESPONSE_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct EmbedError {
    pub message: String,
    /// The server may answer later (5xx, 429, network, timeout).
    pub retriable: bool,
}
impl std::fmt::Display for EmbedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for EmbedError {}

fn error(message: impl Into<String>, retriable: bool) -> EmbedError {
    EmbedError {
        message: message.into(),
        retriable,
    }
}

/// The vector normalized to unit length in float32, or None when it has the
/// wrong width or no finite positive norm.
pub fn normalize(values: &[Value]) -> Option<Vec<f32>> {
    if values.len() != EMBEDDING_DIMENSIONS {
        return None;
    }
    let mut floats = Vec::with_capacity(values.len());
    let mut norm2 = 0f64;
    for value in values {
        let f = value.as_f64()?;
        if !f.is_finite() {
            return None;
        }
        let f = f as f32;
        if !f.is_finite() {
            return None;
        }
        norm2 += f64::from(f) * f64::from(f);
        floats.push(f);
    }
    let norm2_f32 = norm2 as f32;
    if !(norm2_f32 > 0.0 && norm2_f32.is_finite()) {
        return None;
    }
    let norm = norm2.sqrt();
    Some(floats.into_iter().map(|f| (f64::from(f) / norm) as f32).collect())
}

/// The text form `VEC_FromText` reads.
pub fn vector_text(vector: &[f32]) -> String {
    serde_json::to_string(vector).unwrap_or_else(|_| "[]".into())
}

fn embeddings_url(base: &str) -> String {
    format!("{}/embeddings", base.trim_end_matches('/'))
}

pub async fn embed(
    cfg: &EmbeddingConfig,
    texts: &[String],
    cancel: &CancellationToken,
) -> Result<Vec<Vec<f32>>, EmbedError> {
    if !cfg.enabled() {
        return Err(error("임베딩 주소가 설정되지 않았습니다", false));
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| error(e.to_string(), false))?;
    let work = async {
        let response = client
            .post(embeddings_url(&cfg.url))
            .json(&json!({"model":cfg.model,"input":texts}))
            .send()
            .await
            .map_err(|e| error(format!("임베딩 서버에 연결하지 못했습니다: {e}"), true))?;
        let status = response.status();
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| error(format!("임베딩 응답을 읽지 못했습니다: {e}"), true))?;
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(error("임베딩 응답이 너무 큽니다", false));
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let retriable = status.is_server_error() || status.as_u16() == 429;
            let body: String = String::from_utf8_lossy(&bytes).chars().take(200).collect();
            return Err(error(format!("embeddings API {}: {body}", status.as_u16()), retriable));
        }
        let data: Value = serde_json::from_slice(&bytes)
            .map_err(|e| error(format!("임베딩 응답이 JSON이 아닙니다: {e}"), false))?;
        let Some(items) = data["data"].as_array() else {
            return Err(error("임베딩 응답 data는 벡터 항목 배열이어야 합니다", false));
        };
        if items.len() != texts.len() {
            return Err(error(
                format!("임베딩 응답 개수 불일치: 요청 {}건, 응답 {}건", texts.len(), items.len()),
                false,
            ));
        }
        let mut ordered: Vec<&Value> = items.iter().collect();
        ordered.sort_by_key(|item| item["index"].as_u64().unwrap_or(0));
        if ordered
            .iter()
            .enumerate()
            .any(|(i, item)| item["index"].as_u64() != Some(i as u64))
        {
            return Err(error("임베딩 응답 index가 중복되거나 누락되거나 범위를 벗어났습니다", false));
        }
        ordered
            .into_iter()
            .map(|item| {
                item["embedding"]
                    .as_array()
                    .and_then(|v| normalize(v))
                    .ok_or_else(|| {
                        error(
                            format!("임베딩 벡터는 {EMBEDDING_DIMENSIONS}차원이며 FP32에서 유한한 양의 제곱합을 가져야 합니다"),
                            false,
                        )
                    })
            })
            .collect()
    };
    tokio::select! {
        _ = cancel.cancelled() => Err(error("cancelled", false)),
        result = tokio::time::timeout(Duration::from_secs(cfg.timeout_secs), work) => match result {
            Ok(result) => result,
            Err(_) => Err(error(format!("임베딩 응답이 {}초 안에 끝나지 않았습니다", cfg.timeout_secs), true)),
        }
    }
}

/// Search-text embeddings of recent questions (repeated searches in one
/// conversation reuse them).
#[derive(Default)]
pub struct QueryCache {
    entries: Mutex<VecDeque<(String, Arc<Vec<f32>>)>>,
}
impl QueryCache {
    const MAX: usize = 100;

    /// The embedding of a search text with the configured prefix, or the
    /// reason search cannot run.
    pub async fn embed(
        &self,
        cfg: &EmbeddingConfig,
        text: &str,
        cancel: &CancellationToken,
    ) -> Result<Arc<Vec<f32>>, EmbedError> {
        let input = crate::text::clip_utf16(&format!("{}{text}", cfg.decoded_prefix()), MAX_EMBED_TEXT_LEN).to_owned();
        let key = serde_json::to_string(&(&cfg.url, &cfg.model, &input)).unwrap_or_default();
        {
            let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(at) = entries.iter().position(|(k, _)| *k == key) {
                let hit = entries.remove(at).unwrap();
                let vector = hit.1.clone();
                entries.push_back(hit);
                return Ok(vector);
            }
        }
        let vector = Arc::new(embed(cfg, &[input], cancel).await?.remove(0));
        let mut entries = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        while entries.len() >= Self::MAX {
            entries.pop_front();
        }
        entries.push_back((key, vector.clone()));
        Ok(vector)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vectors_are_normalized_and_checked() {
        let mut raw = vec![json!(0.0); EMBEDDING_DIMENSIONS];
        raw[0] = json!(3.0);
        raw[1] = json!(4.0);
        let v = normalize(&raw).unwrap();
        assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);
        assert!(normalize(&vec![json!(0.0); EMBEDDING_DIMENSIONS]).is_none());
        assert!(normalize(&[json!(1.0)]).is_none());
        assert_eq!(vector_text(&[0.5, -1.0]), "[0.5,-1.0]");
        assert_eq!(embeddings_url("http://x/v1/"), "http://x/v1/embeddings");
    }
}
