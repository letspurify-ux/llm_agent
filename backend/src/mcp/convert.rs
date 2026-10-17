//! An MCP tool result (`CallToolResult` as JSON) as the data of a tool
//! result the model receives.

use anyhow::{Result, bail};
use serde_json::{Value, json};

/// Characters of result text kept: about ten result budgets. More would only
/// grow the archive and the time spent counting its tokens.
pub const MAX_RESULT_CHARS: usize = 200_000;
/// Characters of a tool's own error message passed on.
const MAX_ERROR_CHARS: usize = 4_000;
/// Blocks named in `omitted_content`, and characters of each name: a result
/// of thousands of images (each type and address the server's text) would
/// otherwise be bounded only by the message.
const MAX_OMITTED: usize = 20;
const MAX_OMITTED_CHARS: usize = 300;

/// The result's text, or the tool's error. Text parts and text resources
/// are joined; images, audio and binary resources cannot go into a tool
/// message and are named in `omitted_content`. Structured content is sent
/// only when there is no text (a tool that returns it usually repeats it as
/// text).
pub fn tool_result(result: &Value) -> Result<Value> {
    let mut parts: Vec<String> = vec![];
    let mut omitted: Vec<String> = vec![];
    for block in result["content"].as_array().into_iter().flatten() {
        let kind = block["type"].as_str().unwrap_or("unknown");
        match kind {
            "text" => parts.push(block["text"].as_str().unwrap_or_default().to_owned()),
            "resource" => {
                let resource = &block["resource"];
                let uri = resource["uri"].as_str().unwrap_or("");
                match resource["text"].as_str() {
                    Some(text) => parts.push(format!("[resource {uri}]\n{text}")),
                    None => omitted.push(format!("resource {} {uri}", mime(resource))),
                }
            }
            "resource_link" => {
                let name = block["name"].as_str().unwrap_or("");
                let uri = block["uri"].as_str().unwrap_or("");
                let mut line = format!("[link] {name} <{uri}>");
                if let Some(description) = block["description"].as_str().filter(|d| !d.is_empty()) {
                    line.push_str(" — ");
                    line.push_str(description);
                }
                parts.push(line);
            }
            "image" | "audio" => omitted.push(format!("{kind} {}", mime(block))),
            other => omitted.push(other.to_owned()),
        }
    }
    let mut text = parts.join("\n\n");
    if text.trim().is_empty()
        && let Some(structured) = result.get("structuredContent").filter(|v| !v.is_null())
    {
        text = structured.to_string();
    }
    if result["isError"] == true {
        let message = if text.trim().is_empty() { "the tool reported an error without a message".to_owned() } else { clip(&text, MAX_ERROR_CHARS).0 };
        bail!("mcp_tool_error: {message}");
    }
    let (text, cut) = clip(&text, MAX_RESULT_CHARS);
    let mut data = json!({"text":text});
    if cut > 0 {
        data["text_cut_chars"] = json!(cut);
    }
    if !omitted.is_empty() {
        let more = omitted.len().saturating_sub(MAX_OMITTED);
        let mut named: Vec<String> = omitted.iter().take(MAX_OMITTED).map(|name| clip(name, MAX_OMITTED_CHARS).0).collect();
        if more > 0 {
            named.push(format!("... and {more} more"));
        }
        data["omitted_content"] = json!(named);
    }
    Ok(data)
}

fn mime(block: &Value) -> String {
    block["mimeType"].as_str().map_or_else(|| "(unknown type)".to_owned(), |m| format!("({m})"))
}

/// The first `limit` characters and how many were left out.
fn clip(text: &str, limit: usize) -> (String, usize) {
    let total = text.chars().count();
    if total <= limit {
        return (text.to_owned(), 0);
    }
    (text.chars().take(limit).collect(), total - limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    #[test]
    fn text_resources_and_links_are_joined_and_media_named() {
        let result = json!({"content":[
            {"type":"text","text":"see attachment"},
            {"type":"image","data":"AAAA","mimeType":"image/png"},
            {"type":"audio","data":"AAAA","mimeType":"audio/wav"},
            {"type":"resource","resource":{"uri":"file:///a.txt","mimeType":"text/plain","text":"resource body"}},
            {"type":"resource","resource":{"uri":"file:///b.pdf","mimeType":"application/pdf","blob":"JVBE"}},
            {"type":"resource_link","uri":"https://x/y","name":"y","description":"a link"}
        ]});
        let data = tool_result(&result).unwrap();
        assert_eq!(data["text"], "see attachment\n\n[resource file:///a.txt]\nresource body\n\n[link] y <https://x/y> — a link");
        assert_eq!(data["omitted_content"], json!(["image (image/png)", "audio (audio/wav)", "resource (application/pdf) file:///b.pdf"]));
    }

    #[test]
    fn structured_content_is_sent_only_without_text() {
        let both = json!({"content":[{"type":"text","text":"{\"sum\":3}"}],"structuredContent":{"sum":3}});
        assert_eq!(tool_result(&both).unwrap(), json!({"text":"{\"sum\":3}"}));
        let only = json!({"content":[],"structuredContent":{"ok":true}});
        assert_eq!(tool_result(&only).unwrap(), json!({"text":"{\"ok\":true}"}));
        assert_eq!(tool_result(&json!({})).unwrap(), json!({"text":""}));
    }

    #[test]
    fn a_tool_error_is_an_error_with_its_message() {
        let error = tool_result(&json!({"content":[{"type":"text","text":"boom"}],"isError":true})).unwrap_err();
        assert_eq!(error.to_string(), "mcp_tool_error: boom");
        let silent = tool_result(&json!({"isError":true})).unwrap_err();
        assert!(silent.to_string().starts_with("mcp_tool_error: the tool reported"));
    }

    #[test]
    fn random_results_never_panic() {
        use rand::{Rng, SeedableRng};
        let mut rng = rand::rngs::StdRng::seed_from_u64(3);
        let samples = [json!(null), json!(1), json!("t"), json!([]), json!({}), json!({"uri":5}), json!(true)];
        for _ in 0..5_000 {
            let blocks: Vec<Value> = (0..rng.gen_range(0..5))
                .map(|_| {
                    let mut block = Map::new();
                    for key in ["type", "text", "resource", "uri", "name", "description", "mimeType", "data"] {
                        if rng.gen_bool(0.5) {
                            let value = if key == "type" {
                                json!(["text", "image", "audio", "resource", "resource_link", "x", ""][rng.gen_range(0..7)])
                            } else {
                                samples[rng.gen_range(0..samples.len())].clone()
                            };
                            block.insert(key.into(), value);
                        }
                    }
                    Value::Object(block)
                })
                .collect();
            let mut result = json!({"content":blocks});
            if rng.gen_bool(0.3) {
                result["structuredContent"] = samples[rng.gen_range(0..samples.len())].clone();
            }
            if rng.gen_bool(0.2) {
                result["isError"] = samples[rng.gen_range(0..samples.len())].clone();
            }
            if rng.gen_bool(0.1) {
                result["content"] = samples[rng.gen_range(0..samples.len())].clone();
            }
            match tool_result(&result) {
                Ok(data) => assert!(data["text"].is_string(), "{result}"),
                Err(error) => assert!(error.to_string().starts_with("mcp_tool_error: "), "{result}"),
            }
        }
    }

    #[test]
    fn content_left_out_is_named_within_bounds() {
        let mut blocks = vec![json!({"type":"text","text":"several images"})];
        blocks.extend((0..5_000).map(|i| json!({"type":"image","data":"AAAA","mimeType":format!("image/png; name={}", "x".repeat(i))})));
        let data = tool_result(&json!({"content":blocks})).unwrap();
        let named = data["omitted_content"].as_array().unwrap();
        assert_eq!(named.len(), MAX_OMITTED + 1);
        assert!(named.iter().all(|n| n.as_str().unwrap().chars().count() <= MAX_OMITTED_CHARS), "{named:?}");
        assert_eq!(named[MAX_OMITTED], "... and 4980 more");
        assert_eq!(data["text"], "several images");
    }

    #[test]
    fn long_text_is_cut_with_the_count_left_out() {
        let data = tool_result(&json!({"content":[{"type":"text","text":"가".repeat(MAX_RESULT_CHARS + 5)}]})).unwrap();
        assert_eq!(data["text"].as_str().unwrap().chars().count(), MAX_RESULT_CHARS);
        assert_eq!(data["text_cut_chars"], 5);
    }
}
