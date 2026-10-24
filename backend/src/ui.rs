//! The screen built into the binary (see build.rs): `/` is index.html, other
//! paths are the files Vite wrote under frontend/dist.

use crate::{config::AssistantConfig, text::js_trim};
use axum::{
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

include!(concat!(env!("OUT_DIR"), "/ui_assets.rs"));

fn content_type(name: &str) -> &'static str {
    match name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// What the screen shows of the settings' role: `/api/assistant`, and the
/// meta tag of index.html that has it before any request. The tool groups
/// tell the admin screen which tabs to show.
pub fn profile(assistant: &AssistantConfig) -> Value {
    json!({
        "name":js_trim(&assistant.name),
        "subtitle":js_trim(&assistant.subtitle),
        "examples":assistant.examples.iter().map(|e| js_trim(e)).collect::<Vec<_>>(),
        "knowledge":assistant.knowledge,
        "database":assistant.database,
    })
}

fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// index.html with the role's name as its title and the profile in a meta
/// tag: the first paint already shows the settings' name, not the one
/// built into the page, which a fetch would replace a moment later.
fn personalized(html: &[u8], assistant: &AssistantConfig) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(html).ok()?;
    let start = text.find("<title>")?;
    let end = start + text[start..].find("</title>")? + "</title>".len();
    let tag = format!(
        "<title>{}</title><meta name=\"assistant-profile\" content=\"{}\" />",
        escape_html(js_trim(&assistant.name)),
        escape_html(&profile(assistant).to_string())
    );
    Some([&text[..start], &tag, &text[end..]].concat().into_bytes())
}

pub async fn serve(uri: Uri, assistant: &AssistantConfig) -> Response {
    let name = match uri.path() {
        "/" | "/index.html" => "index.html",
        path => path.trim_start_matches('/'),
    };
    if name == "index.html"
        && let Some((_, bytes)) = ASSETS.iter().find(|(path, _)| *path == name)
        && let Some(page) = personalized(bytes, assistant)
    {
        return (
            [
                (header::CONTENT_TYPE, content_type(name)),
                (header::CACHE_CONTROL, "no-cache"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            page,
        )
            .into_response();
    }
    if let Some((_, bytes)) = ASSETS.iter().find(|(path, _)| *path == name) {
        // Vite names files under assets/ by content hash: they never change
        // under the same name. index.html is checked every time so a new
        // binary's screen is picked up on the next load.
        let cache = if name.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        return (
            [
                (header::CONTENT_TYPE, content_type(name)),
                (header::CACHE_CONTROL, cache),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            *bytes,
        )
            .into_response();
    }
    if name == "index.html" && ASSETS.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "화면이 빌드되지 않았습니다. frontend에서 npm run build 후 백엔드를 다시 빌드하거나, 개발 중이면 Vite 개발 서버(frontend/start.sh)를 쓰세요.",
        )
            .into_response();
    }
    StatusCode::NOT_FOUND.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_carries_the_settings_name_and_profile_escaped() {
        let assistant = AssistantConfig { name: " <SPACE> & \"Co\" ".into(), examples: vec!["a'b".into()], ..Default::default() };
        let page = personalized(b"<head><title>AI Assistant</title><style></style></head>", &assistant).unwrap();
        let page = String::from_utf8(page).unwrap();
        assert!(page.starts_with("<head><title>&lt;SPACE&gt; &amp; &quot;Co&quot;</title><meta name=\"assistant-profile\" content=\""), "{page}");
        assert!(page.ends_with("\" /><style></style></head>"));
        let content = page.split("content=\"").nth(1).unwrap().split('"').next().unwrap();
        assert!(!content.contains(['<', '>', '\'']));
        let decoded = content.replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
        let profile: Value = serde_json::from_str(&decoded).unwrap();
        assert_eq!(profile["name"], "<SPACE> & \"Co\"");
        assert_eq!(profile["examples"], json!(["a'b"]));
        assert_eq!(profile["knowledge"], true);
        // A page without a title is served as built.
        assert!(personalized(b"<head></head>", &assistant).is_none());
    }

    #[test]
    fn types_follow_the_extension() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("assets/index-AbC.JS"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("assets/KaTeX_Main-Regular.woff2"), "font/woff2");
        assert_eq!(content_type("LICENSE"), "application/octet-stream");
    }
}
