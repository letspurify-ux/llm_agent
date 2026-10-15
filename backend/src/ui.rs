//! The screen built into the binary (see build.rs): `/` is index.html, other
//! paths are the files Vite wrote under frontend/dist.

use axum::{
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
};

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

pub async fn serve(uri: Uri) -> Response {
    let name = match uri.path() {
        "/" | "/index.html" => "index.html",
        path => path.trim_start_matches('/'),
    };
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
    fn types_follow_the_extension() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("assets/index-AbC.JS"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("assets/KaTeX_Main-Regular.woff2"), "font/woff2");
        assert_eq!(content_type("LICENSE"), "application/octet-stream");
    }
}
