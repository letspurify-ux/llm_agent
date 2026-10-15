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
/// checked again with `name_key`.
pub fn name_index_of(text: &str, name: &str) -> Option<usize> {
    let key = name_key(name);
    if key.is_empty() {
        return None;
    }
    let pattern = regex::RegexBuilder::new(&regex::escape(&key))
        .case_insensitive(true)
        .unicode(true)
        .build()
        .ok()?;
    let mut start = 0;
    while start <= text.len() {
        let found = pattern.find_at(text, start)?;
        if name_key(found.as_str()) == key {
            return Some(found.start());
        }
        // Advance one character past the candidate's start.
        start = found.start() + text[found.start()..].chars().next().map_or(1, char::len_utf8);
    }
    None
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
