//! Read-only source tools, ported from MnemoArc with its argument repair,
//! validation, recovery hints and result bounding. Project file writes,
//! documents, memory, plans and checkpoints are not part of this agent.
//!
//! Every source tool takes a `project`: the agent resolves it to one of the
//! configured projects and runs the tool against that project's root.

mod arguments;
pub mod recovery;
mod search;
mod suggest;
pub mod summary;

use crate::{config::Project, context};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::{Path, PathBuf},
};
pub use summary::call_summary;

#[derive(Clone, Debug)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// Source tools need a configured project.
    pub source: bool,
    pub parameters: Value,
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn schema(fields: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":fields,"required":required,"additionalProperties":false})
}
pub(crate) fn string() -> Value {
    json!({"type":"string"})
}
fn legacy_pattern(instead: &str) -> Value {
    json!({"type":"string","description":format!("Legacy alias of path_glob: a file-path glob such as src/**/*.rs, never {instead}")})
}
pub(crate) fn number() -> Value {
    json!({"type":"integer","minimum":0})
}
pub(crate) fn action(values: &[&str]) -> Value {
    json!({"type":"string","enum":values})
}
fn project_field() -> Value {
    json!({"type":"string","description":"Project name from the runtime state's projects. May be omitted only when exactly one project is configured."})
}

/// With two or more projects a source call must name one, so the definitions
/// sent to the model require `project` and list the configured names: an
/// omitted or misspelt project is otherwise refused and costs a request.
pub fn require_project(definitions: &mut [Value], projects: &[Project]) {
    if projects.len() < 2 {
        return;
    }
    let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
    for definition in definitions {
        let parameters = &mut definition["function"]["parameters"];
        if parameters["properties"].get("project").is_none() {
            continue;
        }
        parameters["properties"]["project"] = json!({"type":"string","enum":names,"description":"Project name from the runtime state's projects (a file_read cursor keeps the project it was issued in)."});
        if let Some(required) = parameters["required"].as_array_mut()
            && !required.iter().any(|field| field == "project")
        {
            required.insert(0, json!("project"));
        }
    }
}

/// Limits a tool call works within.
#[derive(Clone, Debug)]
pub struct ToolConfig {
    pub model: String,
    pub result_tokens: usize,
    pub tool_timeout_secs: u64,
}

/// Identical unchanged reads already in context before another is
/// suppressed (force_read reads anyway).
pub const REPEATED_READ_LIMIT: usize = 2;

/// Blocking source work (a batch's calls, the search for their projects)
/// that a stopped question gave up waiting for and that has not returned:
/// a read stuck in a file system that stopped answering. While any is out,
/// source calls are refused before they touch the file system, so a hang
/// leaves one stuck thread, not one more for every question asked during
/// it (each held a thread of the blocking pool that other work shares).
static STUCK_SOURCE_WORK: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// The refusal of a source call while earlier source work is stuck.
pub const SOURCE_STUCK: &str = "source_unavailable: an earlier source tool call is still waiting on a project's file system (a network drive not answering?); source tools are paused until it returns. Answer without them, or ask again later";

/// Whether source calls are paused (see `STUCK_SOURCE_WORK`).
pub fn source_stuck() -> bool {
    STUCK_SOURCE_WORK.load(std::sync::atomic::Ordering::SeqCst) > 0
}

/// One piece of blocking source work, as its waiter and its thread share
/// it: the thread ends it (`Ending`, on unwind too), the waiter may give up
/// on it first (`abandon`); work given up on counts as stuck until it ends.
#[derive(Clone, Default)]
pub struct SourceWork(std::sync::Arc<std::sync::atomic::AtomicU8>);
const WORK_RUNNING: u8 = 0;
const WORK_DONE: u8 = 1;
const WORK_ABANDONED: u8 = 2;
impl SourceWork {
    /// Called when the waiter stops waiting. Counted first, so the thread's
    /// release always follows its count.
    pub fn abandon(&self) {
        use std::sync::atomic::Ordering::SeqCst;
        STUCK_SOURCE_WORK.fetch_add(1, SeqCst);
        if self.0.compare_exchange(WORK_RUNNING, WORK_ABANDONED, SeqCst, SeqCst).is_err() {
            // It ended meanwhile.
            STUCK_SOURCE_WORK.fetch_sub(1, SeqCst);
        }
    }
    /// Held by the thread for as long as it works.
    pub fn ending(&self) -> SourceWorkEnding {
        SourceWorkEnding(self.clone())
    }
}
/// Ends its work when dropped.
pub struct SourceWorkEnding(SourceWork);
impl Drop for SourceWorkEnding {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering::SeqCst;
        if self.0.0.swap(WORK_DONE, SeqCst) == WORK_ABANDONED {
            STUCK_SOURCE_WORK.fetch_sub(1, SeqCst);
        }
    }
}
impl ToolConfig {
    pub fn result_budget(&self) -> usize {
        self.result_tokens
    }
}

/// Where a truncated file read continues. The project is kept so a cursor
/// sent alone still reads from the right root.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileCursor {
    pub project: String,
    pub path: String,
    pub hash: String,
    pub start_line: usize,
    pub max_lines: usize,
    pub offset: usize,
    /// When the cursor was last handed to the model (issued, or issued
    /// again for the same range): a full table drops the one handed out
    /// longest ago. Not part of where the cursor reads.
    #[serde(skip)]
    pub handed_out: u64,
}
impl PartialEq for FileCursor {
    fn eq(&self, other: &Self) -> bool {
        (&self.project, &self.path, &self.hash, self.start_line, self.max_lines, self.offset)
            == (&other.project, &other.path, &other.hash, other.start_line, other.max_lines, other.offset)
    }
}
impl Eq for FileCursor {}

/// What a source tool call works on: the selected project and the
/// conversation's cursors and history (for repeated-read suppression,
/// archived results and the history tool).
pub struct Workspace {
    pub project: Project,
    pub config: ToolConfig,
    pub file_cursors: BTreeMap<String, FileCursor>,
    pub list_cursor_scopes: VecDeque<(String, Value)>,
    pub history: crate::session::SessionHistory,
}
impl Workspace {
    const LIST_SCOPES: usize = 64;
    const FILE_CURSORS: usize = 512;

    fn remember_list_scope(&mut self, fingerprint: String, scope: Value) {
        self.list_cursor_scopes.retain(|(known, _)| *known != fingerprint);
        if self.list_cursor_scopes.len() == Self::LIST_SCOPES {
            self.list_cursor_scopes.pop_front();
        }
        self.list_cursor_scopes.push_back((fingerprint, scope));
    }
}

pub struct ToolRegistry;

impl ToolRegistry {
    pub fn source_specs() -> Vec<ToolSpec> {
        let mut specs = vec![
            ToolSpec {
                name: "file_list",
                description: "List project files. Default mode=text validates UTF-8 text; mode=paths lists regular file paths without reading contents (may include binary/large files). path_glob is a file glob such as backend/**/*.js (pattern is a legacy alias), and a basename is found with mode=paths and path_glob=**/name; path lists everything below one directory instead. Paginated; respects project boundaries and exclusions",
                source: true,
                parameters: schema(
                    json!({"project":project_field(),"path":string(),"path_glob":string(),"pattern":string(),"cursor":string(),"limit":number(),"mode":action(&["text","paths"])}),
                    &[],
                ),
            },
            ToolSpec {
                name: "source_search",
                description: "Search source lines: query is literal text by default. Prefer queries:[\"agent\",\"run\",\"db\"] for literal OR without regex escaping. Supply exactly one of query or queries. Use regex:true only for intentional regular expressions; punctuation such as .on( is literal unless regex:true. case_sensitive defaults true; whole_word defaults false (Unicode word boundaries). path selects one exact file, or a directory to search everything below it (no glob syntax); path_glob filters multiple files. Do not combine path with path_glob or pattern. mode=matches (default) returns matching lines; files returns matching paths; count returns matching-line counts per file. before/after add up to 20 context lines each in matches mode. Each displayed line is capped at 500 characters with truncation marked. Reuse the same search options with cursor for pagination; limit may change.",
                source: true,
                parameters: schema(
                    json!({"project":project_field(),"query":string(),"queries":{"type":"array","minItems":1,"maxItems":16,"items":{"type":"string","minLength":1}},"path":string(),"regex":{"type":"boolean"},"case_sensitive":{"type":"boolean"},"whole_word":{"type":"boolean"},"mode":action(&["matches","files","count"]),"before":{"type":"integer","minimum":0,"maximum":20},"after":{"type":"integer","minimum":0,"maximum":20},"path_glob":string(),"pattern":legacy_pattern("the text to find (send that as query)"),"cursor":string(),"limit":{"type":"integer","minimum":1,"maximum":100}}),
                    &[],
                ),
            },
            ToolSpec {
                name: "file_read",
                description: "Read a project file or one of the project's reference documents: path (relative to the project root, or the reference document path exactly as listed), 1-based start_line and max_lines (line count, default and most 2000; one result holds at most the result limit). Example: {project:\"app\",path:\"src/agent.rs\",start_line:160,max_lines:140}. If truncated, continue ONLY with {cursor: next_cursor.cursor}; never combine cursor with path/start_line/max_lines. A cursor completes the original requested range and expires if the file changes. Once that range is complete, next_line indicates where a NEW range can start. Text arrives as N|line labels where N is the absolute line number. Use force_read=true only to re-read the same unchanged range on purpose.",
                source: true,
                parameters: schema(
                    json!({"project":project_field(),"path":string(),"cursor":string(),"start_line":{"type":"integer","minimum":1},"max_lines":{"type":"integer","minimum":1,"maximum":2000},"limit":{"type":"integer","minimum":1,"maximum":2000,"description":"Compatibility alias for max_lines (number of lines). Prefer max_lines; never use a different value alongside max_lines."},"force_read":{"type":"boolean"}}),
                    &[],
                ),
            },
        ];
        specs.push(ToolSpec {
            name: "history",
            description: "Search this conversation's earlier questions, answers, tool calls and tool results, including those that left the active context (this tool is offered once part of the conversation has left it); continue a search with after: next_cursor. Read one by ID and character offset (read requires id; a search item's offset reads from its match). A result archived because it was too large is read on here from the id and offset its next_cursor names.",
            source: false,
            parameters: schema(
                json!({"action":action(&["search","read"]),"query":string(),"id":number(),"offset":number(),"after":number(),"limit":{"type":"integer","minimum":1,"maximum":50}}),
                &["action"],
            ),
        });
        specs
    }

    /// Every tool: the source tools here and the knowledge, Q&A method and
    /// query tools of `crate::voc_tools`.
    pub fn specs() -> Vec<ToolSpec> {
        let mut specs = crate::voc_tools::specs();
        specs.extend(Self::source_specs());
        specs
    }

    /// OpenAI function definitions of the named tools, in registry order.
    pub fn definitions(offered: &BTreeSet<&str>) -> Vec<Value> {
        Self::specs()
            .into_iter()
            .filter(|spec| offered.contains(spec.name))
            .map(|spec| {
                let mut parameters = spec.parameters.clone();
                // Providers reject top-level unions in function parameters;
                // per-tool combinations are enforced at execution.
                if let Some(fields) = parameters.as_object_mut() {
                    fields.remove("oneOf");
                    fields.remove("anyOf");
                }
                json!({"type":"function","function":{"name":spec.name,"description":spec.description,"parameters":parameters}})
            })
            .collect()
    }

    pub fn validate(name: &str, args: &Value) -> Result<ToolSpec> {
        Self::validate_inner(name, args).map_err(|error| arguments::annotate(error, name, args))
    }

    fn validate_inner(name: &str, args: &Value) -> Result<ToolSpec> {
        let spec = Self::specs()
            .into_iter()
            .find(|t| t.name == name)
            .ok_or_else(|| {
                let names: Vec<&str> = Self::specs().iter().map(|s| s.name).collect();
                match suggest::tool(name, &names) {
                    Some(s) => anyhow::anyhow!("unsupported_tool: {name} does not exist{}", s.text),
                    None => anyhow::anyhow!("unsupported_tool: {name} does not exist"),
                }
            })?;
        let object = args.as_object().ok_or_else(|| {
            arguments::failure(
                name,
                "arguments",
                "invalid_tool_arguments",
                json!("object"),
                arguments::value_type(args),
                "must be an object",
            )
        })?;
        let fields = spec.parameters["properties"].as_object().unwrap();
        for key in object.keys() {
            if !fields.contains_key(key) {
                return Err(arguments::unknown_field(
                    name,
                    key,
                    &object[key],
                    &spec.parameters["properties"],
                    args,
                ));
            }
        }
        for required in spec.parameters["required"].as_array().unwrap() {
            let key = required.as_str().unwrap();
            if !object.contains_key(key) {
                return Err(arguments::failure(
                    name,
                    key,
                    "missing_argument",
                    fields[key].clone(),
                    "missing",
                    "is required",
                ));
            }
        }
        for (k, v) in object {
            arguments::validate_field(name, k, &fields[k], v, args)?;
        }
        if name == "history" {
            match args["action"].as_str() {
                Some("read") if args.get("id").is_none() => {
                    bail!("missing_argument: id is required for action=read")
                }
                Some("search") if args.get("id").is_some() || args.get("offset").is_some() => {
                    bail!("conflicting_arguments: action=search takes query, after and limit; id and offset are for action=read")
                }
                _ => {}
            }
        }
        Ok(spec)
    }
}

/// The refusal of a call to a tool that does not exist, naming the offered
/// tool it most likely meant (`run_query` for query_run). Only offered names
/// reach `ToolRegistry::validate`, so its hint never met a name that does
/// not exist: such a call was refused without one.
pub fn unknown_tool(name: &str, offered: &[String]) -> String {
    let offered: Vec<&str> = offered.iter().map(String::as_str).collect();
    let hint = suggest::tool(name, &offered).map(|s| s.text).unwrap_or_default();
    format!("unsupported_tool: {name} does not exist{hint}")
}

/// Fields a tool accepts from old callers without advertising them.
fn unadvertised_fields(_tool: &str) -> &'static [&'static str] {
    &[]
}

/// An enum value outside its allowed set, with the allowed values and the
/// value the call most likely meant.
fn enum_value_error(
    name: &str,
    key: &str,
    value: &Value,
    allowed: &[Value],
    siblings: &Value,
) -> (String, Option<String>) {
    let shown = match value.as_str() {
        Some(text) => format!("{:?}", text.chars().take(80).collect::<String>()),
        None => value.to_string().chars().take(80).collect(),
    };
    let listed = allowed
        .iter()
        .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
        .collect::<Vec<_>>()
        .join(", ");
    let leaf = key.rsplit('.').next().unwrap_or(key);
    let leaf = leaf.split('[').next().unwrap_or(leaf);
    let (hint, target) = suggest::value(name, leaf, value, allowed, siblings)
        .map_or((String::new(), None), |s| (s.text, s.target));
    (
        format!("invalid_argument_value: {key} {shown} is not one of: {listed}{hint}"),
        target,
    )
}

fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args[key]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing_argument: {key}"))
}
fn path_glob(args: &Value) -> Result<Option<&str>> {
    if args["path_glob"].is_string()
        && args["pattern"].is_string()
        && args["path_glob"] != args["pattern"]
    {
        bail!("conflicting_path_filters: use path_glob only; pattern is a legacy alias");
    }
    let value = args["path_glob"]
        .as_str()
        .or_else(|| args["pattern"].as_str());
    if value.is_some_and(|v| {
        v.starts_with('^') || v.ends_with('$') || v.contains("(?") || v.contains("\\s")
    }) {
        bail!(
            "invalid_path_glob: expected a file glob such as backend/**/*.js, not a content regex; use source_search query with regex=true for content"
        );
    }
    if let Some(value) = value {
        globset::Glob::new(value).map_err(|error| anyhow::anyhow!("invalid_path_glob: {error}"))?;
    }
    Ok(value)
}
/// path is literal (a directory may be named `[slug]`), so it is never
/// joined with path_glob silently. Name the one glob that means both.
fn path_glob_conflict_hint(s: &Workspace, args: &Value) -> String {
    let (field, glob) = match (args["path_glob"].as_str(), args["pattern"].as_str()) {
        (Some(glob), _) => ("path_glob", glob),
        (None, Some(glob)) => ("pattern", glob),
        (None, None) => ("path_glob", ""),
    };
    let glob = glob.trim_start_matches("./");
    let legacy = if field == "pattern" {
        " (pattern is a file glob, the legacy alias of path_glob, not the text to find)"
    } else {
        ""
    };
    let instead = if field == "pattern" {
        " instead of pattern"
    } else {
        ""
    };
    let (Some(path), Ok(root)) = (args["path"].as_str(), s.project.root.canonicalize()) else {
        return String::new();
    };
    let Ok(resolved) = read_path(&s.project, path) else {
        return String::new();
    };
    if resolved.is_file() {
        return format!("; path already names one file, so drop {field} {glob:?}{legacy}");
    }
    let Some(relative) = resolved
        .strip_prefix(&root)
        .ok()
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
    else {
        return String::new();
    };
    let below = if glob.contains('/') {
        glob.to_owned()
    } else {
        format!("**/{glob}")
    };
    let combined = if relative.is_empty() {
        below
    } else {
        format!("{}/{below}", globset::escape(&relative))
    };
    format!(
        "; to match {glob:?} below {path}, send only path_glob:{combined:?}{instead} (relative to the project root; ** includes subdirectories){legacy}"
    )
}

fn n(args: &Value, key: &str, default: usize) -> usize {
    args[key].as_u64().map_or(default, |n| n as usize)
}

/// Repairs every call gets before validation; returns what was adjusted.
/// Providers fill optional fields with null or "", quote integers and
/// booleans, send arrays as JSON text, and send a continuation object back
/// whole.
pub fn normalize_arguments(name: &str, args: &mut Value) -> Vec<String> {
    let mut adjusted = Vec::new();
    let Some(spec) = ToolRegistry::specs().into_iter().find(|t| t.name == name) else {
        return adjusted;
    };
    let properties = spec.parameters["properties"].clone();
    let required: Vec<String> = spec.parameters["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let Some(fields) = args.as_object_mut() else {
        return adjusted;
    };
    // A continuation object copied whole: its own `tool` names this tool.
    if fields.get("tool").is_some_and(|tool| tool == name) && properties.get("tool").is_none() {
        fields.remove("tool");
    }
    let continuation = match fields.get("cursor") {
        Some(Value::String(text)) if text.trim_start().starts_with('{') => {
            serde_json::from_str::<Value>(text.trim()).ok()
        }
        Some(object @ Value::Object(_)) => Some(object.clone()),
        _ => None,
    };
    if let Some(Value::Object(mut continuation)) = continuation {
        let names_this_tool = match continuation.remove("tool") {
            Some(tool) => tool == name,
            None => continuation.contains_key("cursor"),
        };
        if names_this_tool {
            fields.remove("cursor");
            for (key, value) in continuation {
                if properties.get(&key).is_some()
                    && fields
                        .get(&key)
                        .is_none_or(|current| current.is_null() || current == "")
                {
                    fields.insert(key, value);
                }
            }
        }
    }
    fields.retain(|key, value| {
        let declared = properties.get(key).is_some();
        // "" names nothing where a field navigates, and is no value of a
        // number, flag, list, object or choice: sent for an optional one, it
        // was refused (a blank id beside a knowledge cursor, kind:"" beside a
        // path) and cost a request. A plain text field keeps it.
        let blank = value.as_str() == Some("")
            && (matches!(
                key.as_str(),
                "path" | "path_glob" | "pattern" | "cursor" | "project" | "target_db" | "id"
            ) || properties[key]["type"] != "string"
                || properties[key]["enum"].is_array());
        !declared || required.contains(key) || !(value.is_null() || blank)
    });
    for (key, value) in fields.iter_mut() {
        let schema = &properties[key];
        let kind = &schema["type"];
        if *kind == "integer"
            && let Some(raw) = value.as_str()
            && !raw.is_empty()
            && raw.bytes().all(|b| b.is_ascii_digit())
            && let Ok(number) = raw.parse::<u64>()
        {
            *value = json!(number);
        }
        // A whole number written as a float (`10.0`): providers that keep
        // every number as a double send integers so, and each was refused as
        // "must be integer, got number".
        if *kind == "integer"
            && let Some(number) = value.as_f64()
            && !value.is_i64()
            && !value.is_u64()
            && number.fract() == 0.0
            && number.abs() <= 9_007_199_254_740_992.0
        {
            *value = if number < 0.0 { json!(number as i64) } else { json!(number as u64) };
        }
        if *kind == "boolean"
            && let Some(raw @ ("true" | "false")) = value.as_str()
        {
            *value = json!(raw == "true");
        }
        if (*kind == "array" || *kind == "object")
            && let Some(raw) = value.as_str()
            && let Ok(decoded) = serde_json::from_str::<Value>(raw.trim())
            && (decoded.is_array() && *kind == "array" || decoded.is_object() && *kind == "object")
        {
            *value = decoded;
        }
        // A single item sent where a list is expected.
        if *kind == "array" && value.is_string() && schema["items"]["type"] == "string" {
            *value = json!([value.clone()]);
        }
        // Size arguments above their maximum only bound how much a call
        // returns, so the call runs at the maximum and says so.
        if *kind == "integer"
            && let Some(maximum) = schema["maximum"].as_u64()
            && let Some(sent) = value.as_u64()
            && sent > maximum
        {
            *value = json!(maximum);
            adjusted.push(format!(
                "{key} {sent} is above its maximum {maximum}; {maximum} was used"
            ));
        }
    }
    adjusted
}

pub fn envelope(result: Result<Value>) -> Value {
    match result {
        Ok(data) => json!({"status":"ok","data":data,"truncated":false,"next_cursor":null}),
        Err(error) => {
            let message = format!("{error:#}");
            let status = if message == "cancelled" || message.starts_with("cancelled:") {
                "cancelled"
            } else if message.starts_with("unsupported") {
                "unsupported"
            } else {
                "error"
            };
            let mut result = json!({"status":status,"error":message,"recovery":recovery::describe(&message),"truncated":false,"next_cursor":null});
            if let Some(diagnostic) = error.downcast_ref::<recovery::DiagnosticError>() {
                result["data"] = diagnostic.data.clone();
            }
            result
        }
    }
}

pub(crate) fn utf8_path(path: &Path) -> Result<&str> {
    path.to_str().ok_or_else(|| {
        anyhow::anyhow!(
            "unsupported_non_utf8_path: path must contain valid UTF-8: {}",
            path.display()
        )
    })
}

fn folded_alias_key(value: &str) -> String {
    use caseless::Caseless;
    use unicode_normalization::UnicodeNormalization;
    value.nfd().default_case_fold().nfd().collect()
}

/// A project's include/exclude globs, compiled once for a walk: compiled
/// again for every path, they made a large project's walk take minutes.
pub(crate) struct Rules {
    include: Vec<Rule>,
    exclude: Vec<Rule>,
}
/// A glob matched case-insensitively on the NFD path, and its case-folded
/// form on the folded path.
struct Rule {
    normalized: globset::GlobMatcher,
    folded: Option<globset::GlobMatcher>,
    /// No `/` in the pattern: it names a file or directory at any depth.
    anywhere: bool,
}
impl Rules {
    pub(crate) fn new(project: &Project) -> Result<Self> {
        use unicode_normalization::UnicodeNormalization;
        let compile = |pattern: &String| -> Result<Rule> {
            let pattern = rule_pattern(pattern);
            let normalized_pattern: String = pattern.nfd().collect();
            Ok(Rule {
                normalized: globset::GlobBuilder::new(&normalized_pattern)
                    .case_insensitive(true)
                    .build()?
                    .compile_matcher(),
                folded: globset::Glob::new(&folded_alias_key(&pattern))
                    .ok()
                    .map(|glob| glob.compile_matcher()),
                anywhere: !pattern.contains('/'),
            })
        };
        Ok(Self {
            include: project.include.iter().map(compile).collect::<Result<_>>()?,
            exclude: project.exclude.iter().map(compile).collect::<Result<_>>()?,
        })
    }
}

/// An include/exclude pattern as written in an ignore file: `secrets/` names
/// the directory, `/secrets` and `./secrets` the root's. Matched as sent, a
/// pattern ending in `/` matched no path, and the folder the README says to
/// exclude for its secrets stayed readable.
fn rule_pattern(pattern: &str) -> String {
    let mut pattern = pattern.trim();
    while let Some(rest) = pattern.strip_prefix("./").or_else(|| pattern.strip_prefix('/')) {
        pattern = rest;
    }
    let pattern = pattern.trim_end_matches('/');
    if pattern.is_empty() { "**".to_owned() } else { pattern.to_owned() }
}

/// Version control, dependency and build output, and the project's
/// include/exclude globs (case-insensitive, Unicode-normalized).
pub(crate) fn excluded(project: &Project, relative: &Path) -> Result<bool> {
    Ok(excluded_by(project, &Rules::new(project)?, relative))
}

/// The build or tool folder (`.git`, `node_modules`, `target`...) a path is
/// in, which source tools always leave out whatever the project's rules say.
fn tool_folder(project: &Project, relative: &Path) -> Option<String> {
    use std::path::Component;
    // Version-control metadata is excluded as a file too: a `.git` file
    // points a worktree or submodule at its repository.
    let version_control = [".git", ".hg", ".svn"];
    // A regular file with a build directory's name (a Bazel `BUILD`) is not
    // inside one.
    let directories = [
        "target",
        "node_modules",
        "vendor",
        "dist",
        "build",
        ".venv",
        "__pycache__",
    ];
    let named = |part: Component, names: &[&str]| {
        let part = part.as_os_str().to_string_lossy();
        names.iter().any(|name| part.eq_ignore_ascii_case(name))
    };
    let last = relative.components().count().saturating_sub(1);
    relative
        .components()
        .enumerate()
        .find(|(index, part)| {
            named(*part, &version_control)
                || (named(*part, &directories) && (*index < last || project.root.join(relative).is_dir()))
        })
        .map(|(_, part)| part.as_os_str().to_string_lossy().into_owned())
}

/// `excluded` with the project's rules already compiled.
pub(crate) fn excluded_by(project: &Project, rules: &Rules, relative: &Path) -> bool {
    use unicode_normalization::UnicodeNormalization;
    if tool_folder(project, relative).is_some() {
        return true;
    }
    // A rule holds for a path when it matches the path or a directory the
    // path is in, as in an ignore file: `secrets` excluded the directory
    // listed by name, while `secrets/key.pem` was read all the same. A
    // pattern without `/` also names a file or directory at any depth: `.env`
    // excluded the root's alone, though `*.log` matched at every depth.
    let names: Vec<String> = relative.components().map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
    let mut within: Vec<(String, String)> = Vec::with_capacity(names.len());
    let mut prefix = String::new();
    for name in &names {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(name);
        within.push((prefix.nfd().collect(), folded_alias_key(&prefix)));
    }
    let named: Vec<(String, String)> = names.iter().map(|name| (name.nfd().collect(), folded_alias_key(name))).collect();
    let matches = |rule: &Rule| {
        let hit = |(normalized, folded): &(String, String)| {
            rule.normalized.is_match(normalized) || rule.folded.as_ref().is_some_and(|glob| glob.is_match(folded))
        };
        within.iter().any(hit) || (rule.anywhere && named.iter().any(hit))
    };
    (!rules.include.is_empty() && !rules.include.iter().any(matches)) || rules.exclude.iter().any(matches)
}

/// The reference documents of a project that exist, canonicalized.
pub fn doc_paths(p: &Project) -> Vec<PathBuf> {
    let root = p.root.canonicalize().ok();
    p.docs
        .iter()
        .filter_map(|doc| {
            let doc = Path::new(doc.trim());
            let path = if doc.is_absolute() {
                doc.to_path_buf()
            } else {
                root.as_ref()?.join(doc)
            };
            path.canonicalize().ok().filter(|path| path.is_file())
        })
        .collect()
}

/// The backend's own secret files (its settings, its credentials file and
/// the `.env` it loaded), which no project reads though one may hold them: a project
/// registered at the backend's own folder let file_read hand the API key
/// and passwords to the model and to whoever asked (an explicit path does
/// not go by `.gitignore`).
static KEPT_OUT: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

/// Keeps `path` out of every project's reach from now on.
pub fn keep_out(path: &Path) {
    let path = std::path::absolute(path).unwrap_or_else(|_| path.to_owned());
    let mut kept = KEPT_OUT.lock().unwrap_or_else(|p| p.into_inner());
    if !kept.contains(&path) {
        kept.push(path);
    }
}

/// The kept-out files as they resolve now (a file made later is found then).
fn kept_out() -> Vec<PathBuf> {
    let kept = KEPT_OUT.lock().unwrap_or_else(|p| p.into_inner()).clone();
    kept.iter().filter_map(|path| path.canonicalize().ok()).collect()
}

pub fn read_path(p: &Project, path: &str) -> Result<PathBuf> {
    resolve_path(p, path, true)
}

/// Whether `path` names a file or directory the project may read. Unlike
/// `read_path` it never walks the project for similar names, so it is cheap
/// enough to try in every project for a call that names none (on a
/// blocking thread: it reads the file system).
pub fn path_in_project(p: &Project, path: &str) -> bool {
    resolve_path(p, path, false).is_ok()
}

fn resolve_path(p: &Project, path: &str, hints: bool) -> Result<PathBuf> {
    let root = p.root.canonicalize().map_err(|e| {
        anyhow::anyhow!(
            "project_root_unavailable: project {} root {} cannot be opened: {e}",
            p.name,
            p.root.display()
        )
    })?;
    let candidate = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        root.join(path)
    };
    let canonical = candidate.canonicalize().map_err(|e| {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => "file_not_found",
            std::io::ErrorKind::PermissionDenied => "file_permission_denied",
            _ => "file_access_error",
        };
        let hint = if hints && e.kind() == std::io::ErrorKind::NotFound {
            if let Some(shape) = path_shape_hint(&root, path) {
                shape
            } else {
                match similar_paths(p, &candidate).as_slice() {
                    [] => " No project file or directory has this name; list files with file_list mode=paths and path_glob before reading.".to_owned(),
                    similar => format!(" Existing project paths with a similar name: {}. Copy one exactly.", similar.join(", ")),
                }
            }
        } else {
            String::new()
        };
        anyhow::anyhow!(
            "{code}: resolved path {}; project root {}. Relative paths use the project root.{hint} {e}",
            candidate.display(),
            root.display()
        )
    })?;
    utf8_path(&canonical)?;
    if kept_out().contains(&canonical) {
        bail!(
            "path_excluded: {} holds the agent server's own secrets and cannot be read; choose another file",
            candidate.display()
        );
    }
    // A configured reference document may live outside the root.
    if doc_paths(p).contains(&canonical) {
        return Ok(canonical);
    }
    if !canonical.starts_with(&root) {
        bail!(
            "path_outside_project: {} resolves to {} (symlinks are followed), outside project root {}; read files inside the project or its listed reference documents",
            candidate.display(),
            canonical.display(),
            root.display()
        );
    }
    // Include patterns select files; a directory scope need not match them.
    let directory_rules;
    let rules = if canonical.is_dir() {
        directory_rules = Project {
            include: vec![],
            ..p.clone()
        };
        &directory_rules
    } else {
        p
    };
    let relative = canonical.strip_prefix(&root)?;
    if let Some(folder) = tool_folder(p, relative) {
        bail!(
            "path_excluded: {} is in {folder}, a version-control, dependency or build-output folder that source tools always leave out (project settings cannot add it back); read the source it was made from instead",
            relative.display()
        );
    }
    if excluded(rules, relative)? {
        bail!(
            "path_excluded: {} is excluded by the project's include/exclude settings and cannot be read; choose a listed file from file_list",
            relative.display()
        );
    }
    Ok(canonical)
}
/// A missing path that is a citation or a glob rather than a file name.
fn path_shape_hint(root: &Path, path: &str) -> Option<String> {
    let lines = |range: &str| -> Option<(u64, u64)> {
        let range = range.replace(['L', 'l'], "");
        let (start, end) = range.split_once('-').unwrap_or((&range, &range));
        let (start, end) = (start.trim().parse().ok()?, end.trim().parse().ok()?);
        (start >= 1 && end >= start).then_some((start, end))
    };
    let exists = |base: &str| {
        if Path::new(base).is_absolute() {
            Path::new(base).exists()
        } else {
            root.join(base).exists()
        }
    };
    let reference = path
        .rsplit_once("#L")
        .or_else(|| path.rsplit_once('#'))
        .and_then(|(base, range)| Some((base, lines(range)?)))
        .or_else(|| {
            let last = path
                .rsplit_once(':')
                .and_then(|(base, range)| Some((base, lines(range)?)));
            let earlier = last.and_then(|(base, _)| {
                let (base, range) = base.rsplit_once(':')?;
                Some((base, lines(range)?))
            });
            match (last, earlier) {
                (Some(last), _) if exists(last.0) => Some(last),
                (_, Some(earlier)) => Some(earlier),
                (last, None) => last,
            }
            .filter(|(base, _)| !base.is_empty())
        });
    if let Some((base, (start, end))) = reference {
        let base_note = if exists(base) {
            format!(" {base:?} exists.")
        } else {
            String::new()
        };
        return Some(format!(
            " path contains a line reference {:?}; send only the file path {base:?} in path and the lines separately (file_read: start_line={start}, max_lines={}).{base_note}",
            &path[base.len()..],
            end - start + 1
        ));
    }
    path.contains(['*', '?', '[', '{']).then(|| format!(
        " path takes one exact file or directory and does not expand globs; to match files by pattern send path_glob:{path:?} instead (file_list and source_search accept path_glob)."
    ))
}

/// Longest walk for the names an error suggests. Such a walk has no
/// cancellation token of its own; past this it suggests nothing.
const HINT_WALK: std::time::Duration = std::time::Duration::from_secs(2);

/// Project files whose name matches a missing path: the same file name
/// first, then the same stem, then directories of that name.
fn similar_paths(p: &Project, missing: &Path) -> Vec<String> {
    const MAX_SUGGESTIONS: usize = 5;
    const MAX_SCANNED: usize = 20_000;
    let Some(name) = missing
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
    else {
        return vec![];
    };
    let stem = missing
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let Ok(root) = p.root.canonicalize() else {
        return vec![];
    };
    let Ok(paths) = candidate_paths_scoped(
        p,
        None,
        &tokio_util::sync::CancellationToken::new(),
        None,
        Some(std::time::Instant::now() + HINT_WALK),
    ) else {
        return vec![];
    };
    let mut exact = vec![];
    let mut same_stem = vec![];
    let mut directories = BTreeSet::new();
    for path in paths.iter().take(MAX_SCANNED) {
        let Ok(relative) = path.strip_prefix(&root) else {
            continue;
        };
        if let Some(parent) = relative.parent() {
            for ancestor in parent.ancestors() {
                if ancestor
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().to_lowercase() == name)
                {
                    directories.insert(format!(
                        "{}/",
                        ancestor.to_string_lossy().replace('\\', "/")
                    ));
                }
            }
        }
        let relative = relative.to_string_lossy().replace('\\', "/");
        let file = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if file == name {
            exact.push(relative);
        } else if !stem.is_empty()
            && path
                .file_stem()
                .is_some_and(|s| s.to_string_lossy().to_lowercase() == stem)
        {
            same_stem.push(relative);
        }
    }
    exact.sort_by_key(|path| (path.len(), path.clone()));
    same_stem.sort_by_key(|path| (path.len(), path.clone()));
    let mut directories: Vec<_> = directories.into_iter().collect();
    directories.sort_by_key(|path| (path.len(), path.clone()));
    exact
        .into_iter()
        .chain(same_stem)
        .chain(directories)
        .take(MAX_SUGGESTIONS)
        .collect()
}
/// A file operation named a directory; the tool layer adds its entries.
#[derive(Debug)]
pub(crate) struct DirectoryPath(PathBuf);

impl std::fmt::Display for DirectoryPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "path_is_directory: {} is a directory; use file_list with path_glob set to its project-relative path followed by /**, then file_read with a file path",
            self.0.display()
        )
    }
}

impl std::error::Error for DirectoryPath {}

fn directory_entries(p: &Project, directory: &Path) -> (Vec<String>, usize) {
    const MAX_ENTRIES: usize = 12;
    let Ok((paths, _)) = candidate_paths_bounded(
        p,
        None,
        &tokio_util::sync::CancellationToken::new(),
        Some(directory),
        Some(std::time::Instant::now() + HINT_WALK),
        FileScanLimits {
            max_paths: 20_000,
            max_path_bytes: 4 * 1024 * 1024,
        },
    ) else {
        return (vec![], 0);
    };
    let mut entries = BTreeSet::new();
    for path in &paths {
        let Ok(relative) = path.strip_prefix(directory) else {
            continue;
        };
        let mut components = relative.components();
        let Some(first) = components.next() else {
            continue;
        };
        let name = first.as_os_str().to_string_lossy();
        entries.insert(if components.next().is_some() {
            format!("{name}/")
        } else {
            name.into_owned()
        });
    }
    let total = entries.len();
    (entries.into_iter().take(MAX_ENTRIES).collect(), total)
}

fn directory_error(p: &Project, directory: &DirectoryPath, tool: &str) -> anyhow::Error {
    let (entries, total) = directory_entries(p, &directory.0);
    let listing = match total.saturating_sub(entries.len()) {
        _ if entries.is_empty() => String::new(),
        0 => format!(" containing {}", entries.join(", ")),
        more => format!(" containing {} and {more} more", entries.join(", ")),
    };
    let glob = std::fs::canonicalize(&p.root)
        .ok()
        .and_then(|root| {
            let directory = directory.0.canonicalize().ok()?;
            Some(directory.strip_prefix(root).ok()?.to_path_buf())
        })
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_or_else(
            || "**".to_owned(),
            |relative| {
                if relative.is_empty() {
                    "**".to_owned()
                } else {
                    format!("{relative}/**")
                }
            },
        );
    let next = match tool {
        "file_read" => format!(
            "{tool} reads one file: find it with file_list and path_glob (e.g. {glob}), then call {tool} with that file path"
        ),
        _ => format!("use file_list with path_glob (e.g. {glob}), then file_read with a file path"),
    };
    anyhow::anyhow!(
        "path_is_directory: {} is a directory{listing}; {next}",
        directory.0.display()
    )
}

fn regular_metadata(metadata: &std::fs::Metadata, path: &Path) -> Result<()> {
    if metadata.is_dir() {
        return Err(DirectoryPath(path.to_path_buf()).into());
    }
    if !metadata.is_file() {
        bail!(
            "unsupported_file_type: {} is not a regular file (device, socket or pipe); choose a regular text file",
            path.display()
        );
    }
    Ok(())
}
fn file_access_error(path: &Path, error: std::io::Error) -> anyhow::Error {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "file_not_found",
        std::io::ErrorKind::PermissionDenied => "file_permission_denied",
        _ => "file_access_error",
    };
    anyhow::anyhow!("{code}: {}: {error}", path.display())
}
pub(crate) fn open_regular_file(path: &Path) -> Result<std::fs::File> {
    regular_metadata(
        &path.metadata().map_err(|e| file_access_error(path, e))?,
        path,
    )?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A path can become a FIFO between metadata and open; opening it must
        // never block waiting for a writer.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| file_access_error(path, e))?;
    regular_metadata(
        &file.metadata().map_err(|e| file_access_error(path, e))?,
        path,
    )?;
    Ok(file)
}

const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

fn read_bytes_bounded(path: &Path) -> Result<Vec<u8>> {
    use std::io::Read;
    let file = open_regular_file(path)?;
    let length = file.metadata()?.len();
    if length > MAX_FILE_BYTES as u64 {
        bail!("unsupported_large_file: maximum 16MiB");
    }
    let mut bytes = Vec::with_capacity(length as usize + 1);
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_FILE_BYTES {
        bail!("unsupported_large_file: maximum 16MiB");
    }
    Ok(bytes)
}

pub(crate) fn read_text(path: &Path) -> Result<String> {
    let bytes = read_bytes_bounded(path)?;
    if bytes.contains(&0) {
        bail!(
            "unsupported_binary_file: {} contains NUL bytes and is not a text file; choose a text file",
            path.display()
        );
    }
    String::from_utf8(bytes).map_err(|_| {
        anyhow::anyhow!(
            "unsupported_non_utf8_file: {} is not valid UTF-8 text; choose a UTF-8 text file",
            path.display()
        )
    })
}

fn candidate_paths_scoped(
    p: &Project,
    pattern: Option<&str>,
    cancel: &tokio_util::sync::CancellationToken,
    directory: Option<&Path>,
    deadline: Option<std::time::Instant>,
) -> Result<Vec<PathBuf>> {
    candidate_paths_counted(p, pattern, cancel, directory, deadline).map(|(paths, _)| paths)
}

/// candidate_paths_scoped, with the number of files in scope whose names are
/// not UTF-8 (tools cannot address them).
pub(crate) fn candidate_paths_counted(
    p: &Project,
    pattern: Option<&str>,
    cancel: &tokio_util::sync::CancellationToken,
    directory: Option<&Path>,
    deadline: Option<std::time::Instant>,
) -> Result<(Vec<PathBuf>, usize)> {
    candidate_paths_bounded(
        p,
        pattern,
        cancel,
        directory,
        deadline,
        FileScanLimits {
            max_paths: 100_000,
            max_path_bytes: 16 * 1024 * 1024,
        },
    )
}

struct FileScanLimits {
    max_paths: usize,
    max_path_bytes: usize,
}

/// Directories no project walk enters: version control, dependencies and
/// build output.
const SKIPPED_DIRECTORIES: [&str; 10] = [
    ".git",
    ".hg",
    ".svn",
    "target",
    "node_modules",
    "vendor",
    "dist",
    "build",
    ".venv",
    "__pycache__",
];

/// A path glob as matched, relative to the project root, also when written
/// from the root (`./src/**`, or `/src/**` as in an ignore file) or with the
/// root's absolute path in front. Matched as sent, `/src/*.rs` named no
/// relative path, and the walk found nothing.
fn root_relative_glob<'a>(p: &Project, root: &Path, glob: &'a str) -> &'a str {
    let mut glob = [root, p.root.as_path()]
        .iter()
        .filter_map(|prefix| prefix.to_str())
        .map(|prefix| prefix.trim_end_matches('/'))
        .filter(|prefix| !prefix.is_empty())
        .find_map(|prefix| glob.strip_prefix(prefix)?.strip_prefix('/'))
        .unwrap_or(glob);
    loop {
        match glob.strip_prefix("./").or_else(|| glob.strip_prefix('/')) {
            Some(rest) => glob = rest,
            None => return glob,
        }
    }
}

/// A path_glob as the tools describe it: `*` and `?` stay within one path
/// component and `**` crosses directories, so `src/*.rs` is the files of
/// `src` alone; a glob without `/` matches at any depth (`*.rs`, a basename),
/// as in an ignore file. Compiled as globset's default, `*` crossed `/`:
/// `src/tools/*.rs` listed and searched all of `src/tools` below too.
/// `anchored`: the glob as sent named a directory (`./*.rs` is the root's).
/// It is matched as the project's include/exclude globs are (`Rules`):
/// without case, on the decomposed (NFD) path. Matched as sent, a Korean name
/// typed composed (`**/문서.md`) missed the file a Mac had named decomposed,
/// and `**/readme.md` missed README.md, which file_read opens all the same.
/// A glob naming a directory (`src/`, or `./` for the root) is everything
/// below it: no file path ends in `/`, so it matched nothing, without a word.
fn path_glob_matcher(glob: &str, anchored: bool) -> Result<globset::GlobMatcher> {
    use unicode_normalization::UnicodeNormalization;
    let mut glob: String = glob.nfd().collect();
    if glob.is_empty() || glob.ends_with('/') {
        glob.push_str("**");
    }
    let glob = if anchored { glob } else { format!("**/{glob}") };
    Ok(globset::GlobBuilder::new(&glob)
        .literal_separator(true)
        .case_insensitive(true)
        .build()?
        .compile_matcher())
}

/// A path or path glob with `/` between its parts. On Windows the tools
/// showed `src\main.rs`, and a glob written so (`src\*.rs`) matched nothing:
/// globset matches paths there with `/`, and takes `\` in a glob as itself.
/// Elsewhere `\` stays what it is (a glob's escape).
pub(crate) fn separated(path: &str) -> String {
    if cfg!(windows) { path.replace('\\', "/") } else { path.to_owned() }
}

/// A relative path as `path_glob_matcher` matches it.
fn glob_path(relative: &Path) -> String {
    use unicode_normalization::UnicodeNormalization;
    relative.to_string_lossy().nfd().collect()
}

fn candidate_paths_bounded(
    p: &Project,
    pattern: Option<&str>,
    cancel: &tokio_util::sync::CancellationToken,
    directory: Option<&Path>,
    deadline: Option<std::time::Instant>,
    limits: FileScanLimits,
) -> Result<(Vec<PathBuf>, usize)> {
    let check = || -> Result<()> {
        if cancel.is_cancelled() {
            bail!("cancelled")
        }
        if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
            bail!("scope_timeout: listing the files in scope ran past the source tool time limit; narrow path or path_glob");
        }
        Ok(())
    };
    check()?;
    let root = p.root.canonicalize()?;
    if let Some(scope) = directory.filter(|scope| !scope.starts_with(&root)) {
        bail!(
            "path_outside_project: {} is outside project root {}; list a directory inside the project",
            scope.display(),
            root.display()
        );
    }
    let scope = directory.map(Path::to_path_buf);
    let mut entries = vec![];
    let mut non_utf8 = 0usize;
    let mut path_bytes = 0usize;
    let filter = pattern
        .map(|glob| {
            let glob = separated(glob);
            path_glob_matcher(root_relative_glob(p, &root, &glob), glob.contains('/'))
        })
        .transpose()?;
    let rules = Rules::new(p)?;
    let secrets = kept_out();
    // The walker reads the root's and its parents' ignore files first.
    for dir in root.ancestors() {
        if let Some(file) = unsafe_ignore_file(dir) {
            bail!(
                "unsafe_ignore_file: {} is not a regular file of at most {} bytes, so the project cannot be walked; replace it or remove it",
                file.display(),
                MAX_IGNORE_FILE_BYTES
            );
        }
    }
    for entry in ignore::WalkBuilder::new(&root)
        .hidden(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            !entry.file_type().is_some_and(|t| t.is_dir())
                || (!SKIPPED_DIRECTORIES.contains(&entry.file_name().to_string_lossy().as_ref())
                    && scope.as_ref().is_none_or(|scope| {
                        entry.path().starts_with(scope) || scope.starts_with(entry.path())
                    })
                    && unsafe_ignore_file(entry.path()).is_none())
        })
        .build()
    {
        check()?;
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let rel = entry.path().strip_prefix(&root)?;
        if directory.is_some_and(|scope| !entry.path().starts_with(scope))
            || excluded_by(p, &rules, rel)
            || filter.as_ref().is_some_and(|f| !f.is_match(glob_path(rel)))
            || secrets.iter().any(|secret| secret == entry.path())
        {
            continue;
        }
        if entry.path().to_str().is_none() {
            non_utf8 += 1;
            continue;
        }
        path_bytes = path_bytes.saturating_add(entry.path().as_os_str().as_encoded_bytes().len());
        if entries.len() >= limits.max_paths || path_bytes > limits.max_path_bytes {
            bail!(
                "file_scan_capacity: matched paths exceed {} entries or {} bytes; narrow path, path_glob or project include/exclude rules",
                limits.max_paths,
                limits.max_path_bytes
            );
        }
        entries.push(entry.path().to_path_buf());
    }
    entries.sort();
    check()?;
    Ok((entries, non_utf8))
}
/// The refusal of a source tool past its time limit (`tool_timeout_secs`,
/// the settings' "소스 도구 한도"): file_list and source_search had none, and
/// a search of a large project held the question until it ran out.
pub(crate) fn past_deadline(deadline: std::time::Instant, tool: &str, done: usize, total: usize, secs: u64, narrower: &str) -> Result<()> {
    if std::time::Instant::now() >= deadline {
        bail!("scope_timeout: {tool} read {done} of {total} files within its {secs}s limit; {narrower}");
    }
    Ok(())
}

/// Largest ignore file a walk lets the walker read.
const MAX_IGNORE_FILE_BYTES: u64 = 1024 * 1024;

/// An ignore file in `dir` the walker would open but must not: anything but
/// a regular file of at most MAX_IGNORE_FILE_BYTES (links followed, as the
/// walker does). The walker opens these itself, before any check of ours,
/// and reads them to the end: a pipe blocks it for good, a link to a device
/// such as /dev/zero never ends. A directory holding one is not entered.
fn unsafe_ignore_file(dir: &Path) -> Option<PathBuf> {
    let safe = |path: &Path| match path.metadata() {
        Ok(metadata) => metadata.is_file() && metadata.len() <= MAX_IGNORE_FILE_BYTES,
        Err(_) => true,
    };
    let git = dir.join(".git");
    let mut files = vec![dir.join(".ignore"), dir.join(".gitignore")];
    match git.metadata() {
        Ok(metadata) if metadata.is_dir() => files.push(git.join("info/exclude")),
        // A `.git` file (worktree, submodule) is read for its gitdir line.
        Ok(metadata) if metadata.is_file() => files.push(git),
        _ => {}
    }
    files.into_iter().find(|file| !safe(file))
}

fn search_text(path: &Path) -> Result<Option<String>> {
    match read_text(path) {
        Ok(text) => Ok(Some(text)),
        // A file the walk found but cannot read is skipped like a binary one.
        Err(error)
            if ["unsupported_", "file_permission_denied", "file_not_found"]
                .iter()
                .any(|code| error.to_string().starts_with(code)) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// The line range a read or search match delivered. MnemoArc
/// kept these as evidence IDs for memories and citation audits; here only the
/// range remains, and the model view drops it (the content carries it).
#[derive(Clone, Copy)]
struct EvidenceQuality {
    #[allow(dead_code)]
    line_start_complete: bool,
    #[allow(dead_code)]
    line_end_complete: bool,
    #[allow(dead_code)]
    evidence_truncated: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct Source {
    pub start_line: Option<usize>,
    pub end_line: Option<usize>,
}
fn observe_hashed_quality(
    _s: &mut Workspace,
    _path: &Path,
    _content_hash: String,
    start: usize,
    end: usize,
    _excerpt: &str,
    _quality: EvidenceQuality,
) -> Source {
    Source {
        start_line: Some(start),
        end_line: Some(end),
    }
}

fn bounded_text(s: &Workspace, content: &str, offset: usize) -> Value {
    let byte_offset = content
        .char_indices()
        .nth(offset)
        .map_or(content.len(), |(byte, _)| byte);
    let budget = s.config.result_budget();
    let (body, truncated) = context::truncate(
        &content[byte_offset..],
        budget.saturating_sub(500).max(budget / 2).max(1),
        &s.config.model,
    );
    let next = offset + body.chars().count();
    json!({"text":body,"truncated":truncated,"next_offset":truncated.then_some(next)})
}
/// A cursor this tool did not issue, or that no longer points into the result.
pub(crate) const INVALID_CURSOR: &str = "invalid_cursor: not a cursor this tool issued for these results; copy next_cursor exactly from the previous result, or omit cursor to start from the beginning";

fn page_cursor(args: &Value, fingerprint: &str) -> Result<usize> {
    if let Some(cursor) = args["cursor"].as_str() {
        let (h, index) = cursor
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!(INVALID_CURSOR))?;
        if h != fingerprint {
            bail!(
                "cursor_expired: this cursor was issued for different arguments (path_glob, mode, query or filters) or the listing changed; pass the cursor with exactly the original arguments, or restart without a cursor"
            );
        }
        index
            .parse::<usize>()
            .map_err(|_| anyhow::anyhow!(INVALID_CURSOR))
    } else {
        Ok(0)
    }
}

/// Runs one source tool against the workspace's project.
pub fn execute(
    s: &mut Workspace,
    name: &str,
    args: Value,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Value> {
    if cancel.is_cancelled() {
        bail!("cancelled");
    }
    let shape = arguments::shape(&args);
    execute_validated(s, name, args, cancel).map_err(|error| {
        match error.downcast_ref::<DirectoryPath>() {
            Some(directory) => directory_error(&s.project, directory, name),
            None => arguments::annotate_runtime(error, name, &shape),
        }
    })
}

fn execute_validated(
    s: &mut Workspace,
    name: &str,
    mut args: Value,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Value> {
    if name == "source_search"
        && args["query"]
            .as_str()
            .is_some_and(|query| !query.is_empty())
        && args["queries"].as_array().is_some_and(Vec::is_empty)
    {
        args.as_object_mut().unwrap().remove("queries");
    }
    if name == "file_read"
        && let Some(fields) = args.as_object_mut()
        && let Some(limit) = fields.remove("limit")
    {
        if let Some(max_lines) = fields.get("max_lines") {
            if limit != json!(0) && max_lines != &limit {
                bail!(
                    "conflicting_arguments: file_read limit and max_lines differ; supply only max_lines (number of lines)"
                );
            }
        } else {
            fields.insert("max_lines".into(), limit);
        }
    }
    match name {
        "history" => match text(&args, "action")? {
            "search" => Ok(s.history.search(
                args["query"].as_str().unwrap_or(""),
                n(&args, "after", 0) as u64,
                n(&args, "limit", 10),
            )),
            "read" => {
                let id = n(&args, "id", 0) as u64;
                let b = s.history.read(id)?;
                let text = serde_json::to_string(&context::shown_messages(&b.messages[..]))?;
                // Past the end, the read would be an empty text with nothing
                // after it: the same as a bundle with nothing in it.
                let offset = n(&args, "offset", 0);
                let length = text.chars().count();
                if offset > length {
                    bail!(
                        "invalid_offset: offset {offset} is past the end of history id {id} ({length} characters); read from 0, from a search item's offset or from next_cursor"
                    );
                }
                Ok(bounded_text(s, &text, offset))
            }
            _ => unreachable!(),
        },
        "file_list" => {
            // A continuation that omits its original mode and scope keeps the
            // scope its cursor was issued for.
            if let Some(scope) = args["cursor"]
                .as_str()
                .and_then(|cursor| cursor.split_once(':'))
                .and_then(|(fingerprint, _)| {
                    s.list_cursor_scopes
                        .iter()
                        .find(|(known, _)| known == fingerprint)
                        .map(|(_, scope)| scope.clone())
                })
            {
                for key in ["mode", "path_glob", "path"] {
                    if args.get(key).is_none() && !scope[key].is_null() {
                        args[key] = scope[key].clone();
                    }
                }
            }
            let directory = if let Some(path) = args.get("path").and_then(Value::as_str) {
                if args.get("path_glob").is_some() || args.get("pattern").is_some() {
                    bail!(
                        "conflicting_arguments: use path for one directory OR path_glob/pattern for a file glob{}",
                        path_glob_conflict_hint(s, &args)
                    );
                }
                let dir = read_path(&s.project, path)?;
                if !dir.is_dir() {
                    bail!(
                        "invalid_argument_value: path must be a directory for file_list; read a file with file_read"
                    );
                }
                Some(dir)
            } else {
                None
            };
            let mode = args["mode"].as_str().unwrap_or("text");
            let deadline = crate::config::deadline_after(s.config.tool_timeout_secs)?;
            let mut files = candidate_paths_scoped(
                &s.project,
                path_glob(&args)?,
                cancel,
                directory.as_deref(),
                Some(deadline),
            )?;
            if mode != "paths" {
                let mut searchable = Vec::new();
                let total = files.len();
                for (read, path) in files.into_iter().enumerate() {
                    if cancel.is_cancelled() {
                        bail!("cancelled");
                    }
                    past_deadline(deadline, "file_list", read, total, s.config.tool_timeout_secs, "mode=paths lists without reading, or narrow path or path_glob")?;
                    if search_text(&path)?.is_some() {
                        searchable.push(path);
                    }
                }
                files = searchable;
            }
            let root = s.project.root.canonicalize()?;
            let names = files
                .iter()
                .map(|p| separated(&p.strip_prefix(&root).unwrap_or(p).display().to_string()))
                .collect::<Vec<_>>();
            let fingerprint = hash(
                serde_json::to_string(&(mode, path_glob(&args)?, &directory, &names))?.as_bytes(),
            );
            let offset = page_cursor(&args, &fingerprint)?;
            if offset > names.len() {
                bail!(INVALID_CURSOR);
            }
            let end = (offset + n(&args, "limit", 100).clamp(1, 500)).min(names.len());
            if end < names.len() {
                s.remember_list_scope(
                    fingerprint.clone(),
                    json!({"mode":mode,"path_glob":path_glob(&args)?,"path":args.get("path")}),
                );
            }
            Ok(
                json!({"hash":fingerprint,"mode":mode,"total_files":names.len(),"paths":names[offset..end],"next_cursor":(end<names.len()).then(||format!("{fingerprint}:{end}"))}),
            )
        }
        "source_search" => search::execute(s, &args, cancel),
        "file_read" => {
            // A cursor continues its original range, so a page size sent with
            // it changes nothing; new-range arguments with a cursor conflict.
            let ignored_page_size = args["cursor"].is_string()
                && args.get("max_lines").is_some()
                && args.get("start_line").is_none();
            if ignored_page_size {
                args.as_object_mut().unwrap().remove("max_lines");
            }
            let mut result = read_file(s, &mut args, cancel)?;
            if ignored_page_size {
                result["ignored_arguments"] = json!(["max_lines"]);
                result["ignored_note"] = json!(
                    "A cursor continues its original range; max_lines was ignored. Pass only the cursor to continue."
                );
            }
            Ok(result)
        }
        _ => bail!("unsupported_tool: {name} is not a source tool"),
    }
}

#[derive(Deserialize)]
struct FileReadMetadata {
    path: String,
    source: FileReadHash,
    read_start: usize,
    read_offset: usize,
    read_max_lines: usize,
    #[serde(default)]
    content: FileReadContent,
}

#[derive(Default, Deserialize)]
struct FileReadContent {
    #[serde(default)]
    truncated: bool,
}

#[derive(Deserialize)]
struct FileReadHash {
    hash: String,
}

/// A delivered file read in history: the stored tool message keeps the
/// result envelope, whose data carries the read identity.
fn file_read_metadata(message: &Value) -> Option<FileReadMetadata> {
    if message["role"] != "tool" {
        return None;
    }
    #[derive(Deserialize)]
    struct ReadResult {
        data: ReadData,
    }
    #[derive(Deserialize)]
    struct ReadData {
        path: String,
        hash: String,
        read_start: usize,
        read_offset: usize,
        read_max_lines: usize,
        #[serde(default)]
        content: FileReadContent,
    }
    let data = serde_json::from_str::<ReadResult>(message["content"].as_str()?)
        .ok()?
        .data;
    Some(FileReadMetadata {
        path: data.path,
        source: FileReadHash { hash: data.hash },
        read_start: data.read_start,
        read_offset: data.read_offset,
        read_max_lines: data.read_max_lines,
        content: data.content,
    })
}

/// The line reader of file_read.
fn read_file(
    s: &mut Workspace,
    args: &mut Value,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Value> {
    if let Some(id) = args["cursor"].as_str() {
        let cursor = s.file_cursors.get(id).cloned().ok_or_else(|| anyhow::anyhow!("invalid_file_cursor: copy next_cursor.cursor exactly from this conversation, or start a new read with path/start_line/max_lines"))?;
        if let Some(path) = args.get("path").and_then(Value::as_str)
            && read_path(&s.project, path)? != read_path(&s.project, &cursor.path)?
        {
            bail!(
                "cursor_arguments_conflict: cursor belongs to {}; for another file omit cursor and use path/start_line/max_lines",
                cursor.path
            );
        }
        args["path"] = json!(cursor.path);
        if args.get("start_line").is_some() {
            // An explicit start line on the cursor's file is a new range.
            args.as_object_mut().unwrap().remove("cursor");
        } else {
            args["start_line"] = json!(cursor.start_line);
            args["max_lines"] = json!(cursor.max_lines);
            args["offset"] = json!(cursor.offset);
            args["__cursor_hash"] = json!(cursor.hash);
        }
    }
    let Some(path) = args["path"].as_str() else {
        bail!(
            "missing_argument: path; file_read reads a project file by path (relative to the project root) or a listed reference document, or continues a truncated read with cursor alone"
        );
    };
    let path = read_path(&s.project, path)?;
    // A stopped call returns before and after its one read (16 MiB at most).
    if cancel.is_cancelled() {
        bail!("cancelled");
    }
    let contents = read_text(&path)?;
    if cancel.is_cancelled() {
        bail!("cancelled");
    }
    let digest = hash(contents.as_bytes());
    if args["__cursor_hash"]
        .as_str()
        .is_some_and(|expected| expected != digest)
    {
        bail!(
            "file_cursor_expired: file changed; start a new read with path/start_line/max_lines and no cursor"
        );
    }
    let start = n(args, "start_line", 1).max(1);
    let lines = n(args, "max_lines", 2000).clamp(1, 2000);
    let offset = n(args, "offset", 0);
    let total_lines = contents.lines().count();
    if start > total_lines {
        let notice = if total_lines == 0 {
            "The file is empty; there are no lines to read.".to_owned()
        } else {
            format!(
                "start_line {start} is past the end of the file (total_lines {total_lines}); no lines were returned. Read with start_line between 1 and {total_lines}."
            )
        };
        return Ok(
            json!({"path":path,"hash":digest,"total_lines":total_lines,"content":{"text":"","truncated":false},"eof":true,"next_line":null,"notice":notice}),
        );
    }
    let byte_start = contents
        .split_inclusive('\n')
        .take(start - 1)
        .map(str::len)
        .sum::<usize>();
    let byte_len = contents[byte_start..]
        .split_inclusive('\n')
        .take(lines)
        .map(str::len)
        .sum::<usize>();
    let selected = &contents[byte_start..byte_start + byte_len];
    let selected = selected
        .strip_suffix("\r\n")
        .or_else(|| selected.strip_suffix('\n'))
        .unwrap_or(selected);
    if offset > selected.chars().count() {
        bail!(
            "invalid_offset: offset {offset} exceeds {} characters in start_line={start}, max_lines={lines}; copy next_cursor.cursor for continuation",
            selected.chars().count()
        );
    }
    let path_text = path.to_string_lossy();
    let prior = s
        .history
        .bundles
        .iter()
        .filter(|b| b.active)
        .flat_map(|b| b.messages.iter())
        .filter_map(file_read_metadata)
        .filter(|metadata| {
            metadata.path == path_text
                && metadata.source.hash == digest
                && metadata.read_start == start
                && metadata.read_offset == offset
                && (metadata.read_max_lines == lines || metadata.content.truncated)
        })
        .take(REPEATED_READ_LIMIT)
        .count();
    if prior >= REPEATED_READ_LIMIT && !args["force_read"].as_bool().unwrap_or(false) {
        return Ok(
            json!({"path":path,"hash":digest,"total_lines":total_lines,"repeated_read":true,"suppressed":true,"guidance":"Unchanged range already present repeatedly in active context. Reuse it, continue it with its next_cursor, read another range, or force_read=true for deliberate verification."}),
        );
    }
    let mut content = bounded_text(s, selected, offset);
    let shown = content["text"].as_str().unwrap().to_owned();
    let observed_start = start + selected.chars().take(offset).filter(|c| *c == '\n').count();
    let first_line_complete = offset == 0 || selected.chars().nth(offset - 1) == Some('\n');
    let shown_end = offset + shown.chars().count();
    let last_line_complete = if shown.ends_with('\n') {
        true
    } else {
        match selected.chars().nth(shown_end) {
            None => true,
            Some('\n') => !shown.ends_with('\r'),
            Some(_) => false,
        }
    };
    let truncated = content["truncated"].as_bool().unwrap();
    // A range shown to its end with a final line break ends in an empty
    // line, which `lines` does not count; cut there, the next line is unread.
    let empty_last = !truncated && shown.ends_with('\n');
    let line_end = observed_start + shown.lines().count().saturating_sub(1) + usize::from(empty_last);
    content["line_start"] = json!(observed_start);
    content["line_end"] = json!(line_end);
    content["first_line_complete"] = json!(first_line_complete);
    content["last_line_complete"] = json!(last_line_complete);
    let next_line = if truncated {
        Some(start)
    } else {
        (start - 1 + lines < total_lines).then_some(start + lines)
    };
    Ok(
        json!({"path":path,"total_lines":total_lines,"hash":digest,"read_start":start,"read_offset":offset,"read_max_lines":lines,"content":content,"source":{"start_line":observed_start,"end_line":line_end},"next_line":next_line,"next_offset":if truncated{content["next_offset"].clone()}else{json!(0)}}),
    )
}

/// Tokens of the tool message as the model receives it.
pub fn result_tokens(call: &crate::llm::ToolCall, result: &Value, model: &str) -> usize {
    context::count(
        &json!({"role":"tool","tool_call_id":call.id,"content":model_result(result).to_string()}),
        model,
    )
}

/// Room left for the call ID and an `adjusted_arguments` note when a result
/// is fitted before they are known.
pub const MESSAGE_MARGIN: usize = 120;

/// `result_tokens` for a result fitted before its call ID and argument notes
/// are attached: the same message, with room for them.
pub fn message_tokens(result: &Value, model: &str) -> usize {
    context::count(
        &json!({"role":"tool","tool_call_id":"","content":model_result(result).to_string()}),
        model,
    ) + MESSAGE_MARGIN
}

/// What the model sees of a result: file text as `N|line` labels, without
/// the character offsets that drive the runtime's cursors and without the
/// read-range bookkeeping.
pub fn model_result(result: &Value) -> Value {
    let mut shown = result.clone();
    // Source results carry their project root: paths below it are shown
    // relative, as the model reads and cites them.
    if let Some(root) = result["root"].as_str() {
        relativize_paths(&mut shown, Path::new(root));
        if let Some(fields) = shown.as_object_mut() {
            fields.remove("root");
        }
    }
    if result["status"] != "ok" {
        return shown;
    }
    if let Some(data) = shown.get_mut("data").and_then(Value::as_object_mut) {
        data.remove("source");
        data.remove("chunk_ends");
        data.remove(crate::voc_tools::READ_FROM);
        // A search result's place in its list drives the next offset only.
        for target in data.get_mut("results").and_then(Value::as_object_mut).into_iter().flat_map(|t| t.values_mut()) {
            for item in target.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
                if let Some(item) = item.as_object_mut() {
                    item.remove(crate::voc_tools::RANK);
                }
            }
        }
        if let Some(rows) = data.get_mut("matches").and_then(Value::as_array_mut) {
            for row in rows {
                if let Some(row) = row.as_object_mut() {
                    row.remove("source");
                }
            }
        }
    }
    if !result["data"]["read_start"].is_u64() {
        return shown;
    }
    if let Some(data) = shown["data"].as_object_mut() {
        data.remove("read_offset");
        data.remove("next_offset");
        if let Some(content) = data.get_mut("content").and_then(Value::as_object_mut) {
            content.remove("next_offset");
        }
    }
    let content = &mut shown["data"]["content"];
    let (Some(text), Some(start)) = (content["text"].as_str(), content["line_start"].as_u64())
    else {
        return shown;
    };
    if text.is_empty() {
        return shown;
    }
    let mut numbered = text
        .split_inclusive('\n')
        .enumerate()
        .map(|(index, line)| format!("{}|{}", start + index as u64, line))
        .collect::<String>();
    // The empty line a fully shown range ends in gets its number too.
    if text.ends_with('\n') && content["truncated"] == false {
        numbered.push_str(&format!("{}|", start + text.matches('\n').count() as u64));
    }
    let fields = content.as_object_mut().unwrap();
    fields.remove("text");
    fields.insert("numbered_text".into(), json!(numbered));
    shown
}

fn new_file_cursor_id() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    format!(
        "R{}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}
fn file_cursor(project: &str, result: &Value) -> FileCursor {
    let data = &result["data"];
    FileCursor {
        project: project.to_owned(),
        path: data["path"].as_str().unwrap_or_default().into(),
        hash: data["hash"].as_str().unwrap_or_default().into(),
        start_line: data["read_start"].as_u64().unwrap_or(1) as usize,
        max_lines: data["read_max_lines"].as_u64().unwrap_or(1) as usize,
        offset: data["next_offset"].as_u64().unwrap_or(0) as usize,
        handed_out: 0,
    }
}
fn register_file_cursor(s: &mut Workspace, id: String, result: &Value) -> String {
    static HANDED_OUT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let now = HANDED_OUT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut cursor = file_cursor(&s.project.name, result);
    // The same range read again keeps its cursor ID (results already given
    // name it) and counts as handed out now.
    if let Some((existing, known)) = s.file_cursors.iter_mut().find(|(_, known)| **known == cursor) {
        known.handed_out = now;
        return existing.clone();
    }
    // The cursor handed out longest ago goes; IDs count up in issue order
    // ("R10000" sorts before "R9999" as text) and break a tie.
    if s.file_cursors.len() >= Workspace::FILE_CURSORS
        && let Some(oldest) = s
            .file_cursors
            .iter()
            .min_by_key(|(id, known)| (known.handed_out, id.trim_start_matches('R').parse::<u64>().unwrap_or(0)))
            .map(|(id, _)| id.clone())
    {
        s.file_cursors.remove(&oldest);
    }
    cursor.handed_out = now;
    s.file_cursors.insert(id.clone(), cursor);
    id
}

/// Native continuations first, then the result is bounded to `limit` tokens:
/// paged by whole items where a tool pages, or archived in the conversation
/// history with a `history` continuation and shortened.
pub fn limit_result(
    s: &mut Workspace,
    call: &crate::llm::ToolCall,
    args: &Value,
    mut result: Value,
    limit: usize,
) -> Value {
    if call.name == "file_read"
        && result["status"] == "ok"
        && result["data"]["content"]["truncated"] == true
        && !result["next_cursor"]["cursor"].is_string()
    {
        let id = register_file_cursor(s, new_file_cursor_id(), &result);
        result["truncated"] = json!(true);
        result["next_cursor"] = json!({"tool":"file_read","cursor":id});
    }
    // A history read cut at its own budget goes on from its next offset, as
    // a cut file read does from its cursor (and prune keeps what it reads).
    if call.name == "history"
        && args["action"] == "read"
        && result["status"] == "ok"
        && result["data"]["truncated"] == true
        && !result["next_cursor"].is_object()
    {
        result["truncated"] = json!(true);
        result["next_cursor"] =
            json!({"tool":"history","action":"read","id":args["id"],"offset":result["data"]["next_offset"]});
    }
    bound_result(s, call, args, result, limit)
}

/// The generic part of `limit_result`, also used for the knowledge and query
/// tools.
pub fn bound_result(
    s: &mut Workspace,
    call: &crate::llm::ToolCall,
    args: &Value,
    result: Value,
    limit: usize,
) -> Value {
    let model = s.config.model.clone();
    if result_tokens(call, &result, &model) <= limit {
        return result;
    }
    let mut output = result.clone();
    // A document goes on from the knowledge by chunk number (no archive): it
    // is cut at whole chunks, with the cursor to the first one left out.
    if call.name == "knowledge_read"
        && result["status"] == "ok"
        && let Some(page) = knowledge_page(call, &output, limit, &model)
    {
        return page;
    }
    // A search fits itself, as it does to the result budget (shorter
    // excerpts, then fewer items with their next_offset).
    if call.name == "search" && result["status"] == "ok" && output["data"]["results"].is_object() {
        let mut fitted = output.clone();
        crate::voc_tools::fit_search(&mut fitted["data"], limit, &model);
        if result_tokens(call, &fitted, &model) <= limit {
            return fitted;
        }
    }
    // A file read continues from the file with its cursor: it is archived
    // only when its text cannot be narrowed to the limit.
    let reads_file = call.name == "file_read"
        && output["data"]["content"]["text"].is_string();
    // A history search pages by itself (after: next_cursor): it is archived
    // only when not one match fits. An archive would also hold the search's
    // own words for the searches after it to find.
    let pages = call.name == "history" && args["action"] == "search";
    output["truncated"] = json!(true);
    // A history read goes on where it started; an archive past what a cut
    // text or list shows of it (`Archived`), or from the start after a preview.
    let from = if call.name == "history" && args["action"] == "read" { args["offset"].as_u64().unwrap_or(0) } else { 0 };
    if !reads_file && !pages {
        let archive = archive_for(s, call, args, &result);
        output["archive_id"] = json!(archive);
        output["next_cursor"] = json!({"tool":"history","action":"read","id":archive,"offset":from});
    }
    let archived = output["archive_id"]
        .as_u64()
        .filter(|_| call.name != "history")
        .and_then(|id| Archived::new(s, id));
    for pointer in ["/data/content/text", "/data/text"] {
        let Some(text) = output
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let chars: Vec<_> = text.chars().collect();
        let template = output.clone();
        let reading = call.name == "file_read"
            && pointer == "/data/content/text";
        let narrowed_cursor = reading.then(new_file_cursor_id);
        let candidate = |length: usize, s: &Workspace| {
            let mut v = template.clone();
            *v.pointer_mut(pointer).unwrap() = json!(chars[..length].iter().collect::<String>());
            let offset = args["offset"].as_u64().unwrap_or(0).saturating_add(length as u64);
            if reading {
                let line = template["data"]["read_start"].as_u64().unwrap_or(1);
                let offset = template["data"]["read_offset"].as_u64().unwrap_or(0) + length as u64;
                let shown = v["data"]["content"]["text"].as_str().unwrap_or_default();
                let end = v["data"]["content"]["line_start"].as_u64().unwrap_or(line)
                    + shown.lines().count().saturating_sub(1) as u64;
                let complete = if length < chars.len() {
                    shown.ends_with('\n') || (chars[length] == '\n' && !shown.ends_with('\r'))
                } else {
                    template["data"]["content"]["last_line_complete"]
                        .as_bool()
                        .unwrap_or(false)
                };
                v["data"]["content"]["line_end"] = json!(end);
                v["data"]["content"]["last_line_complete"] = json!(complete);
                v["data"]["content"]["truncated"] = json!(true);
                v["data"]["content"]["next_offset"] = json!(offset);
                v["data"]["next_line"] = json!(line);
                v["data"]["next_offset"] = json!(offset);
                v["next_cursor"] = json!({"tool":"file_read","cursor":narrowed_cursor});
                let cursor = file_cursor(&s.project.name, &v);
                if let Some((id, _)) = s.file_cursors.iter().find(|(_, known)| **known == cursor) {
                    v["next_cursor"]["cursor"] = json!(id);
                }
            } else if pointer == "/data/text" && call.name == "history" {
                v["data"]["truncated"] = json!(true);
                v["data"]["next_offset"] = json!(offset);
                v["next_cursor"]["offset"] = json!(offset);
            } else if let Some(data) = v["data"].as_object_mut() {
                // A knowledge read cut inside its text: its end and cursor lie
                // past the cut; the archive continues it.
                data.remove("complete_to_end");
                data.remove("next_cursor");
            }
            if let Some(archived) = &archived {
                v["next_cursor"]["offset"] = json!(archived.shown_through(pointer, &v.pointer(pointer).cloned().unwrap_or_default()));
            }
            v
        };
        let low = longest_within(chars.len(), limit, |length| {
            result_tokens(call, &candidate(length, s), &model)
        });
        output = candidate(low, s);
        if low > 0 && result_tokens(call, &output, &model) <= limit {
            if narrowed_cursor.is_some()
                && let Some(id) = output["next_cursor"]["cursor"].as_str().map(str::to_owned)
            {
                let id = register_file_cursor(s, id, &output);
                output["next_cursor"]["cursor"] = json!(id);
            }
            return output;
        }
    }
    // Collections stay structured: a shortened native page resumes at the
    // first omitted item, other collections continue in the archive.
    for field in ["paths", "matches", "items", "rows", "hits", "files", "counts"] {
        let Some(items) = output["data"][field].as_array().cloned() else {
            continue;
        };
        if items.is_empty() {
            continue;
        }
        // Measured with an offset as long as any the archive can take (a
        // shorter number is no more tokens), placed once the cut is known.
        if let Some(archived) = &archived {
            output["next_cursor"]["offset"] = json!(archived.chars);
        }
        let mut fits = |keep: usize| {
            output["data"][field] = Value::Array(items[..keep].to_vec());
            result_tokens(call, &output, &model) <= limit
        };
        let (mut low, mut high) = (0, items.len());
        while low < high {
            let mid = (low + high).div_ceil(2);
            if fits(mid) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        output["data"][field] = Value::Array(items[..low].to_vec());
        if low > 0 {
            // A result cut again (beside the other results of its response)
            // left out what its first cut did too. Query rows tell all their
            // unseen rows once, as omitted_rows below.
            if !(call.name == "query_run" && field == "rows") {
                let omitted = format!("{field}_omitted");
                let before = output["data"][&omitted].as_u64().unwrap_or(0);
                output["data"][omitted] = json!(before + (items.len() - low) as u64);
            }
            // Rows read from an offset continue right after those shown, and
            // a history search after the last match shown.
            if let (Some(offset), true) = (output["data"]["offset"].as_u64(), output["data"].get("next_offset").is_some()) {
                output["data"]["next_offset"] = json!(offset + low as u64);
            }
            if call.name == "history" && field == "items" {
                output["data"]["next_cursor"] = items[low - 1]["id"].clone();
            }
            // Query rows not shown, the preview's cut ones too, are read
            // with result_read from the first of them.
            if call.name == "query_run"
                && field == "rows"
                && let Some(total) = output["data"]["row_count"].as_u64()
            {
                output["data"]["omitted_rows"] = json!(total.saturating_sub(low as u64));
                output["data"]["guidance"] = json!(format!(
                    "나머지 행은 result_read(step, offset {low})로 읽어라. 답변 표·차트는 step 참조로 화면이 채운다."
                ));
            }
            let start = args["cursor"]
                .as_str()
                .and_then(|cursor| cursor.rsplit_once(':'))
                .and_then(|(_, offset)| offset.parse::<usize>().ok())
                .unwrap_or(0);
            if let Some(cursor) = output["data"]["next_cursor"].as_str().map(str::to_owned)
                && let Some((prefix, _)) = cursor.rsplit_once(':')
            {
                output["data"]["next_cursor"] = json!(format!("{prefix}:{}", start.saturating_add(low)));
            }
            if let Some(archived) = &archived {
                output["next_cursor"]["offset"] = json!(archived.shown_through(&format!("/data/{field}"), &output["data"][field]));
            }
            return output;
        }
    }
    let archive = match output["archive_id"].as_u64() {
        Some(id) => id,
        None => {
            let id = archive_for(s, call, args, &result);
            output["archive_id"] = json!(id);
            output["next_cursor"] = json!({"tool":"history","action":"read","id":id,"offset":from});
            id
        }
    };
    let mut compact = json!({"status":result["status"],"truncated":true,"data":{"message":"Result retained in history; preview is its start. Read the rest with next_cursor (history read, offset) or find a part with history search."},"next_cursor":{"tool":"history","action":"read","id":archive,"offset":from}});
    if let Some(data) = arguments::compact_data(&result["data"]) {
        compact["data"] = data;
    } else if result["status"] == "ok" {
        // As a tool output saved to a file: the start of it, within the limit
        // (a stub cut again keeps showing the start of the result).
        let shown = match result["data"]["preview"].as_str() {
            Some(preview) if result["next_cursor"]["tool"] == "history" => preview.to_owned(),
            _ => model_result(&result)["data"].to_string(),
        };
        let mut room = limit.saturating_sub(result_tokens(call, &compact, &model));
        while room > 0 {
            let mut candidate = compact.clone();
            candidate["data"]["preview"] = json!(context::truncate(&shown, room, &model).0);
            if result_tokens(call, &candidate, &model) <= limit {
                compact = candidate;
                break;
            }
            room = room * 3 / 4;
        }
    }
    if let Some(recovery) = result.get("recovery") {
        compact["recovery"] = recovery.clone();
    }
    if let Some(error) = result["error"].as_str() {
        compact["error"] = json!(context::truncate(error, (limit / 3).clamp(8, 128), &model).0);
    }
    if result_tokens(call, &compact, &model) > limit {
        compact["data"] = Value::Null;
    }
    compact
}

/// A knowledge read cut to the whole chunks that fit `limit`, by the chunk
/// ends it carries: the text of those chunks and the cursor to the next one,
/// or none of it (the cursor reads it again) when not one chunk fits.
fn knowledge_page(call: &crate::llm::ToolCall, result: &Value, limit: usize, model: &str) -> Option<Value> {
    let data = &result["data"];
    let ends: Vec<(i64, usize)> = data["chunk_ends"]
        .as_array()?
        .iter()
        .map(|end| Some((end[0].as_i64()?, end[1].as_u64()? as usize)))
        .collect::<Option<_>>()?;
    let (text, doc) = (data["text"].as_str()?, data["id"].as_str()?);
    let first = ends.first()?.0;
    let page = |taken: usize| {
        let mut page = result.clone();
        let fields = page["data"].as_object_mut().unwrap();
        fields.remove("complete_to_end");
        if taken == 0 {
            fields.remove("chunks");
            fields.remove("chunk_ends");
            fields.insert("text".into(), json!(""));
            let from = data[crate::voc_tools::READ_FROM].as_str().map_or_else(|| format!("{doc}:{first}"), str::to_owned);
            fields.insert("next_cursor".into(), json!(from));
            fields.insert(
                "not_delivered".into(),
                json!("Not one chunk fitted beside the other results of this response; read it with next_cursor."),
            );
        } else {
            let (last, end) = ends[taken - 1];
            fields.insert("text".into(), json!(text.chars().take(end).collect::<String>()));
            fields.insert("chunks".into(), json!(if first == last { first.to_string() } else { format!("{first}-{last}") }));
            fields.insert("chunk_ends".into(), json!(ends[..taken].iter().map(|(no, end)| json!([no, end])).collect::<Vec<_>>()));
            fields.insert("next_cursor".into(), json!(format!("{doc}:{}", last + 1)));
        }
        page["truncated"] = json!(true);
        page
    };
    // Fewer chunks than all of them: those did not fit.
    let (mut low, mut high) = (0, ends.len() - 1);
    while low < high {
        let mid = (low + high).div_ceil(2);
        if result_tokens(call, &page(mid), model) <= limit {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    Some(page(low))
}

/// The longest length up to `n` whose `size` stays within `limit`, for a size
/// that grows about linearly with the length kept (text cut at a character):
/// aimed between the lengths known to fit and not to fit, a few measures of
/// the whole message rather than a binary search, stopping within 1% of the
/// limit.
fn longest_within(n: usize, limit: usize, size: impl Fn(usize) -> usize) -> usize {
    let (mut low, mut high) = (0usize, n);
    let (mut low_size, mut high_size) = (size(0), size(n));
    if high_size <= limit {
        return n;
    }
    if low_size > limit {
        return 0;
    }
    while high - low > 1 && limit - low_size > limit / 100 {
        let share = (limit - low_size) as f64 / (high_size - low_size).max(1) as f64;
        let aim = (low + (share * (high - low) as f64) as usize).clamp(low + 1, high - 1);
        let measured = size(aim);
        if measured <= limit {
            (low, low_size) = (aim, measured);
        } else {
            (high, high_size) = (aim, measured);
        }
    }
    low
}

/// The history bundle holding `result` whole: the one it is already read
/// from or archived in, or a new inactive one.
fn archive_for(s: &mut Workspace, call: &crate::llm::ToolCall, args: &Value, result: &Value) -> u64 {
    if call.name == "history" && args["action"] == "read" {
        return args["id"].as_u64().unwrap_or_default();
    }
    let old = result["archive_id"]
        .as_u64()
        .or_else(|| {
            (result["next_cursor"]["tool"] == "history")
                .then(|| result["next_cursor"]["id"].as_u64())
                .flatten()
        })
        .filter(|id| s.history.read(*id).is_ok());
    if let Some(id) = old {
        return id;
    }
    let id = s.history.push(
        vec![json!({"role":"tool_archive","call_id":call.id,"result":result})],
        true,
    );
    if let Some(bundle) = s.history.bundles.back_mut() {
        bundle.active = false;
    }
    id
}

/// A cut result's archive as a history read shows it, to place where the
/// cut result's continuation goes on.
struct Archived {
    call_id: Value,
    /// The result as archived, whole.
    result: Value,
    text: String,
    /// Characters of `text`, as a read's offset counts them.
    chars: usize,
}
impl Archived {
    fn new(s: &Workspace, id: u64) -> Option<Self> {
        let bundle = s.history.read(id).ok()?;
        let message = bundle.messages.first().filter(|m| m["role"] == "tool_archive")?;
        let text = serde_json::to_string(&context::shown_messages(&bundle.messages[..])).ok()?;
        Some(Self { call_id: message["call_id"].clone(), result: message["result"].clone(), chars: text.chars().count(), text })
    }
    /// Where a read of the archive goes on past `shown`, what a cut result
    /// keeps at `pointer` (the start of its text, its first items): the read
    /// text the archive and the archive with that part alone in its place
    /// have in common from the start. The model was given all of that, and
    /// nothing past it is passed over; a read from the start gave the shown
    /// part again first, a whole result budget of it. The cut result itself
    /// is not compared: what it says before that part may differ from the
    /// archive (a search page's own cursor, cut to the matches it shows,
    /// comes before them), which would place the read before what it shows.
    fn shown_through(&self, pointer: &str, shown: &Value) -> usize {
        let mut cut = self.result.clone();
        let Some(part) = cut.pointer_mut(pointer) else {
            return 0;
        };
        *part = shown.clone();
        let cut = json!({"role":"tool_archive","call_id":self.call_id,"result":cut});
        let cut = serde_json::to_string(&context::shown_messages(&[cut])).unwrap_or_default();
        self.text.chars().zip(cut.chars()).take_while(|(a, b)| a == b).count()
    }
}

/// Removes the project root prefix from `path` values. Reference documents
/// outside the root keep their absolute path.
pub fn relativize_paths(value: &mut Value, root: &Path) {
    let Some(root) = root.to_str().map(|r| r.trim_end_matches(['/', '\\']).to_owned()) else {
        return;
    };
    fn below(path: &str, root: &str) -> Option<String> {
        let rest = path.strip_prefix(root)?;
        (rest.starts_with('/') || rest.starts_with('\\')).then(|| separated(&rest[1..]))
    }
    fn walk(value: &mut Value, root: &str) {
        match value {
            Value::Object(fields) => {
                for (key, value) in fields.iter_mut() {
                    if key == "path"
                        && let Some(text) = value.as_str()
                        && let Some(rest) = below(text, root)
                    {
                        *value = json!(rest);
                    } else if key == "files"
                        && let Some(files) = value.as_array_mut()
                    {
                        // source_search mode=files lists bare paths.
                        for file in files {
                            match file.as_str().and_then(|text| below(text, root)) {
                                Some(rest) => *file = json!(rest),
                                None => walk(file, root),
                            }
                        }
                    } else {
                        walk(value, root);
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, root);
                }
            }
            _ => {}
        }
    }
    walk(value, &root);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// OpenAI refuses a whole request whose function descriptions run past
    /// 1,024 characters ("string too long"); MCP tool descriptions are cut
    /// there too (`mcp::schema::MAX_DESCRIPTION`).
    #[test]
    fn every_tool_description_fits_openais_limit() {
        let all: BTreeSet<&str> = ToolRegistry::specs().iter().map(|s| s.name).collect();
        for definition in ToolRegistry::definitions(&all) {
            let description = definition["function"]["description"].as_str().unwrap();
            let length = description.chars().count();
            assert!(length <= 1_024, "{} has {length} characters", definition["function"]["name"]);
        }
    }

    #[test]
    fn two_projects_make_the_project_required_and_listed() {
        let offered: BTreeSet<&str> = ["file_read", "source_search", "history", "search"].into_iter().collect();
        let project = |name: &str| Project { name: name.into(), ..Default::default() };
        let mut one = ToolRegistry::definitions(&offered);
        require_project(&mut one, &[project("app")]);
        assert_eq!(one, ToolRegistry::definitions(&offered), "one project may be omitted");
        let mut two = ToolRegistry::definitions(&offered);
        require_project(&mut two, &[project("app"), project("batch")]);
        for definition in &two {
            let parameters = &definition["function"]["parameters"];
            match definition["function"]["name"].as_str().unwrap() {
                "file_read" | "source_search" => {
                    assert_eq!(parameters["properties"]["project"]["enum"], json!(["app", "batch"]));
                    assert_eq!(parameters["required"][0], "project", "{parameters}");
                }
                _ => assert!(parameters["properties"].get("project").is_none()),
            }
        }
    }

    /// Full review, 2026-10-22 (fourth session): a project registered at
    /// the backend's own folder let file_read open the backend's credentials
    /// file (an explicit path does not go by `.gitignore`), and handed the
    /// keys in it to the model and the asker.
    #[test]
    fn the_backends_own_secret_files_stay_out_of_every_project() {
        let dir = tempfile::tempdir().unwrap();
        let backend = dir.path().join("backend");
        std::fs::create_dir(&backend).unwrap();
        std::fs::write(backend.join("config.credentials.json"), "{\"llm_api_key\":\"sk-kept-out\"}\n").unwrap();
        std::fs::write(backend.join("main.rs"), "fn main() {} // sk-kept-out is a word here\n").unwrap();
        keep_out(&crate::config::credentials_path(&backend.join("config.toml")));
        let mut s = workspace(dir.path());
        let cancel = tokio_util::sync::CancellationToken::new();
        for path in ["backend/config.credentials.json", "backend/./CONFIG.credentials.json"] {
            let read = execute(&mut s, "file_read", json!({"path":path}), &cancel);
            if cfg!(target_os = "linux") && path.contains("CONFIG") {
                continue;
            }
            let error = read.unwrap_err().to_string();
            assert!(error.starts_with("path_excluded"), "{path}: {error}");
        }
        let listed = execute(&mut s, "file_list", json!({"mode":"paths"}), &cancel).unwrap();
        assert_eq!(listed["paths"], json!(["backend/main.rs"]));
        let found = execute(&mut s, "source_search", json!({"query":"sk-kept-out"}), &cancel).unwrap();
        assert_eq!(found["matching_files"], 1, "{found}");
        assert_eq!(found["matches"][0]["path"].as_str().unwrap(), backend.join("main.rs").canonicalize().unwrap().to_str().unwrap());
    }

    fn workspace(root: &Path) -> Workspace {
        Workspace {
            project: Project {
                name: "app".into(),
                root: root.into(),
                docs: vec!["../guide.md".into()],
                ..Default::default()
            },
            config: ToolConfig {
                model: "gpt-4o".into(),
                result_tokens: 4000,
                tool_timeout_secs: 30,
            },
            file_cursors: BTreeMap::new(),
            list_cursor_scopes: VecDeque::new(),
            history: Default::default(),
        }
    }

    /// The walker opens every directory's ignore files itself, before any
    /// of our checks: one that is a pipe blocked the walk forever (cancel
    /// could not reach it), and one linked to /dev/zero was read until the
    /// process ran out of memory.
    #[cfg(unix)]
    #[test]
    fn walks_skip_ignore_files_that_are_not_small_regular_files() {
        use std::os::unix::ffi::OsStrExt;
        let fifo = |path: &Path| {
            let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o644) }, 0);
        };
        let walk = |root: PathBuf| {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let project = Project { name: "app".into(), root: root.clone(), ..Default::default() };
                let found = candidate_paths_counted(&project, None, &tokio_util::sync::CancellationToken::new(), None, None)
                    .map(|(paths, _)| paths.iter().map(|p| p.strip_prefix(root.canonicalize().unwrap()).unwrap().display().to_string()).collect::<Vec<_>>());
                let _ = tx.send(found);
            });
            rx.recv_timeout(std::time::Duration::from_secs(10)).expect("the walk blocked on an ignore file")
        };
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("app");
        for sub in ["src", "piped", "piped_link", "endless", "huge", "src/kept"] {
            std::fs::create_dir_all(root.join(sub)).unwrap();
            std::fs::write(root.join(sub).join("a.rs"), "fn a() {}\n").unwrap();
        }
        fifo(&root.join("piped/.gitignore"));
        fifo(&dir.path().join("outside_pipe"));
        std::os::unix::fs::symlink(dir.path().join("outside_pipe"), root.join("piped_link/.ignore")).unwrap();
        std::os::unix::fs::symlink("/dev/zero", root.join("endless/.gitignore")).unwrap();
        std::fs::write(root.join("huge/.gitignore"), "x\n".repeat(600_000)).unwrap();
        // Ordinary ignore files still apply.
        std::fs::write(root.join("src/kept/.gitignore"), "a.rs\n").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        assert_eq!(walk(root.clone()).unwrap(), ["src/a.rs", "src/kept/.gitignore"]);

        let other = dir.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("a.rs"), "fn a() {}\n").unwrap();
        fifo(&other.join(".gitignore"));
        let error = walk(other).unwrap_err().to_string();
        assert!(error.starts_with("unsafe_ignore_file"), "{error}");
    }

    /// The model saw every source path relative to the project root but
    /// those of source_search mode=files, a list of bare paths: absolute,
    /// the root in front of each.
    #[test]
    fn searched_file_lists_are_shown_relative_to_the_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(dir.path().join("b.rs"), "fn a() {}\n").unwrap();
        let mut ws = workspace(dir.path());
        let cancel = tokio_util::sync::CancellationToken::new();
        let root = dir.path().canonicalize().unwrap().display().to_string();
        for (mode, field) in [("files", "files"), ("count", "counts")] {
            let data = execute(&mut ws, "source_search", json!({"query":"fn a","mode":mode}), &cancel).unwrap();
            let mut result = envelope(Ok(data));
            result["root"] = json!(root);
            let shown = model_result(&result);
            assert!(!shown.to_string().contains(&root), "{mode}: {shown}");
            let paths: Vec<Value> = match mode {
                "files" => shown["data"][field].as_array().unwrap().clone(),
                _ => shown["data"][field].as_array().unwrap().iter().map(|c| c["path"].clone()).collect(),
            };
            assert_eq!(paths, [json!("b.rs"), json!("src/a.rs")], "{mode}");
        }
    }

    /// Performance review, 2026-10-23: source_search hashed every file in
    /// scope into its cursor and matched each line on its own, 1.35s for
    /// 20,000 files (313 MB) with one match among them. Files without a
    /// match are passed over in one scan and left out of the cursor, which
    /// still expires when a file with a match changes.
    #[test]
    fn a_search_cursor_follows_only_the_files_that_match() {
        let dir = tempfile::tempdir().unwrap();
        let hits: String = (0..5).map(|i| format!("let Hit_{i} = load();\nlet other = 1;\n")).collect();
        std::fs::write(dir.path().join("a.rs"), &hits).unwrap();
        std::fs::write(dir.path().join("b.rs"), "nothing here\n").unwrap();
        let mut ws = workspace(dir.path());
        let cancel = tokio_util::sync::CancellationToken::new();
        let args = json!({"query":"load()","whole_word":true,"limit":2});
        let first = execute(&mut ws, "source_search", args.clone(), &cancel).unwrap();
        assert_eq!(first["total_matching_lines"], 5);
        let cursor = first["next_cursor"].as_str().unwrap().to_owned();
        let next = |ws: &mut Workspace| {
            let mut args = args.clone();
            args["cursor"] = json!(cursor);
            execute(ws, "source_search", args, &cancel)
        };
        std::fs::write(dir.path().join("b.rs"), "still nothing\n").unwrap();
        let second = next(&mut ws).unwrap();
        assert_eq!(second["matches"][0]["line"], 5, "{second}");
        // Case-insensitive OR finds the same lines as by lines alone.
        let either = execute(&mut ws, "source_search", json!({"queries":["hit_3","absent"],"case_sensitive":false}), &cancel).unwrap();
        assert_eq!(either["matches"][0]["line"], 7, "{either}");
        std::fs::write(dir.path().join("a.rs"), format!("// moved\n{hits}")).unwrap();
        assert!(next(&mut ws).unwrap_err().to_string().starts_with("cursor_expired"));
    }

    /// The descriptions and hints say `**` crosses directories; `*` did
    /// too, so `src/*.rs` was every Rust file below src.
    #[test]
    fn path_globs_cross_directories_only_with_double_stars() {
        let dir = tempfile::tempdir().unwrap();
        for file in ["main.rs", "src/a.rs", "src/deep/b.rs", "src/deep/main.rs", "docs/c.md"] {
            let path = dir.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "fn a() {}\n").unwrap();
        }
        let mut ws = workspace(dir.path());
        let cancel = tokio_util::sync::CancellationToken::new();
        let mut list = |glob: &str| {
            let data = execute(&mut ws, "file_list", json!({"path_glob":glob,"mode":"paths"}), &cancel).unwrap();
            data["paths"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_owned()).collect::<Vec<_>>()
        };
        assert_eq!(list("src/*.rs"), ["src/a.rs"]);
        assert_eq!(list("./src/*.rs"), ["src/a.rs"]);
        assert_eq!(list("src/**/*.rs"), ["src/a.rs", "src/deep/b.rs", "src/deep/main.rs"]);
        assert_eq!(list("src/**"), ["src/a.rs", "src/deep/b.rs", "src/deep/main.rs"]);
        assert_eq!(list("*/*.rs"), ["src/a.rs"]);
        assert_eq!(list("./*.rs"), ["main.rs"]);
        // Written from the root, as in an ignore file.
        assert_eq!(list("/src/*.rs"), ["src/a.rs"]);
        assert_eq!(list("/*.rs"), ["main.rs"]);
        // Without a directory, at any depth.
        assert_eq!(list("*.rs"), ["main.rs", "src/a.rs", "src/deep/b.rs", "src/deep/main.rs"]);
        assert_eq!(list("main.rs"), ["main.rs", "src/deep/main.rs"]);
        assert_eq!(list("**/b.rs"), ["src/deep/b.rs"]);
        assert_eq!(list("**/*"), ["docs/c.md", "main.rs", "src/a.rs", "src/deep/b.rs", "src/deep/main.rs"]);
        // Tool review, 2026-10-22 (ninth pass): a glob naming a
        // directory matched no file, without a word.
        assert_eq!(list("src/deep/"), ["src/deep/b.rs", "src/deep/main.rs"]);
        assert_eq!(list("./src/"), ["src/a.rs", "src/deep/b.rs", "src/deep/main.rs"]);
        assert_eq!(list("/").len(), 5);
        assert_eq!(list("./").len(), 5);
        let found = execute(&mut ws, "source_search", json!({"query":"fn a","path_glob":"src/*.rs","mode":"files"}), &cancel).unwrap();
        assert_eq!(found["matching_files"], 1, "{found}");
    }

    /// Tool review, 2026-10-21 (fourth pass): a whole-word regular
    /// expression was wrapped in `\b`, which needs a word character beyond
    /// a pattern ending in punctuation: `load\(\)` matched no call.
    #[test]
    fn whole_words_stand_apart_as_literals_and_as_expressions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "load();\nx = load() + 1\nreload()\nunload_all()\nload_more()\n").unwrap();
        let mut ws = workspace(dir.path());
        let cancel = tokio_util::sync::CancellationToken::new();
        let mut lines = |args: Value| {
            let data = execute(&mut ws, "source_search", args, &cancel).unwrap();
            data["matches"].as_array().unwrap().iter().map(|m| m["line"].as_u64().unwrap()).collect::<Vec<_>>()
        };
        assert_eq!(lines(json!({"query":"load()","whole_word":true})), [1, 2]);
        assert_eq!(lines(json!({"query":r"load\(\)","regex":true,"whole_word":true})), [1, 2]);
        assert_eq!(lines(json!({"query":"load","regex":true,"whole_word":true})), [1, 2]);
        assert_eq!(lines(json!({"query":"(re|un)load","regex":true,"whole_word":true})), [3]);
        assert_eq!(lines(json!({"query":"^load","regex":true,"whole_word":true})), [1]);
    }

    /// Tool review, 2026-10-22 (fifth pass): file_list and source_search had
    /// no time limit (only the symbol tools kept "소스 도구 한도"): a
    /// search of a large project held the question until it ran out.
    #[test]
    fn file_tools_stop_at_the_source_tool_limit_and_say_to_narrow() {
        let past = std::time::Instant::now();
        let error = past_deadline(past, "source_search", 119, 400, 30, "narrow path or path_glob").unwrap_err().to_string();
        assert!(error.starts_with("scope_timeout: source_search read 119 of 400 files within its 30s limit"), "{error}");
        assert_eq!(recovery::describe(&error)["action"], "narrow_the_scope");
        let later = std::time::Instant::now() + std::time::Duration::from_secs(60);
        assert!(past_deadline(later, "file_list", 0, 1, 30, "").is_ok());
        let dir = tempfile::tempdir().unwrap();
        let project = Project { root: dir.path().into(), ..Default::default() };
        let walk = candidate_paths_scoped(&project, None, &tokio_util::sync::CancellationToken::new(), None, Some(past)).unwrap_err().to_string();
        assert!(walk.starts_with("scope_timeout: listing the files"), "{walk}");
        // Eighth pass: a walk past the limit was told as transient
        // (`cancelled_or_timeout`), to be sent again.
        assert_eq!(recovery::describe(&walk)["action"], "narrow_the_scope");
    }

    /// Fourth pass: on Windows the tools showed paths with `\`, and a glob
    /// written so matched nothing; elsewhere `\` stays a glob's escape.
    #[test]
    fn tool_paths_are_separated_by_slashes() {
        if cfg!(windows) {
            assert_eq!(separated(r"src\sub\a.rs"), "src/sub/a.rs");
        } else {
            assert_eq!(separated(r"src/\[x\].rs"), r"src/\[x\].rs");
        }
    }

    /// Tool review, 2026-10-21 (third pass): path_glob matched as sent,
    /// unlike the project's include/exclude globs: a Korean name typed
    /// composed missed a file named decomposed (as a Mac names it), and a
    /// name in other case missed the file.
    #[test]
    fn path_globs_match_without_case_or_unicode_form() {
        use unicode_normalization::UnicodeNormalization;
        let dir = tempfile::tempdir().unwrap();
        let decomposed: String = "docs/회의록.md".nfd().collect();
        for file in ["README.md", decomposed.as_str(), "src/Main.RS"] {
            let path = dir.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x\n").unwrap();
        }
        let mut ws = workspace(dir.path());
        let cancel = tokio_util::sync::CancellationToken::new();
        let mut list = |glob: &str| {
            let data = execute(&mut ws, "file_list", json!({"path_glob":glob,"mode":"paths"}), &cancel).unwrap();
            data["paths"].as_array().unwrap().len()
        };
        assert_eq!(list("**/readme.md"), 1);
        assert_eq!(list("**/회의록.md"), 1);
        assert_eq!(list("docs/회의*"), 1);
        assert_eq!(list("src/*.rs"), 1);
        assert_eq!(list("*.MD"), 2);
        assert_eq!(list("src/*.md"), 0);
    }

    /// Tool review, 2026-10-22 (ninth pass): the README says to exclude a
    /// folder holding secrets; written as in an ignore file (`secrets/`, or
    /// `secrets`), its files stayed readable, `secrets` refused the folder
    /// alone, and `.env` excluded the root's but not `config/.env`. Includes
    /// written so selected nothing.
    #[test]
    fn project_rules_read_as_an_ignore_file_does() {
        let dir = tempfile::tempdir().unwrap();
        for file in ["secrets/key.pem", "config/.env", ".env", "src/a.rs", "src/sub/b.rs", "README.md"] {
            let path = dir.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x\n").unwrap();
        }
        let cancel = tokio_util::sync::CancellationToken::new();
        let visible = |include: &[&str], exclude: &[&str]| {
            let mut ws = workspace(dir.path());
            ws.project.include = include.iter().map(|p| p.to_string()).collect();
            ws.project.exclude = exclude.iter().map(|p| p.to_string()).collect();
            let listed = execute(&mut ws, "file_list", json!({"mode":"paths"}), &cancel).unwrap();
            let listed: Vec<String> = listed["paths"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_owned()).collect();
            for file in ["secrets/key.pem", "config/.env", ".env", "src/a.rs", "README.md"] {
                let read = execute(&mut ws, "file_read", json!({"path":file}), &cancel);
                assert_eq!(read.is_ok(), listed.iter().any(|p| p == file), "{file}: {include:?} {exclude:?}");
            }
            listed
        };
        for exclude in [["secrets/", ".env"], ["secrets", ".ENV"], ["/secrets/", "**/.env"], ["secrets/**", "config/.env"]] {
            let listed = visible(&[], &exclude);
            let hidden: &[&str] = if exclude[1] == "config/.env" { &["secrets/key.pem", "config/.env"] } else { &["secrets/key.pem", "config/.env", ".env"] };
            assert!(listed.iter().all(|p| !hidden.contains(&p.as_str())), "{exclude:?}: {listed:?}");
            assert!(listed.contains(&"src/a.rs".to_owned()), "{exclude:?}: {listed:?}");
        }
        for include in ["src", "src/", "./src", "src/**"] {
            assert_eq!(visible(&[include], &[]), ["src/a.rs", "src/sub/b.rs"], "{include}");
        }
        assert_eq!(visible(&["/src/sub/"], &[]), ["src/sub/b.rs"]);
        assert_eq!(visible(&["*.rs"], &[]), ["src/a.rs", "src/sub/b.rs"]);
        assert_eq!(visible(&["**/*.log"], &[]), Vec::<String>::new());
    }

    #[test]
    fn reads_stay_inside_the_root_except_listed_documents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("app");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(dir.path().join("guide.md"), "# Guide\n").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "x").unwrap();
        let ws = workspace(&root);
        assert!(read_path(&ws.project, "src/a.rs").is_ok());
        assert!(read_path(&ws.project, dir.path().join("guide.md").to_str().unwrap()).is_ok());
        assert!(read_path(&ws.project, "../guide.md").is_ok());
        let error = read_path(&ws.project, "../secret.txt").unwrap_err().to_string();
        assert!(error.starts_with("path_outside_project"), "{error}");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/config"), "x").unwrap();
        let error = read_path(&ws.project, ".git/config").unwrap_err().to_string();
        assert!(error.starts_with("path_excluded"), "{error}");
        // An always-skipped folder is named as such, not blamed on the
        // project's include/exclude settings, which cannot add it back.
        assert!(error.contains("is in .git,") && !error.contains("settings and"), "{error}");
        std::fs::create_dir_all(root.join("src/build")).unwrap();
        std::fs::write(root.join("src/build/out.rs"), "fn b() {}\n").unwrap();
        let mut included = ws.project.clone();
        included.include = vec!["src/build/**".into()];
        let error = read_path(&included, "src/build/out.rs").unwrap_err().to_string();
        assert!(error.contains("is in build, a version-control, dependency or build-output folder"), "{error}");
        included.exclude = vec!["src/a.rs".into()];
        let error = read_path(&included, "src/a.rs").unwrap_err().to_string();
        assert!(error.contains("include/exclude settings"), "{error}");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.path().join("secret.txt"), root.join("link.txt")).unwrap();
            let error = read_path(&ws.project, "link.txt").unwrap_err().to_string();
            assert!(error.starts_with("path_outside_project"), "{error}");
        }
    }

    #[test]
    fn file_read_numbers_lines_and_continues_with_a_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=400).map(|i| format!("line {i} {}\n", "x".repeat(60))).collect();
        std::fs::write(dir.path().join("big.txt"), &body).unwrap();
        let mut ws = workspace(dir.path());
        ws.config.result_tokens = 600;
        let call = crate::llm::ToolCall {
            id: "c1".into(),
            name: "file_read".into(),
            arguments: "{}".into(),
        };
        let args = json!({"path":"big.txt","max_lines":400});
        let result = envelope(execute(&mut ws, "file_read", args.clone(), &Default::default()));
        let result = limit_result(&mut ws, &call, &args, result, 600);
        assert_eq!(result["truncated"], true);
        let shown = model_result(&result);
        assert!(shown["data"]["content"]["numbered_text"].as_str().unwrap().starts_with("1|line 1"));
        let cursor = result["next_cursor"]["cursor"].as_str().unwrap().to_owned();
        let next = envelope(execute(&mut ws, "file_read", json!({"cursor":cursor}), &Default::default()));
        assert_eq!(next["status"], "ok", "{next}");
        assert!(next["data"]["content"]["line_start"].as_u64().unwrap() > 1);
    }

    #[test]
    fn a_full_cursor_table_drops_the_oldest_cursor_not_the_first_by_name() {
        // Cursor IDs count up across the process: "R10000" sorts before
        // "R9999" as text, so the newest cursor was dropped first.
        let dir = tempfile::tempdir().unwrap();
        let mut ws = workspace(dir.path());
        for n in 9_000..9_000 + Workspace::FILE_CURSORS as u64 {
            let mut cursor = file_cursor("p", &json!({"data":{"path":"a.rs","hash":"h","read_start":1,"read_max_lines":10}}));
            cursor.offset = n as usize;
            ws.file_cursors.insert(format!("R{n}"), cursor);
        }
        let result = json!({"data":{"path":"a.rs","hash":"h","read_start":1,"read_max_lines":10,"next_offset":1}});
        let newest = register_file_cursor(&mut ws, "R10000".into(), &result);
        let mut next = result.clone();
        next["data"]["next_offset"] = json!(2);
        register_file_cursor(&mut ws, "R10001".into(), &next);
        assert!(ws.file_cursors.contains_key(&newest), "the cursor issued last call is kept");
        assert!(!ws.file_cursors.contains_key("R9000") && !ws.file_cursors.contains_key("R9001"));
    }

    /// Context management review, thirteenth pass: a read whose cursor was
    /// issued before (the same range read again) is handed the earlier ID,
    /// and the full table dropped the lowest ID first — the cursor the model
    /// had just received, while hundreds issued after it stayed.
    #[test]
    fn a_cursor_handed_out_again_is_kept_as_a_recent_one() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = workspace(dir.path());
        let at = |offset: usize| json!({"data":{"path":"a.rs","hash":"h","read_start":1,"read_max_lines":10,"next_offset":offset}});
        let again = register_file_cursor(&mut ws, "R1".into(), &at(1));
        for n in 2..=Workspace::FILE_CURSORS {
            register_file_cursor(&mut ws, format!("R{n}"), &at(n));
        }
        // The first range read again: its cursor is handed out once more.
        assert_eq!(register_file_cursor(&mut ws, "R9999".into(), &at(1)), again);
        register_file_cursor(&mut ws, "R10000".into(), &at(10_000));
        assert!(ws.file_cursors.contains_key(&again), "the cursor just handed out again stays");
        assert!(!ws.file_cursors.contains_key("R2"), "the one least recently handed out goes");
        assert_eq!(ws.file_cursors.len(), Workspace::FILE_CURSORS);
    }

    #[test]
    fn file_read_reads_2000_lines_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=2500).map(|i| format!("{i}\n")).collect();
        std::fs::write(dir.path().join("n.txt"), &body).unwrap();
        let mut ws = workspace(dir.path());
        ws.config.result_tokens = 25_000;
        let result = envelope(execute(&mut ws, "file_read", json!({"path":"n.txt"}), &Default::default()));
        assert_eq!(result["data"]["content"]["line_end"], 2000, "{result}");
        assert_eq!(result["data"]["next_line"], 2001);
    }

    #[test]
    fn a_large_default_read_is_cut_to_the_limit_without_an_archive() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=3000).map(|i| format!("    let value_{i} = compute(alpha, beta, {i});\n")).collect();
        std::fs::write(dir.path().join("big.rs"), &body).unwrap();
        let mut ws = workspace(dir.path());
        ws.config.result_tokens = 25_000;
        let call = crate::llm::ToolCall { id: "f".into(), name: "file_read".into(), arguments: "{}".into() };
        let args = json!({"path":"big.rs"});
        let result = envelope(execute(&mut ws, "file_read", args.clone(), &Default::default()));
        let result = limit_result(&mut ws, &call, &args, result, 25_000);
        assert!(result_tokens(&call, &result, "gpt-4o") <= 25_000);
        assert!(result_tokens(&call, &result, "gpt-4o") > 20_000, "the limit is used");
        // The file is the archive: the cursor reads on from it.
        assert!(result.get("archive_id").is_none(), "{}", result["archive_id"]);
        assert!(ws.history.bundles.is_empty());
        let cursor = result["next_cursor"]["cursor"].as_str().unwrap().to_owned();
        let next = envelope(execute(&mut ws, "file_read", json!({"cursor":cursor}), &Default::default()));
        let shown_end = result["data"]["content"]["line_end"].as_u64().unwrap();
        assert!(next["data"]["content"]["line_start"].as_u64().unwrap() >= shown_end, "{next}");
    }

    #[test]
    fn a_cut_history_search_continues_after_the_last_match_shown() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = workspace(dir.path());
        for i in 0..30 {
            ws.history.push(vec![json!({"role":"tool","content":format!("needle {i} {}", "건초 ".repeat(40))})], true);
        }
        for bundle in ws.history.bundles.iter_mut() {
            bundle.active = false;
        }
        let call = crate::llm::ToolCall { id: "h".into(), name: "history".into(), arguments: "{}".into() };
        let args = json!({"action":"search","query":"needle","limit":10});
        let result = envelope(execute(&mut ws, "history", args.clone(), &Default::default()));
        assert_eq!(result["data"]["items"].as_array().unwrap().len(), 10);
        let full = result_tokens(&call, &result, "gpt-4o");
        let cut = bound_result(&mut ws, &call, &args, result, full / 3);
        let items = cut["data"]["items"].as_array().unwrap();
        assert!(!items.is_empty() && items.len() < 10, "{cut}");
        assert_eq!(cut["data"]["next_cursor"], items.last().unwrap()["id"], "{cut}");
        // It pages by itself: no archive, which would hold the matches for
        // the next search to find again.
        assert_eq!(ws.history.bundles.len(), 30, "{cut}");
        assert!(cut.get("archive_id").is_none() && cut["next_cursor"].is_null(), "{cut}");
    }

    #[test]
    fn a_cut_history_read_says_where_it_goes_on() {
        // A read cut by its own budget, whose text has few characters to
        // escape, fit the result limit as cut: it said truncated:false with
        // no next_cursor, and prune did not keep the bundle it goes on in.
        let dir = tempfile::tempdir().unwrap();
        let call = crate::llm::ToolCall { id: "h".into(), name: "history".into(), arguments: "{}".into() };
        let mut seed: u64 = 0x415;
        let mut next = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n.max(1)
        };
        for run in 0..12 {
            let mut ws = workspace(dir.path());
            ws.config.result_tokens = 1_000 + next(4_000);
            let text = if run % 2 == 0 { "가나다라 마바사 ".repeat(3_000) } else { "line \"q\"\n".repeat(2_000) };
            let id = ws.history.push(vec![json!({"role":"user","content":text})], true);
            ws.history.bundles[0].active = false;
            let whole = serde_json::to_string(&context::shown_messages(&ws.history.bundles[0].messages[..])).unwrap();
            let mut args = json!({"action":"read","id":id});
            let mut shown = String::new();
            let mut reads = 0;
            loop {
                reads += 1;
                assert!(reads < 1_000, "run {run}: the reads do not end");
                let budget = ws.config.result_tokens;
                let result = envelope(execute(&mut ws, "history", args.clone(), &Default::default()));
                let mut result = limit_result(&mut ws, &call, &args, result, budget);
                let mut limit = budget;
                if next(3) == 0 {
                    limit = 300 + next(budget);
                    result = bound_result(&mut ws, &call, &args, result, limit);
                }
                assert!(result_tokens(&call, &result, "gpt-4o") <= limit, "run {run}");
                shown.push_str(result["data"]["text"].as_str().unwrap());
                if result["data"]["truncated"] != true {
                    assert!(result["next_cursor"].is_null(), "run {run}: {}", result["next_cursor"]);
                    break;
                }
                assert_eq!(result["truncated"], true, "run {run}: {}", result["next_cursor"]);
                assert_eq!(result["next_cursor"]["tool"], "history", "run {run}: {}", result["next_cursor"]);
                assert_eq!(result["next_cursor"]["offset"], result["data"]["next_offset"], "run {run}");
                // While the cut read is in the context, prune keeps what it reads.
                let mut kept = ws.history.clone();
                kept.push(
                    vec![
                        json!({"role":"assistant","content":null,"tool_calls":[{"id":"h","type":"function","function":{"name":"history","arguments":args.to_string()}}]}),
                        json!({"role":"tool","tool_call_id":"h","content":result.to_string()}),
                    ],
                    true,
                );
                kept.prune(0);
                assert!(kept.read(id).is_ok(), "run {run}: the bundle being read was pruned");
                args = json!({"action":"read","id":result["next_cursor"]["id"],"offset":result["next_cursor"]["offset"]});
            }
            assert!(reads > 1, "run {run}: the read was not cut");
            assert!(shown == whole, "run {run}: shown {} of {} chars", shown.chars().count(), whole.chars().count());
        }
    }

    /// Context management review, seventh pass: a history read from past
    /// the end of its bundle (an offset worked out by the model, or copied
    /// from another bundle's search item) was an empty text with nothing
    /// after it, read as a bundle that holds nothing.
    #[test]
    fn a_history_read_past_the_end_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = workspace(dir.path());
        let id = ws.history.push(vec![json!({"role":"user","content":"BATCH007 상태"})], true);
        let length = serde_json::to_string(&context::shown_messages(&ws.history.bundles[0].messages[..])).unwrap().chars().count();
        let at_end = envelope(execute(&mut ws, "history", json!({"action":"read","id":id,"offset":length}), &Default::default()));
        assert_eq!((at_end["status"].clone(), at_end["data"]["text"].clone()), (json!("ok"), json!("")), "{at_end}");
        let past = envelope(execute(&mut ws, "history", json!({"action":"read","id":id,"offset":length + 5_000}), &Default::default()));
        assert_eq!(past["status"], "error", "{past}");
        assert!(past["error"].as_str().unwrap().starts_with("invalid_offset") && past["error"].as_str().unwrap().contains(&format!("{length} characters")), "{past}");
    }

    /// Context management review, eighteenth pass: a result cut to its text's
    /// start or its first items (an MCP tool's text, a list of methods) went
    /// on from its archive at offset 0, so the first read of its next_cursor
    /// gave again what the cut result had shown — a whole result budget of
    /// it, where an MCP tool's large results are cut every time.
    #[test]
    fn a_cut_result_goes_on_from_its_archive_where_it_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed: u64 = 0x18c7;
        let mut next = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n.max(1)
        };
        let text: String = (1..=3_000).map(|i| format!("line {i}: \"q\" \\ 가나 😀\n")).collect();
        let items: Vec<Value> = (1..=40).map(|i| json!({"id":format!("m{i}"),"title":format!("방법 {i}"),"method":"절차 \"따옴\" ".repeat(30)})).collect();
        for run in 0..16 {
            let mut ws = workspace(dir.path());
            ws.config.model = ["gpt-4o", "unknown-model"][run % 2].into();
            let model = ws.config.model.clone();
            let (name, data) = if run % 4 < 2 { ("fs__read_text_file", json!({"text":text})) } else { ("method_read", json!({"items":items})) };
            let call = crate::llm::ToolCall { id: format!("c{run}"), name: name.into(), arguments: "{}".into() };
            let limit = 1_000 + next(4_000);
            let mut cut = bound_result(&mut ws, &call, &json!({}), envelope(Ok(data)), limit);
            if next(2) == 0 {
                // Cut again beside the other results of its response.
                cut = bound_result(&mut ws, &call, &json!({}), cut, (limit / 2).max(800));
            }
            let cursor = &cut["next_cursor"];
            assert_eq!(cursor["tool"], "history", "run {run}: {cut}");
            let id = cursor["id"].as_u64().unwrap();
            let whole = serde_json::to_string(&context::shown_messages(&ws.history.read(id).unwrap().messages[..])).unwrap();
            let offset = cursor["offset"].as_u64().unwrap() as usize;
            // Past what the cut result shows of the archive, and no further.
            let shown = serde_json::to_string(&context::shown_messages(&[json!({"role":"tool_archive","call_id":call.id,"result":cut})])).unwrap();
            let passed: String = whole.chars().take(offset).collect();
            assert!(shown.starts_with(&passed), "run {run}: the offset passes over what was not shown");
            let start = if name == "method_read" { serde_json::to_string(&cut["data"]["items"]).unwrap() } else { serde_json::to_string(&cut["data"]["text"]).unwrap() };
            assert!(passed.ends_with(&start[..start.len() - 1]), "run {run}: the read starts at offset {offset}, before the end of what was shown");
            // Followed as given, the reads give the rest of the archive.
            let read_call = crate::llm::ToolCall { id: "h".into(), name: "history".into(), arguments: "{}".into() };
            let mut args = json!({"action":"read","id":id,"offset":offset});
            let mut rest = String::new();
            for _ in 0..1_000 {
                let result = envelope(execute(&mut ws, "history", args.clone(), &Default::default()));
                let result = limit_result(&mut ws, &read_call, &args, result, limit);
                rest.push_str(result["data"]["text"].as_str().unwrap());
                if result["next_cursor"].is_null() {
                    break;
                }
                args = json!({"action":"read","id":id,"offset":result["next_cursor"]["offset"]});
            }
            assert_eq!(rest, whole.chars().skip(offset).collect::<String>(), "run {run}");
            assert!(result_tokens(&call, &cut, &model) <= limit, "run {run}");
        }
    }

    /// Context management review, nineteenth pass: a source search cut while
    /// pages follow says its own page cursor before its list, and the cut
    /// moves it to the first item it leaves out. The archive's next_cursor
    /// was placed where the cut result and the archive stop agreeing from
    /// the start — at that cursor, before every item shown — so its first
    /// read gave the shown matches (files, counts) again.
    #[test]
    fn a_cut_search_page_goes_on_from_its_archive_past_what_it_shows() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..300 {
            std::fs::write(dir.path().join(format!("module_{i:03}_with_a_longer_name.rs")), format!("fn f{i}() {{ let needle = \"{i}\"; }}\n").repeat(2)).unwrap();
        }
        let read_call = crate::llm::ToolCall { id: "h".into(), name: "history".into(), arguments: "{}".into() };
        for run in 0..6 {
            let mut ws = workspace(dir.path());
            let (mode, field) = [("matches", "matches"), ("files", "files"), ("count", "counts")][run % 3];
            let call = crate::llm::ToolCall { id: format!("s{run}"), name: "source_search".into(), arguments: "{}".into() };
            let mut args = json!({"query":"needle","mode":mode,"limit":100});
            if mode == "matches" {
                args["before"] = json!(2);
                args["after"] = json!(2);
            }
            let result = envelope(execute(&mut ws, "source_search", args.clone(), &Default::default()));
            assert!(result["data"]["next_cursor"].is_string(), "run {run}: pages follow: {result}");
            let full = result_tokens(&call, &result, "gpt-4o");
            let mut cut = limit_result(&mut ws, &call, &args, result, full / 2);
            if run >= 3 {
                // Cut again beside the other results of its response.
                cut = bound_result(&mut ws, &call, &args, cut, full / 4);
            }
            let cursor = &cut["next_cursor"];
            assert_eq!(cursor["tool"], "history", "run {run}: {cursor}");
            let id = cursor["id"].as_u64().unwrap();
            let archive = ws.history.read(id).unwrap().messages[0]["result"].clone();
            let whole = serde_json::to_string(&context::shown_messages(&ws.history.read(id).unwrap().messages[..])).unwrap();
            let offset = cursor["offset"].as_u64().unwrap() as usize;
            // The read goes on at the first item the cut left out.
            let kept = cut["data"][field].as_array().unwrap().len();
            let next = serde_json::to_string(&model_result(&archive)["data"][field][kept]).unwrap();
            let rest: String = whole.chars().skip(offset).collect();
            assert!(rest.starts_with(&format!(",{next}")), "run {run} ({mode}, {kept} kept): the read starts at {offset} of {}: {}", whole.chars().count(), rest.chars().take(80).collect::<String>());
            // Followed as given, the reads give the rest of the archive.
            let mut args = json!({"action":"read","id":id,"offset":offset});
            let mut read = String::new();
            for _ in 0..1_000 {
                let result = envelope(execute(&mut ws, "history", args.clone(), &Default::default()));
                let result = limit_result(&mut ws, &read_call, &args, result, full / 2);
                read.push_str(result["data"]["text"].as_str().unwrap());
                if result["next_cursor"].is_null() {
                    break;
                }
                args = json!({"action":"read","id":id,"offset":result["next_cursor"]["offset"]});
            }
            assert_eq!(read, rest, "run {run}");
        }
    }

    /// Random files read at random ranges and limits, cut again at a smaller
    /// limit now and then (as a response that does not fit the context is):
    /// following the cursors gives back the requested range exactly, and
    /// no message passes its limit. FIT_FUZZ sets the number of reads.
    #[test]
    fn random_file_reads_continue_without_gaps() {
        let runs: usize = std::env::var("FIT_FUZZ").ok().and_then(|n| n.parse().ok()).unwrap_or(8);
        let mut seed: u64 = 0xf11e;
        let mut next = |n: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % n.max(1)
        };
        let pieces = ["let x = 1;", "가상계측 값", "\"quoted\"", "back\\slash", "\ttab", "😀", "{ }", "|", "    "];
        let dir = tempfile::tempdir().unwrap();
        let call = crate::llm::ToolCall { id: "call_f".into(), name: "file_read".into(), arguments: "{}".into() };
        for run in 0..runs {
            let mut body = String::new();
            for _ in 0..1 + next(3000) {
                let width = if next(50) == 0 { 2000 + next(4000) } else { next(12) };
                for _ in 0..width {
                    body.push_str(pieces[next(pieces.len())]);
                    body.push(' ');
                }
                body.push_str(if next(10) == 0 { "\r\n" } else { "\n" });
            }
            if next(3) == 0 {
                body.pop();
            }
            let name = format!("f{run}.txt");
            std::fs::write(dir.path().join(&name), &body).unwrap();
            let mut ws = workspace(dir.path());
            ws.config.result_tokens = 300 + next(30_000);
            let total = body.lines().count();
            let start = 1 + next(total);
            let mut args = json!({"path":name,"start_line":start});
            if next(2) == 0 {
                args["max_lines"] = json!(1 + next(2000));
            }
            let max_lines = args["max_lines"].as_u64().map_or(2000, |n| n as usize);
            let byte_start: usize = body.split_inclusive('\n').take(start - 1).map(str::len).sum();
            let byte_len: usize = body[byte_start..].split_inclusive('\n').take(max_lines).map(str::len).sum();
            let range = &body[byte_start..byte_start + byte_len];
            let expected = range.strip_suffix("\r\n").or_else(|| range.strip_suffix('\n')).unwrap_or(range);
            let mut shown = String::new();
            let mut request = args.clone();
            for _ in 0..10_000 {
                let budget = ws.config.result_tokens;
                let result = envelope(execute(&mut ws, "file_read", request.clone(), &Default::default()));
                assert_eq!(result["status"], "ok", "run {run}: {result}");
                let mut result = limit_result(&mut ws, &call, &request, result, budget);
                let mut limit = budget;
                if next(3) == 0 {
                    limit = 200 + next(budget);
                    result = bound_result(&mut ws, &call, &request, result, limit);
                }
                assert!(result_tokens(&call, &result, "gpt-4o") <= limit, "run {run}: {} > {limit}", result_tokens(&call, &result, "gpt-4o"));
                shown.push_str(result["data"]["content"]["text"].as_str().unwrap());
                match result["next_cursor"]["cursor"].as_str() {
                    Some(cursor) if result["next_cursor"]["tool"] == "file_read" => request = json!({"cursor":cursor}),
                    _ => break,
                }
            }
            assert!(shown == expected, "run {run}: start {start}, max_lines {max_lines}: shown {} of {} chars", shown.chars().count(), expected.chars().count());
        }
    }

    #[test]
    fn a_range_ending_in_an_empty_line_numbers_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("e.rs"), "fn a() {\n}\n\nfn b() {}\n").unwrap();
        let mut ws = workspace(dir.path());
        let result = envelope(execute(&mut ws, "file_read", json!({"path":"e.rs","max_lines":3}), &Default::default()));
        assert_eq!(result["data"]["content"]["line_end"], 3, "{result}");
        assert_eq!(result["data"]["next_line"], 4);
        let shown = model_result(&result);
        assert_eq!(shown["data"]["content"]["numbered_text"], "1|fn a() {\n2|}\n3|");
        // Cut right after a line break, the next line has not been shown.
        let whole = envelope(execute(&mut ws, "file_read", json!({"path":"e.rs"}), &Default::default()));
        assert_eq!(whole["data"]["content"]["line_end"], 4);
        assert_eq!(model_result(&whole)["data"]["content"]["numbered_text"], "1|fn a() {\n2|}\n3|\n4|fn b() {}");
    }

    #[test]
    fn a_history_search_shows_where_it_matched() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = workspace(dir.path());
        let content = format!("{}배치 BATCH007 재시작 절차{}", "앞 내용 ".repeat(300), " 뒤 내용".repeat(300));
        ws.history.push(
            vec![
                json!({"role":"assistant","content":null,"tool_calls":[{"id":"a","type":"function","function":{"name":"knowledge_read","arguments":"{\"id\":\"k1\"}"}}]}),
                json!({"role":"tool","tool_call_id":"a","content":content}),
            ],
            true,
        );
        ws.history.bundles[0].active = false;
        let found = envelope(execute(&mut ws, "history", json!({"action":"search","query":"batch007"}), &Default::default()));
        let excerpt = found["data"]["items"][0]["excerpt"].as_str().unwrap();
        assert!(excerpt.contains("BATCH007"), "{excerpt}");
        assert!(excerpt.chars().count() <= 260, "{}", excerpt.chars().count());
    }

    /// Context management review, seventh pass: the history tool said it
    /// searched "earlier tool results", but the oldest bundles, which leave
    /// the context first, are earlier questions and answers, and it finds
    /// them too: a follow-up whose antecedent had left had no reason to look
    /// for it there.
    #[test]
    fn the_history_tool_says_it_finds_earlier_questions_and_answers() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = workspace(dir.path());
        ws.history.push(vec![json!({"role":"user","content":"BATCH007 상태 알려줘"})], true);
        ws.history.push(vec![json!({"role":"assistant","content":"BATCH007은 실패 상태입니다."})], true);
        for bundle in ws.history.bundles.iter_mut() {
            bundle.active = false;
        }
        let found = envelope(execute(&mut ws, "history", json!({"action":"search","query":"batch007"}), &Default::default()));
        assert_eq!(found["data"]["items"].as_array().unwrap().len(), 2, "{found}");
        let spec = ToolRegistry::source_specs().into_iter().find(|s| s.name == "history").unwrap();
        for what in ["questions", "answers", "tool results", "left"] {
            assert!(spec.description.contains(what), "{what}: {}", spec.description);
        }
    }

    #[test]
    fn history_finds_and_shows_quoted_text_as_written() {
        // A tool result is JSON inside a message: searched and read as a
        // string escaped once more, quotes and backslashes never matched.
        let dir = tempfile::tempdir().unwrap();
        let mut ws = workspace(dir.path());
        let result = envelope(Ok(json!({"text":"let model = config[\"llm\"][\"model\"];\nlet home = \"C:\\app\";"})));
        ws.history.push(
            vec![
                json!({"role":"assistant","content":null,"tool_calls":[{"id":"a","type":"function","function":{"name":"search","arguments":json!({"query":"모델 \"설정\""}).to_string()}}]}),
                json!({"role":"tool","tool_call_id":"a","content":result.to_string()}),
            ],
            true,
        );
        ws.history.bundles[0].active = false;
        for query in ["config[\"llm\"]", "C:\\app", "모델 \"설정\"", r#"config[\"llm\"]"#] {
            let found = envelope(execute(&mut ws, "history", json!({"action":"search","query":query}), &Default::default()));
            assert_eq!(found["data"]["items"].as_array().unwrap().len(), 1, "{query}: {found}");
            let excerpt = found["data"]["items"][0]["excerpt"].as_str().unwrap();
            assert!(excerpt.contains("config") || excerpt.contains("설정"), "{query}: {excerpt}");
        }
        // A read shows the result as the JSON the model was given.
        let read = envelope(execute(&mut ws, "history", json!({"action":"read","id":1}), &Default::default()));
        let text = read["data"]["text"].as_str().unwrap();
        assert!(text.contains(r#"config[\"llm\"]"#) && !text.contains(r#"\\\"llm"#), "{text}");
    }

    #[test]
    fn an_archived_result_shows_its_start() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = workspace(dir.path());
        let call = crate::llm::ToolCall { id: "s1".into(), name: "search".into(), arguments: "{}".into() };
        let data = json!({"text":"q","results":{"knowledge":{"status":"ok","note":"근거 문장 ".repeat(800)}}});
        let bounded = bound_result(&mut ws, &call, &json!({}), envelope(Ok(data)), 600);
        assert_eq!(bounded["next_cursor"]["tool"], "history", "{bounded}");
        let preview = bounded["data"]["preview"].as_str().unwrap();
        assert!(preview.starts_with("{\"text\":\"q\""), "{preview}");
        assert!(preview.len() > 200, "{preview}");
        assert!(result_tokens(&call, &bounded, "gpt-4o") <= 600);
        // Cut again (a response that does not fit the context), it keeps the
        // same archive and still shows the result's start, not the stub's.
        let again = bound_result(&mut ws, &call, &json!({}), bounded.clone(), 300);
        assert_eq!(again["next_cursor"], bounded["next_cursor"]);
        let shorter = again["data"]["preview"].as_str().unwrap();
        assert!(preview.starts_with(shorter) && shorter.len() < preview.len(), "{shorter}");
        assert!(result_tokens(&call, &again, "gpt-4o") <= 300);
    }

    #[test]
    fn a_cut_result_keeps_no_continuation_past_what_it_shows() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = workspace(dir.path());
        // A knowledge read cut inside its text no longer claims the end or
        // a cursor past the cut; the archive continues it.
        let call = crate::llm::ToolCall { id: "k".into(), name: "knowledge_read".into(), arguments: "{}".into() };
        let read = json!({"id":"k1","title":"t","chunk_of":3,"chunks":"1-3","text":"근거 문장 ".repeat(800),"complete_to_end":true});
        let cut = bound_result(&mut ws, &call, &json!({"id":"k1"}), envelope(Ok(read)), 600);
        assert!(cut["data"]["text"].as_str().unwrap().len() < 4000, "{cut}");
        assert!(cut["data"].get("complete_to_end").is_none() && cut["data"].get("next_cursor").is_none(), "{cut}");
        assert_eq!(cut["next_cursor"]["tool"], "history");
        let call = crate::llm::ToolCall { id: "k".into(), name: "knowledge_read".into(), arguments: "{}".into() };
        let read = json!({"id":"k1","title":"t","chunk_of":9,"chunks":"1-3","text":"근거 문장 ".repeat(800),"next_cursor":"k1:4"});
        let cut = bound_result(&mut ws, &call, &json!({"id":"k1"}), envelope(Ok(read)), 600);
        assert!(cut["data"].get("next_cursor").is_none(), "{cut}");
        // Rows read from an offset continue right after the rows shown.
        let call = crate::llm::ToolCall { id: "r".into(), name: "result_read".into(), arguments: "{}".into() };
        let rows: Vec<Value> = (0..200).map(|i| json!({"ID":i,"NOTE":"값 ".repeat(20)})).collect();
        let read = json!({"step":1,"query_name":"q","total_rows":500,"capped":false,"offset":100,"columns":["ID","NOTE"],"rows":rows,"next_offset":300});
        let cut = bound_result(&mut ws, &call, &json!({"step":1,"offset":100}), envelope(Ok(read)), 1500);
        let shown = cut["data"]["rows"].as_array().unwrap().len() as u64;
        assert!(shown > 0 && shown < 200, "{shown}");
        assert_eq!(cut["data"]["next_offset"], 100 + shown);
        // The last page had no next offset; cut, it has one.
        let rows: Vec<Value> = (0..100).map(|i| json!({"ID":i,"NOTE":"값 ".repeat(20)})).collect();
        let read = json!({"step":1,"query_name":"q","total_rows":500,"capped":false,"offset":400,"columns":["ID","NOTE"],"rows":rows,"next_offset":null});
        let cut = bound_result(&mut ws, &call, &json!({"step":1,"offset":400}), envelope(Ok(read)), 1500);
        let shown = cut["data"]["rows"].as_array().unwrap().len() as u64;
        assert!(shown > 0 && shown < 100, "{shown}");
        assert_eq!(cut["data"]["next_offset"], 400 + shown);
    }

    /// Backend review (leaks, panics, deadlocks), fourth pass: an MCP tool
    /// (or the search) called with an `offset` near the largest number had
    /// its cut text's offset added past it, a panic in a debug build — on
    /// the async runtime, with the conversation's history moved out for the
    /// batch, so the conversation lost it.
    #[test]
    fn an_offset_argument_past_any_text_cuts_the_result_all_the_same() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = workspace(dir.path());
        let call = crate::llm::ToolCall { id: "m".into(), name: "exa__web_fetch_exa".into(), arguments: "{}".into() };
        let fetched = json!({"text":"가져온 문장 ".repeat(2_000)});
        let cut = bound_result(&mut ws, &call, &json!({"url":"https://example.com","offset":u64::MAX}), envelope(Ok(fetched)), 300);
        assert_eq!(cut["truncated"], true, "{cut}");
        assert!(result_tokens(&call, &cut, "gpt-4o") <= 300, "{cut}");
    }

    #[test]
    fn normalization_repairs_provider_quirks_and_clamps_sizes() {
        let mut args = json!({"path":"","query":"x","limit":"500","case_sensitive":"false","tool":"source_search"});
        let adjusted = normalize_arguments("source_search", &mut args);
        assert_eq!(args, json!({"query":"x","limit":100,"case_sensitive":false}));
        assert_eq!(adjusted.len(), 1);
    }

    /// Tool review, 2026-10-21 (third pass): a whole number sent as a float
    /// and a blank optional choice, number, flag or knowledge id were
    /// refused, each costing the request a resend.
    #[test]
    fn whole_floats_and_blank_optional_fields_are_repaired() {
        let repaired = |name: &str, mut args: Value| {
            normalize_arguments(name, &mut args);
            ToolRegistry::validate(name, &args).map(|_| args).map_err(|e| e.to_string())
        };
        assert_eq!(
            repaired("file_read", json!({"path":"a.rs","start_line":10.0,"max_lines":50.0})),
            Ok(json!({"path":"a.rs","start_line":10,"max_lines":50}))
        );
        assert_eq!(repaired("result_read", json!({"step":2.0})), Ok(json!({"step":2})));
        // A fraction is no integer, and stays refused.
        assert!(repaired("query_run", json!({"query_name":"q","preview_rows":20.5})).is_err());
        assert!(repaired("file_read", json!({"path":"a.rs","start_line":-3.0})).unwrap_err().contains("minimum=1"));
        // Bind values are numbers of any kind, as sent.
        assert_eq!(repaired("query_run", json!({"query_name":"q","params":{"a":1.5}})).unwrap()["params"]["a"], 1.5);
        assert_eq!(repaired("file_list", json!({"path":"","mode":"","limit":""})), Ok(json!({})));
        // A plain text field keeps it.
        assert_eq!(repaired("source_search", json!({"query":"","path":""})), Ok(json!({"query":""})));
        assert_eq!(
            repaired("source_search", json!({"query":"x","mode":"","before":"","regex":"","path_glob":""})),
            Ok(json!({"query":"x"}))
        );
        assert_eq!(repaired("search", json!({"query":"x","targets":""})), Ok(json!({"query":"x"})));
        assert_eq!(repaired("knowledge_read", json!({"id":"","cursor":"k3:2"})), Ok(json!({"cursor":"k3:2"})));
        // A required field keeps what was sent, and its error says so.
        assert!(repaired("search", json!({"query":""})).is_ok());
        assert!(repaired("history", json!({"action":""})).unwrap_err().contains("action"));
    }

    #[test]
    fn a_tool_that_does_not_exist_is_told_the_offered_one_it_meant() {
        let offered: Vec<String> = ["search", "knowledge_read", "query_run", "result_read", "file_read"].map(String::from).to_vec();
        assert!(unknown_tool("run_query", &offered).ends_with("did you mean query_run? send the same arguments to query_run if they match its parameters"));
        // Here a result is a query's rows, not a file.
        assert!(unknown_tool("read_result", &offered).contains("did you mean result_read?"));
        assert!(unknown_tool("expand", &offered).contains("did you mean knowledge_read?"));
        assert_eq!(unknown_tool("zebra", &offered), "unsupported_tool: zebra does not exist");
    }

    #[test]
    fn paths_are_shown_relative_to_the_root() {
        let mut value = json!({"data":{"path":"/w/app/src/a.rs","matches":[{"path":"/w/app/b.rs"},{"path":"/w/other.md"}]}});
        relativize_paths(&mut value, Path::new("/w/app"));
        assert_eq!(value["data"]["path"], "src/a.rs");
        assert_eq!(value["data"]["matches"][0]["path"], "b.rs");
        assert_eq!(value["data"]["matches"][1]["path"], "/w/other.md");
    }
}
