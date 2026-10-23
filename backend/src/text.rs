//! Text rules shared by every boundary. The frontend counts lengths in
//! UTF-16 code units (JavaScript `length`), and the stored chunk hashes were
//! computed with that unit, so lengths that cross the HTTP boundary or feed a
//! stored hash are measured in UTF-16 here as well.

/// Marks a value that was shortened. Bind values ending with it are refused:
/// a clipped copy is not the stored value.
pub const TRUNC_MARK: &str = "…(생략)";

pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// The longest prefix of at most `max` UTF-16 units that does not split a
/// surrogate pair (JavaScript `clipText`).
pub fn clip_utf16(s: &str, max: usize) -> &str {
    let mut units = 0usize;
    for (at, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..at];
        }
    }
    s
}

/// `clip_utf16` with the truncation mark when anything was cut.
pub fn clip_marked(s: &str, max: usize) -> String {
    if utf16_len(s) <= max {
        s.to_owned()
    } else {
        format!("{}{TRUNC_MARK}", clip_utf16(s, max))
    }
}

/// Characters JavaScript `String.prototype.trim` removes.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// Comparison key of names (query, target DB, column): surrounding spaces and
/// case are ignored.
pub fn name_key(s: &str) -> String {
    js_trim(s).to_lowercase()
}

/// Byte position of the first place `name` is written in `text`, compared by
/// `name_key`. Lowercasing the whole body first would change characters whose
/// case mapping depends on neighbours (final sigma), so every candidate span is
/// checked again with `name_key`. A name is written where it stands apart:
/// an end of it that is a letter, digit or `_` has none of those beside it,
/// so `batch_job` is not written in `batch_job_status` (a method naming that
/// query listed `batch_job` too, and deleting `batch_job` was refused as in
/// use), while a Korean particle may follow (`find_customer_id를`).
pub fn name_index_of(text: &str, name: &str) -> Option<usize> {
    NameSearch::new(text).index_of(name)
}

/// Lowercased per character, final sigma read as sigma: this keeps every span
/// `name_key` takes, so a name whose folding is not in the folded text is not
/// written in it.
fn folded(s: &str) -> String {
    s.chars().flat_map(char::to_lowercase).map(|c| if c == 'ς' { 'σ' } else { c }).collect()
}

/// A text to find many names in (`name_index_of` for each), folded once:
/// folding the text again for each of thousands of registered names cost
/// more than finding them.
pub struct NameSearch<'a> {
    text: &'a str,
    folded: String,
}

impl<'a> NameSearch<'a> {
    pub fn new(text: &'a str) -> Self {
        Self { text, folded: folded(text) }
    }
    pub fn index_of(&self, name: &str) -> Option<usize> {
        let text = self.text;
        let key = name_key(name);
        if key.is_empty() {
            return None;
        }
        // Most names are not in the text: told before a pattern is built.
        // Building one for each of a thousand registered names took 0.15 s a
        // method.
        if !self.folded.contains(&folded(&key)) {
            return None;
        }
        let pattern = regex::RegexBuilder::new(&regex::escape(&key))
            .case_insensitive(true)
            .unicode(true)
            .build()
            .ok()?;
        let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
        let starts_word = key.chars().next().is_some_and(word);
        let ends_word = key.chars().next_back().is_some_and(word);
        let mut start = 0;
        while start <= text.len() {
            let found = pattern.find_at(text, start)?;
            let joined_before = starts_word && text[..found.start()].chars().next_back().is_some_and(word);
            let joined_after = ends_word && text[found.end()..].chars().next().is_some_and(word);
            if name_key(found.as_str()) == key && !joined_before && !joined_after {
                return Some(found.start());
            }
            // Advance one character past the candidate's start.
            start = found.start() + text[found.start()..].chars().next().map_or(1, char::len_utf8);
        }
        None
    }
}

/// Many names to find in texts (`NameSearch::index_of` for each), looked for
/// together: asked of each name in turn, a text was read once a name — a
/// method_read of ten methods over 5,000 registered queries read them 50,000
/// times (20–40 ms). One pass over the folded text tells the names whose
/// folding is in it, the check `index_of` starts with; only those are
/// looked for as it does.
pub struct NameFinder<'a> {
    names: &'a [String],
    /// Each folded key once, with the names that fold to it.
    /// None when the automaton could not be built: every name is checked.
    keys: Option<aho_corasick::AhoCorasick>,
    holders: Vec<Vec<usize>>,
}

impl<'a> NameFinder<'a> {
    pub fn new(names: &'a [String]) -> Self {
        let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        let mut patterns: Vec<String> = vec![];
        let mut holders: Vec<Vec<usize>> = vec![];
        for (i, name) in names.iter().enumerate() {
            let key = name_key(name);
            if key.is_empty() {
                continue;
            }
            let at = *index.entry(folded(&key)).or_insert_with_key(|pattern| {
                patterns.push(pattern.clone());
                holders.push(vec![]);
                patterns.len() - 1
            });
            holders[at].push(i);
        }
        let keys = aho_corasick::AhoCorasick::new(&patterns).ok();
        Self { names, keys, holders }
    }

    /// Each name written in `text` as `index_of` finds it: (byte position,
    /// index in the names), in the names' order.
    pub fn find_in(&self, text: &str) -> Vec<(usize, usize)> {
        let search = NameSearch::new(text);
        let mut present: Vec<usize> = match &self.keys {
            Some(keys) => keys
                .find_overlapping_iter(&search.folded)
                .flat_map(|found| self.holders[found.pattern().as_usize()].iter().copied())
                .collect(),
            None => (0..self.names.len()).collect(),
        };
        present.sort_unstable();
        present.dedup();
        present.into_iter().filter_map(|i| search.index_of(&self.names[i]).map(|at| (at, i))).collect()
    }
}

/// `;`-separated target DB names, trimmed and deduplicated by `name_key`,
/// keeping the first spelling.
pub fn target_db_names(raw: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut names = Vec::new();
    for part in raw.split(';') {
        let name = js_trim(part);
        let key = name_key(name);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        names.push(name.to_owned());
    }
    names
}

/// A JSON text with lone surrogate escapes (`\ud800` without its pair, or a
/// lone low surrogate) removed. serde_json rejects them while browsers and the
/// former Node server accepted them; a client that cut an emoji in half must
/// not lose its whole request.
pub fn strip_lone_surrogate_escapes(json: &str) -> std::borrow::Cow<'_, str> {
    if !json.contains("\\u") && !json.contains("\\U") {
        return std::borrow::Cow::Borrowed(json);
    }
    let bytes = json.as_bytes();
    let hex4 = |at: usize| -> Option<u16> {
        let digits = json.get(at..at + 4)?;
        u16::from_str_radix(digits, 16).ok()
    };
    let escape_at = |at: usize| -> Option<u16> {
        (bytes.get(at) == Some(&b'\\') && bytes.get(at + 1) == Some(&b'u'))
            .then(|| hex4(at + 2))
            .flatten()
    };
    let mut out = String::with_capacity(json.len());
    let mut in_string = false;
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if !in_string {
            if b == b'"' {
                in_string = true;
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => {
                in_string = false;
                i += 1;
            }
            b'\\' => {
                if let Some(unit) = escape_at(i) {
                    let high = (0xd800..=0xdbff).contains(&unit);
                    let low = (0xdc00..=0xdfff).contains(&unit);
                    if high {
                        if escape_at(i + 6).is_some_and(|next| (0xdc00..=0xdfff).contains(&next)) {
                            i += 12;
                        } else {
                            out.push_str(&json[copied..i]);
                            i += 6;
                            copied = i;
                        }
                    } else if low {
                        out.push_str(&json[copied..i]);
                        i += 6;
                        copied = i;
                    } else {
                        i += 6;
                    }
                } else {
                    i += 2;
                }
            }
            _ => i += 1,
        }
    }
    if copied == 0 {
        return std::borrow::Cow::Borrowed(json);
    }
    out.push_str(&json[copied.min(json.len())..]);
    std::borrow::Cow::Owned(out)
}

/// An `ENV:NAME` password reference: the variable name and whether it is a
/// valid name. The admin save path and the Oracle executor read it alike, so
/// a malformed reference never becomes a password.
pub fn password_env_reference(value: &str) -> Option<(String, bool)> {
    let trimmed = value.trim_start();
    let prefix = trimmed.get(..4)?;
    if !prefix.eq_ignore_ascii_case("env:") {
        return None;
    }
    let name = trimmed[4..].trim().to_owned();
    let valid = regex::Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap().is_match(&name);
    Some((name, valid))
}

/// Whether an `ENV:` reference names one of the backend's own secrets as
/// `.env` holds them (`Config::import_env`). `.env` is loaded into the
/// environment a reference reads, so such a reference sent the backend's
/// key or password to the target DB or MCP server it was entered for, which
/// the MCP children's environment withholds on purpose.
pub fn backend_secret(name: &str) -> bool {
    ["LLM_API_KEY", "MARIADB_PASSWORD", "ADMIN_TOKEN"].iter().any(|own| own.eq_ignore_ascii_case(name))
}

/// Normalizes a question as the former server did: surrounding JavaScript
/// whitespace removed.
pub fn normalize_question(raw: &str) -> String {
    js_trim(raw).to_owned()
}

/// One line: every line break becomes a space.
pub fn single_line(s: &str) -> String {
    s.replace("\r\n", " ").replace(['\r', '\n'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_lengths_and_clipping_follow_javascript() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(clip_utf16("a😀b", 2), "a");
        assert_eq!(clip_utf16("a😀b", 3), "a😀");
        assert_eq!(clip_utf16("abc", 0), "");
        assert_eq!(clip_marked("abcdef", 3), format!("abc{TRUNC_MARK}"));
        assert_eq!(clip_marked("abc", 3), "abc");
    }

    #[test]
    fn trim_matches_javascript_whitespace() {
        assert_eq!(js_trim("\u{3000} x \u{feff}"), "x");
        assert_eq!(name_key("  Order_DB "), "order_db");
    }

    #[test]
    fn names_are_found_case_insensitively() {
        assert_eq!(name_index_of("먼저 Find_Customer_ID를 실행", "find_customer_id"), Some(7));
        assert_eq!(name_index_of("nothing here", "find"), None);
        assert_eq!(name_index_of("x", "  "), None);
    }

    #[test]
    fn a_name_inside_a_longer_name_is_not_written_there() {
        let method = "1. batch_job_status로 상태를 본다. 2. 실패면 batch_job 재실행을 안내한다.";
        assert_eq!(name_index_of(method, "batch_job_status"), Some(3));
        // Found where it stands alone, past the longer name holding it.
        assert_eq!(name_index_of(method, "batch_job"), method.find("batch_job 재"));
        assert_eq!(name_index_of("batch_job_status만 본다", "batch_job"), None);
        assert_eq!(name_index_of("old_batch_job", "batch_job"), None);
        assert_eq!(name_index_of("query10", "query1"), None);
        // Punctuation, spaces and Korean are not part of a name.
        assert_eq!(name_index_of("`batch_job`(재실행)", "batch_job"), Some(1));
        assert_eq!(name_index_of("주문조회하기", "주문조회"), Some(0));
    }

    #[test]
    fn many_names_are_found_as_each_is_alone() {
        let names: Vec<String> = [
            "batch_job", "batch_job_status", "Batch_Job", "query1", "query10", "주문조회", "find customer", "ΟΔΟΣ", "οδοσ",
            "  ", "", "İstanbul", "x", "ab", "b", "q_ς",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain((0..200).map(|i| format!("zz_query_{i}_list")))
        .collect();
        let texts = [
            "1. batch_job_status로 상태를 본다. 2. 실패면 BATCH_JOB 재실행을 안내한다.",
            "query10 then query1, 주문조회하기 and FIND CUSTOMER 다음 ΟΔΟΣ와 i̇stanbul",
            "zz_query_7_list 로 조회하고 zz_query_17_list, zz_query_170_list 도 본다 q_σ abab xb",
            "",
            "아무 이름도 없다",
        ];
        let finder = NameFinder::new(&names);
        for text in texts {
            let search = NameSearch::new(text);
            let each: Vec<(usize, usize)> =
                names.iter().enumerate().filter_map(|(i, name)| search.index_of(name).map(|at| (at, i))).collect();
            assert_eq!(finder.find_in(text), each, "{text}");
        }
        assert!(!finder.find_in(texts[2]).is_empty());
    }

    #[test]
    fn target_db_names_dedupe_by_key() {
        assert_eq!(target_db_names(" A ; a;B;; "), vec!["A", "B"]);
    }

    #[test]
    fn lone_surrogate_escapes_are_removed() {
        let raw = r#"{"message":"\ud83d 재시작","ok":"😀","low":"\udc00x","esc":"\\ud800"}"#;
        let cleaned = strip_lone_surrogate_escapes(raw);
        let value: serde_json::Value = serde_json::from_str(&cleaned).unwrap();
        assert_eq!(value["message"], " 재시작");
        assert_eq!(value["ok"], "😀");
        assert_eq!(value["low"], "x");
        assert_eq!(value["esc"], "\\ud800");
    }
}
