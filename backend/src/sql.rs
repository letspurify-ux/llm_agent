//! SQL lexing for registered queries: bind names and the read-only guard.
//! A single-pass scanner (not regular expressions) blanks string literals,
//! q-quotes with any delimiter, quoted identifiers and comments, keeping
//! every position, so the guard and bind extraction judge only code.

use crate::text::{TRUNC_MARK, name_key};
use regex::Regex;
use std::sync::LazyLock;

/// Longest bind name: an Oracle identifier (12.2+).
pub const MAX_BIND_NAME_LEN: usize = 128;

/// A refusal written for the user (safe to show) with optional guidance
/// for the model only, and whether no parameter value could ever make the
/// call run (a wasted step).
#[derive(Debug, Clone)]
pub struct SafeError {
    pub message: String,
    pub hint: Option<String>,
    pub wasted: bool,
}
impl std::fmt::Display for SafeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for SafeError {}
pub fn safe(message: impl Into<String>) -> anyhow::Error {
    SafeError {
        message: message.into(),
        hint: None,
        wasted: false,
    }
    .into()
}
pub fn safe_hint(message: impl Into<String>, hint: impl Into<String>) -> anyhow::Error {
    SafeError {
        message: message.into(),
        hint: Some(hint.into()),
        wasted: false,
    }
    .into()
}
/// A refusal no parameter value can fix.
pub fn wasted(message: impl Into<String>, hint: impl Into<String>) -> anyhow::Error {
    SafeError {
        message: message.into(),
        hint: Some(hint.into()),
        wasted: true,
    }
    .into()
}

fn is_ident_char(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '#'))
}

/// The SQL with literals and comments replaced by spaces of the same
/// length (in characters), and whether a literal or comment never ends.
pub fn scan(sql: &str) -> (Vec<char>, bool) {
    let s: Vec<char> = sql.chars().collect();
    let mut out: Vec<char> = Vec::with_capacity(s.len());
    let mut i = 0;
    let mut unterminated = false;
    let find = |from: usize, pattern: &[char]| -> Option<usize> {
        (from..s.len()).find(|&at| s[at..].starts_with(pattern))
    };
    while i < s.len() {
        let c = s[i];
        let next = s.get(i + 1).copied();
        let skip_to = |end: usize, out: &mut Vec<char>| {
            out.extend(std::iter::repeat_n(' ', end - i));
            end
        };
        if c == '-' && next == Some('-') {
            let end = find(i, &['\n']).unwrap_or(s.len());
            i = skip_to(end, &mut out);
            continue;
        }
        if c == '/' && next == Some('*') {
            match find(i + 2, &['*', '/']) {
                Some(end) => i = skip_to(end + 2, &mut out),
                None => {
                    unterminated = true;
                    i = skip_to(s.len(), &mut out);
                }
            }
            continue;
        }
        if (c == 'q' || c == 'Q') && next == Some('\'') && is_quote_start(&s, i) {
            let Some(delimiter) = s.get(i + 2).copied() else {
                unterminated = true;
                i = skip_to(s.len(), &mut out);
                continue;
            };
            let closer = match delimiter {
                '[' => ']',
                '{' => '}',
                '(' => ')',
                '<' => '>',
                other => other,
            };
            match find(i + 3, &[closer, '\'']) {
                Some(end) => i = skip_to(end + 2, &mut out),
                None => {
                    unterminated = true;
                    i = skip_to(s.len(), &mut out);
                }
            }
            continue;
        }
        if c == '"' {
            match find(i + 1, &['"']) {
                Some(end) => i = skip_to(end + 1, &mut out),
                None => {
                    unterminated = true;
                    i = skip_to(s.len(), &mut out);
                }
            }
            continue;
        }
        if c == '\'' {
            let mut j = i + 1;
            while j < s.len() {
                if s[j] != '\'' {
                    j += 1;
                    continue;
                }
                if s.get(j + 1) == Some(&'\'') {
                    j += 2;
                    continue;
                }
                break;
            }
            if j >= s.len() {
                unterminated = true;
                i = skip_to(s.len(), &mut out);
            } else {
                i = skip_to(j + 1, &mut out);
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    (out, unterminated)
}

/// q'…' starts a q-quote only when the q is not part of an identifier
/// (`freq'x'` is not one); nq'…' is a national q-quote.
fn is_quote_start(s: &[char], i: usize) -> bool {
    let prev = i.checked_sub(1).map(|at| s[at]);
    if matches!(prev, Some('n' | 'N')) {
        !is_ident_char(i.checked_sub(2).map(|at| s[at]))
    } else {
        !is_ident_char(prev)
    }
}

static BIND: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":([A-Za-z0-9_$#]+)").unwrap());

fn is_executable_bind(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && name.chars().count() <= MAX_BIND_NAME_LEN
}

fn candidates(code: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    BIND.captures_iter(code)
        .map(|c| c[1].to_owned())
        .filter(|name| seen.insert(name.clone()))
        .collect()
}

/// Bind names the executor can bind, once each by Oracle's case-insensitive
/// rule, in order of first use.
pub fn bind_names(sql: &str) -> Vec<String> {
    let (text, _) = scan(sql);
    let code: String = text.into_iter().collect();
    let mut seen = std::collections::BTreeSet::new();
    candidates(&code)
        .into_iter()
        .filter(|n| is_executable_bind(n))
        .filter(|n| seen.insert(name_key(n)))
        .collect()
}

static STARTS_READ: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(SELECT|WITH)\b").unwrap());
static FOR_UPDATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bFOR\s+UPDATE\b").unwrap());

/// Accepts a single SELECT or WITH statement and returns the SQL to run
/// (a trailing `;` removed, since Oracle 19c and older reject it).
pub fn assert_read_only(sql: &str) -> anyhow::Result<String> {
    let (text, unterminated) = scan(sql);
    if unterminated {
        return Err(safe("닫히지 않은 문자열 리터럴 또는 주석이 있어 실행할 수 없습니다."));
    }
    let code: String = text.iter().collect();
    let trimmed = code.trim();
    let opening = trimmed.trim_start_matches(|c: char| c == '(' || c.is_whitespace());
    if !STARTS_READ.is_match(opening) {
        return Err(safe("조회(SELECT) 쿼리만 실행할 수 있습니다."));
    }
    if trimmed.strip_suffix(';').unwrap_or(trimmed).contains(';') {
        return Err(safe("다중 문장 쿼리는 실행할 수 없습니다."));
    }
    if FOR_UPDATE.is_match(trimmed) {
        return Err(safe("행 잠금을 거는 쿼리(FOR UPDATE)는 실행할 수 없습니다."));
    }
    let unsupported: Vec<String> = candidates(&code)
        .into_iter()
        .filter(|n| !is_executable_bind(n))
        .collect();
    if !unsupported.is_empty() {
        let shown = unsupported
            .iter()
            .map(|n| {
                if n.chars().count() > MAX_BIND_NAME_LEN {
                    format!(":{}{TRUNC_MARK}", n.chars().take(MAX_BIND_NAME_LEN).collect::<String>())
                } else {
                    format!(":{n}")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
        return Err(safe(format!(
            "실행할 수 없는 바인드 표기입니다: {shown} — 바인드명은 영문자로 시작하고 {MAX_BIND_NAME_LEN}자 이하여야 합니다 (위치 바인드 :1은 지원하지 않습니다)."
        )));
    }
    Ok(executable_sql(sql, &text))
}

/// The registered SQL with the guard-approved trailing semicolon replaced by
/// a space. Positions come from the scan, so a semicolon inside a literal
/// or followed by a comment is judged right.
fn executable_sql(raw: &str, text: &[char]) -> String {
    let end = text.iter().rposition(|c| !c.is_whitespace());
    match end {
        Some(last) if text[last] == ';' => {
            let mut chars: Vec<char> = raw.chars().collect();
            chars[last] = ' ';
            chars.into_iter().collect()
        }
        _ => raw.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(sql: &str) -> String {
        assert_read_only(sql).unwrap_err().to_string()
    }

    #[test]
    fn literals_and_comments_are_not_code() {
        assert_eq!(bind_names("SELECT ':x' a, :Job_Id FROM t WHERE b = :job_id -- :c\n/* :d */"), vec!["Job_Id"]);
        assert_eq!(bind_names("SELECT q'!:a;!' FROM t WHERE x = :b"), vec!["b"]);
        assert_eq!(bind_names("SELECT q'[a]' || freq FROM t WHERE x = :emp$no"), vec!["emp$no"]);
        assert_eq!(bind_names("SELECT \"it's\" FROM t WHERE x = :tab#id"), vec!["tab#id"]);
        assert_eq!(bind_names("SELECT nq'(x)' FROM t WHERE y = :v"), vec!["v"]);
    }

    #[test]
    fn the_guard_accepts_single_reads_only() {
        assert_eq!(assert_read_only("SELECT 1 FROM DUAL;").unwrap(), "SELECT 1 FROM DUAL ");
        assert_eq!(assert_read_only("SELECT 1 FROM DUAL; -- note").unwrap(), "SELECT 1 FROM DUAL  -- note");
        assert!(assert_read_only("(SELECT 1 FROM DUAL) FETCH FIRST 1 ROWS ONLY").is_ok());
        assert!(assert_read_only("WITH a AS (SELECT 1 x FROM dual) SELECT * FROM a").is_ok());
        assert!(assert_read_only("SELECT LISTAGG(name, '; ') FROM t").is_ok());
        assert!(refused("DELETE FROM t").contains("조회(SELECT)"));
        assert!(refused("SELECT 1 FROM t; DELETE FROM t").contains("다중 문장"));
        assert!(refused("SELECT * FROM t FOR UPDATE NOWAIT").contains("FOR UPDATE"));
        assert!(refused("SELECT * FROM t WHERE a = 'x").contains("닫히지 않은"));
        assert!(refused("SELECT * FROM t WHERE a = :1").contains(":1"));
        assert!(refused("SELECT 1 FROM t /* open").contains("닫히지 않은"));
        // A `;` inside a literal is not a statement separator.
        assert!(assert_read_only("SELECT ';' FROM dual").is_ok());
        // Long bind names are refused with the name clipped.
        let long = format!("SELECT * FROM t WHERE a = :a{}", "b".repeat(200));
        assert!(refused(&long).contains(TRUNC_MARK));
    }
}
