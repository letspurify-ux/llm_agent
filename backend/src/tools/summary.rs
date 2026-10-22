//! One-line descriptions of tool calls for the progress a running task
//! shows. They are built from each call's own arguments, so they cost no
//! model tokens and say what was actually requested; the model never sees
//! them.
use serde_json::Value;
use std::path::Path;

/// Longest description shown; longer ones end in "…".
const MAX_CHARS: usize = 120;

/// The tool's label with what this call reads, searches or changes, such as
/// "파일 읽기 src/ui/menu.rs:100-299". Paths under `root` are shown relative
/// to it.
pub fn call_summary(root: &Path, name: &str, arguments: &str) -> String {
    let args: Value = serde_json::from_str(arguments).unwrap_or(Value::Null);
    let path = |key: &str| relative(root, args[key].as_str().unwrap_or(""));
    let detail = match name {
        "file_read" => {
            let target = path("path");
            // A continuation may carry only its cursor.
            if target.is_empty() {
                if args["cursor"].is_string() {
                    "이어 읽기".to_owned()
                } else {
                    String::new()
                }
            } else {
                format!("{target}{}", range(&args))
            }
        }
        "file_list" => args["path_glob"]
            .as_str()
            .or(args["pattern"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| path("path")),
        "source_search" => {
            let query = match &args["queries"] {
                Value::Array(queries) => queries
                    .iter()
                    .map(quoted)
                    .filter(|query| !query.is_empty())
                    .collect::<Vec<_>>()
                    .join(" | "),
                _ => quoted(&args["query"]),
            };
            // pattern is the legacy name of path_glob, a file glob: shown as
            // the search words, it hid the scope the call searched.
            let scope = args["path_glob"]
                .as_str()
                .or(args["pattern"].as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| path("path"));
            join([query, scope])
        }
        "history" => match args["action"].as_str() {
            Some("search") => quoted(&args["query"]),
            _ => args["id"].as_u64().map_or_else(String::new, |id| format!("#{id}")),
        },
        "search" => quoted(&args["query"]),
        "knowledge_read" => match args["cursor"].as_str().and_then(|c| c.split_once(':')) {
            // A continuation carries its document and chunk in the cursor.
            Some((doc, chunk)) if args["id"].is_null() => {
                format!("{doc} {}번째 조각부터 이어 읽기", chunk.split('@').next().unwrap_or(chunk))
            }
            _ => join([
                args["id"].as_str().unwrap_or("").to_owned(),
                args["start_chunk"]
                    .as_u64()
                    .map_or_else(String::new, |n| format!("{n}번째 조각부터")),
            ]),
        },
        "method_read" | "query_describe" => {
            let key = if name == "method_read" { "ids" } else { "names" };
            args[key]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default()
        }
        "result_read" => args["step"]
            .as_u64()
            .map_or_else(String::new, |step| format!("실행 {step}")),
        _ => String::new(),
    };
    let project = args["project"]
        .as_str()
        .filter(|p| !p.trim().is_empty())
        .map(|p| format!("[{p}]"))
        .unwrap_or_default();
    clip(&join([project, label(name).to_owned(), detail]))
}

/// Korean names of the tools, as the progress lines show them.
pub fn label(name: &str) -> &str {
    match name {
        "file_list" => "파일 목록",
        "file_read" => "파일 읽기",
        "source_search" => "소스 검색",
        "history" => "지난 결과 다시 보기",
        "search" => "자료 검색",
        "knowledge_read" => "지식 읽기",
        "method_read" => "처리 방법 읽기",
        "query_describe" => "쿼리 정의 보기",
        "query_run" => "쿼리 실행",
        "result_read" => "조회 결과 읽기",
        other => other,
    }
}

/// ":start-end" from start_line with max_lines or end_line; ":start-" when
/// only the start is given; "" for a whole file. Providers send numbers as
/// strings too.
fn range(args: &Value) -> String {
    let number = |key: &str| match &args[key] {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    };
    let start = number("start_line");
    // limit is a name for max_lines that file_read accepts.
    let lines = number("max_lines").or_else(|| number("limit"));
    // Saturating: this runs outside the tool's panic guard, and a model can
    // send any number.
    let end = number("end_line")
        .or_else(|| lines.map(|lines| start.unwrap_or(1).saturating_add(lines.saturating_sub(1))));
    match (start, end) {
        (None, None) => String::new(),
        (start, Some(end)) => format!(":{}-{end}", start.unwrap_or(1)),
        (Some(start), None) => format!(":{start}-"),
    }
}

/// `path` without the project root and its separator. Both are compared in
/// display form, so a Windows root kept as \\?\C:\… matches the C:\… a model
/// sends, and Windows paths match regardless of letter case. The root itself
/// reads as "" (the tool's label alone).
fn relative(root: &Path, path: &str) -> String {
    let root = crate::paths::display_path(root);
    let root = root.trim_end_matches(['/', '\\']);
    let path = crate::paths::display_text(path);
    let windows = root.contains('\\');
    let same = |head: &str| {
        if windows {
            // A model may write C:/work/app for C:\work\app.
            head.replace('/', "\\").eq_ignore_ascii_case(root)
        } else {
            head == root
        }
    };
    match (path.get(..root.len()), path.get(root.len()..)) {
        (Some(head), Some(rest))
            if !root.is_empty()
                && same(head)
                && (rest.is_empty() || rest.starts_with(['/', '\\'])) =>
        {
            rest.trim_start_matches(['/', '\\']).to_owned()
        }
        _ => path.into_owned(),
    }
}

fn quoted(value: &Value) -> String {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map_or_else(String::new, |text| format!("\"{text}\""))
}

fn join<const N: usize>(parts: [String; N]) -> String {
    parts
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn clip(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= MAX_CHARS {
        return text;
    }
    let mut clipped: String = text.chars().take(MAX_CHARS - 1).collect();
    clipped.push('…');
    clipped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summaries_name_the_project_tool_and_range() {
        let root = Path::new("/work/app");
        assert_eq!(
            call_summary(root, "file_read", r#"{"project":"app","path":"/work/app/src/a.rs","start_line":10,"max_lines":5}"#),
            "[app] 파일 읽기 src/a.rs:10-14"
        );
        assert_eq!(
            call_summary(root, "source_search", r#"{"queries":["a","b"],"path_glob":"src/**"}"#),
            "소스 검색 \"a\" | \"b\" src/**"
        );
        assert_eq!(
            call_summary(root, "source_search", r#"{"query":"fn run","pattern":"src/**/*.rs"}"#),
            "소스 검색 \"fn run\" src/**/*.rs"
        );
        assert_eq!(call_summary(root, "result_read", r#"{"step":3}"#), "조회 결과 읽기 실행 3");
        assert_eq!(call_summary(root, "knowledge_read", r#"{"id":"k8"}"#), "지식 읽기 k8");
        assert_eq!(call_summary(root, "knowledge_read", r#"{"cursor":"k32:39"}"#), "지식 읽기 k32 39번째 조각부터 이어 읽기");
        assert_eq!(call_summary(root, "unknown", "not json"), "unknown");
    }
}
