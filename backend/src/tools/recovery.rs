//! Shared recovery contract (from MnemoArc, without memory, plan, checkpoint
//! and document codes). Classification guides the model; it never retries on
//! the model's behalf or relaxes validation.
use super::*;
use serde::Serialize;
use std::collections::VecDeque;

/// Structured failure details survive the common envelope.
/// Display retains the stable prefix used by recovery classification.
#[derive(Debug)]
pub(crate) struct DiagnosticError {
    pub message: String,
    pub data: Value,
}

impl std::fmt::Display for DiagnosticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DiagnosticError {}

pub(super) fn is_failure(result: &Value) -> bool {
    matches!(
        result["status"].as_str(),
        Some("error" | "cancelled" | "unsupported")
    )
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Class {
    InvalidInput,
    Prerequisite,
    MissingPath,
    StaleState,
    Capacity,
    Unavailable,
    Cancelled,
    Transient,
    Unclassified,
}

/// The leading snake_case code of an error message. A code may end at ':'
/// or at ';'.
pub fn error_code(message: &str) -> &str {
    let prefix = message.split([':', ';']).next().unwrap_or("");
    if !prefix.is_empty()
        && prefix.len() <= 80
        && prefix.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
    {
        prefix
    } else {
        "tool_error"
    }
}

/// Unknown errors default to inspection, never to an assumed safe retry.
pub fn describe(message: &str) -> Value {
    let code = error_code(message);
    let (class, action) = if code == "cancelled" {
        (Class::Cancelled, "stop")
    } else if code == "tool_worker_panic" {
        (Class::Unclassified, "inspect_error_before_retry")
    } else if code == "file_not_found" || code == "project_not_found" {
        (Class::MissingPath, "resolve_path")
    } else if code == "project_required" {
        (Class::InvalidInput, "choose_project")
    } else if code == "file_permission_denied" || code == "file_access_error" {
        (Class::Unavailable, "check_file_permissions")
    } else if code == "path_is_directory" {
        (Class::InvalidInput, "select_file_from_directory")
    } else if matches!(
        code,
        "unsupported_binary_file" | "unsupported_large_file" | "unsupported_file_type"
    ) {
        (Class::Unavailable, "choose_allowed_path")
    } else if matches!(code, "path_outside_project" | "path_excluded") {
        (Class::InvalidInput, "choose_allowed_path")
    } else if matches!(
        code,
        "cursor_arguments_conflict" | "conflicting_arguments" | "ambiguous_file_read_range"
    ) {
        (Class::InvalidInput, "correct_arguments")
    } else if code == "unknown_symbol" || code == "invalid_symbol_id" {
        (Class::InvalidInput, "copy_observed_symbol_id")
    } else if code == "history_unavailable" {
        (Class::StaleState, "repeat_the_original_call")
    } else if matches!(
        code,
        "search_too_broad" | "outline_too_broad" | "navigation_too_broad" | "scope_timeout"
    ) {
        (Class::Capacity, "narrow_the_scope")
    } else if matches!(
        code,
        "search_unavailable" | "database_unavailable" | "embedding_unavailable"
    ) {
        (Class::Unavailable, "answer_with_gathered_evidence")
    } else if matches!(code, "query_not_found" | "unknown_item") {
        (Class::InvalidInput, "search_before_reading")
    } else if code == "query_unrunnable" {
        (Class::Prerequisite, "choose_another_query_or_answer")
    } else if code == "bind_value_problem" || code == "target_db_required" {
        (Class::InvalidInput, "correct_arguments")
    } else if code == "repeated_call" {
        (Class::InvalidInput, "use_previous_result")
    } else if code.contains("conflict")
        || code.contains("changed")
        || code.contains("stale")
        || code.ends_with("_expired")
        || matches!(code, "invalid_cursor" | "cursor_expired")
    {
        (Class::StaleState, "refresh_matching_state")
    } else if code.contains("capacity") || code.contains("limit") || code.contains("budget") {
        (Class::Capacity, "narrow_the_scope")
    } else if code.starts_with("unsupported") {
        (Class::Unavailable, "use_available_tools")
    } else if code.contains("timeout") {
        (Class::Transient, "inspect_timeout_before_retry")
    } else if code.starts_with("invalid_")
        || code.starts_with("missing_")
        || code.starts_with("unknown_argument")
        || code == "conflicting_arguments"
    {
        (Class::InvalidInput, "correct_arguments")
    } else {
        (Class::Unclassified, "inspect_error_before_retry")
    };
    json!({"code":code,"class":class,"action":action,"automatic_retry":false})
}

/// Tools that usually resolve a failure of the given code, limited to the
/// tools this request offers.
pub fn attach(offered: &[String], result: &mut Value) {
    if result["status"] == "ok" || !result["recovery"].is_object() {
        return;
    }
    let code = result["recovery"]["code"].as_str().unwrap_or("");
    let hints: &[&str] = match code {
        "file_not_found" | "path_excluded" | "path_outside_project" | "path_is_directory" => {
            &["file_list", "source_search"]
        }
        "unknown_symbol" | "invalid_symbol_id" | "symbol_revision_conflict" => {
            &["code_outline", "symbol_search"]
        }
        "query_not_found" | "unknown_item" => &["search"],
        "history_unavailable" => &["file_read"],
        _ => &[],
    };
    let tools: Vec<&str> = hints
        .iter()
        .copied()
        .filter(|hint| offered.iter().any(|name| name == hint))
        .collect();
    if !tools.is_empty() {
        result["recovery"]["tools"] = json!(tools);
    }
}

/// Repeated failures within one question: the same failing call is marked
/// so the model changes approach instead of resending it.
#[derive(Default)]
pub struct FailureTracker {
    recent: VecDeque<(String, [u8; 32])>,
}

impl FailureTracker {
    const RECENT_CALLS: usize = 64;

    /// Records a finished call; a failure repeated with identical arguments
    /// is annotated.
    pub fn observe(&mut self, name: &str, arguments: &str, result: &mut Value) {
        if !is_failure(result) || result["status"] == "cancelled" {
            return;
        }
        let digest: [u8; 32] = Sha256::digest(arguments.as_bytes()).into();
        let key = (name.to_owned(), digest);
        if self.recent.contains(&key) {
            result["repeated_failure"] = json!(true);
            result["guidance"] = json!(
                "This exact call already failed in this question. Do not resend it unchanged: correct the arguments the error names, use another tool, or answer with what is known."
            );
        } else {
            if self.recent.len() == Self::RECENT_CALLS {
                self.recent.pop_front();
            }
            self.recent.push_back(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_classified() {
        assert_eq!(describe("file_not_found: x")["action"], "resolve_path");
        assert_eq!(describe("cursor_expired: x")["class"], "stale_state");
        assert_eq!(describe("Something odd")["code"], "tool_error");
    }

    #[test]
    fn identical_failures_are_marked_and_tools_still_run() {
        let mut tracker = FailureTracker::default();
        let mut first = json!({"status":"error","error":"x"});
        tracker.observe("file_read", "{}", &mut first);
        assert!(first.get("repeated_failure").is_none());
        let mut second = json!({"status":"error","error":"x"});
        tracker.observe("file_read", "{}", &mut second);
        assert_eq!(second["repeated_failure"], true);
        // However often a tool fails with other arguments, a new call is not
        // marked: the tool is never refused.
        for i in 0..20 {
            tracker.observe("file_read", &format!("{{\"a\":{i}}}"), &mut json!({"status":"error"}));
        }
        let mut fresh = json!({"status":"error","error":"x"});
        tracker.observe("file_read", "{\"b\":1}", &mut fresh);
        assert!(fresh.get("repeated_failure").is_none());
    }
}
