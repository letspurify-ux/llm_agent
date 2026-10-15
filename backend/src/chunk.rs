//! Knowledge documents are stored in overlapping chunks (knowledge_chunk) so
//! each can be embedded and read on its own. The split rule is the one the
//! stored rows were made with: lengths in UTF-16 units, cuts preferring a
//! blank line, then a Markdown heading, then a sentence end. A document is
//! split again only when its `doc_hash` (which includes `CHUNK_RULE`)
//! changes, so the rule must match exactly (tests/fixtures/chunk.json was
//! produced by the former implementation).

pub const CHUNK_TARGET_LEN: usize = 900;
pub const CHUNK_MAX_LEN: usize = 1000;
pub const CHUNK_OVERLAP: usize = 150;
pub const CHUNK_SPLIT_VERSION: u32 = 4;
pub const CHUNK_RULE: &str = "chunk:900:1000:150:v4";
const MIN_SEAM: usize = 32;

fn is_high(c: Option<&u16>) -> bool {
    c.is_some_and(|c| (0xd800..=0xdbff).contains(c))
}
fn is_low(c: Option<&u16>) -> bool {
    c.is_some_and(|c| (0xdc00..=0xdfff).contains(c))
}
/// Moves a cut off the middle of a surrogate pair.
fn align_cut(s: &[u16], i: usize) -> usize {
    if i > 0 && i < s.len() && is_low(s.get(i)) && is_high(s.get(i - 1)) {
        i - 1
    } else {
        i
    }
}

const NL: u16 = b'\n' as u16;
const fn is(c: u16, set: &[u8]) -> bool {
    let mut i = 0;
    while i < set.len() {
        if c == set[i] as u16 {
            return true;
        }
        i += 1;
    }
    false
}

/// Cut positions of one boundary kind, scanning from the start with
/// non-overlapping matches as a global regular expression does.
fn cuts(s: &[u16], kind: usize, mut visit: impl FnMut(usize) -> bool) {
    let mut i = 0;
    while i < s.len() {
        let matched = match kind {
            // \n[ \t\r]*\n — cut after it.
            0 if s[i] == NL => {
                let mut j = i + 1;
                while j < s.len() && is(s[j], b" \t\r") {
                    j += 1;
                }
                (j < s.len() && s[j] == NL).then_some((j + 1, j + 1))
            }
            // \n#{1,6}[ \t] — cut before it.
            1 if s[i] == NL => {
                let mut j = i + 1;
                while j < s.len() && s[j] == b'#' as u16 {
                    j += 1;
                }
                let hashes = j - i - 1;
                ((1..=6).contains(&hashes) && j < s.len() && is(s[j], b" \t"))
                    .then_some((i, j + 1))
            }
            // [.!?][ \t\r\n] — cut after it.
            2 if is(s[i], b".!?") => {
                (i + 1 < s.len() && is(s[i + 1], b" \t\r\n")).then_some((i + 2, i + 2))
            }
            _ => None,
        };
        match matched {
            Some((cut, end)) => {
                if !visit(cut) {
                    return;
                }
                i = end;
            }
            None => i += 1,
        }
    }
}

fn last_boundary(s: &[u16], lo: usize, hi: usize) -> Option<usize> {
    for kind in 0..3 {
        let mut at = None;
        cuts(s, kind, |cut| {
            if cut > hi {
                return false;
            }
            if cut >= lo {
                at = Some(cut);
            }
            true
        });
        if at.is_some() {
            return at;
        }
    }
    None
}

/// The document split into chunks (JavaScript-trimmed first).
pub fn split_content(text: &str) -> Vec<String> {
    split_with(text, CHUNK_TARGET_LEN, CHUNK_MAX_LEN, CHUNK_OVERLAP)
}

fn split_with(text: &str, target: usize, max: usize, overlap: usize) -> Vec<String> {
    let s: Vec<u16> = crate::text::js_trim(text).encode_utf16().collect();
    if s.len() <= max {
        return vec![String::from_utf16_lossy(&s)];
    }
    let mut out = vec![];
    let mut at = 0usize;
    while at < s.len() {
        if s.len() - at <= max {
            out.push(String::from_utf16_lossy(&s[at..]));
            break;
        }
        let lo = at + target * 6 / 10;
        let hi = at + max;
        let end = match last_boundary(&s, lo, hi) {
            Some(cut) if cut > at => cut,
            _ => align_cut(&s, hi),
        };
        out.push(String::from_utf16_lossy(&s[at..end]));
        let mut next = align_cut(&s, end.saturating_sub(overlap));
        if next <= at {
            next = at + if is_high(s.get(at)) && is_low(s.get(at + 1)) { 2 } else { 1 };
        }
        at = next;
    }
    out
}

/// `next` without the overlap it repeats from the end of `text`.
pub fn cut_seam(text: &str, next: &str) -> String {
    let text: Vec<u16> = text.encode_utf16().collect();
    let next: Vec<u16> = next.encode_utf16().collect();
    let floor = MIN_SEAM.min(CHUNK_OVERLAP);
    let aligned = usize::from(is_high(next.first()) && is_low(next.get(1)));
    let max = (CHUNK_OVERLAP + aligned).min(text.len()).min(next.len());
    let mut n = max;
    while n >= floor && n > 0 {
        if text.ends_with(&next[..n]) {
            return String::from_utf16_lossy(&next[n..]);
        }
        n -= 1;
    }
    String::from_utf16_lossy(&next)
}

/// The text of consecutive chunks with their overlaps removed. Chunks are
/// (number, content) in ascending order; a missing number starts a new
/// paragraph.
pub fn join_chunks<'a>(chunks: impl IntoIterator<Item = (i64, &'a str)>) -> String {
    let mut text = String::new();
    let mut prev: Option<i64> = None;
    for (no, content) in chunks {
        let add = if prev == Some(no - 1) {
            cut_seam(&text, content)
        } else {
            content.to_owned()
        };
        if prev.is_some() && add.is_empty() {
            prev = Some(no);
            continue;
        }
        if prev.is_none() {
            text = content.to_owned();
        } else {
            if add == content {
                text.push('\n');
            }
            text.push_str(&add);
        }
        prev = Some(no);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        text: String,
        chunks: Vec<String>,
        seams: Vec<String>,
    }

    #[test]
    fn splits_match_the_stored_rule() {
        let fixtures: Vec<Case> = serde_json::from_str(
            &std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/chunk.json")).unwrap(),
        )
        .unwrap();
        assert!(fixtures.len() > 100);
        for (i, case) in fixtures.iter().enumerate() {
            let chunks = split_content(&case.text);
            assert_eq!(chunks, case.chunks, "case {i}");
            let seams: Vec<String> = chunks.windows(2).map(|w| cut_seam(&w[0], &w[1])).collect();
            assert_eq!(seams, case.seams, "case {i}");
        }
    }

    #[test]
    fn joined_chunks_restore_the_document() {
        let text: String = (0..60)
            .map(|i| format!("{i}번째 문장은 배치 재시작 절차를 설명한다. "))
            .collect();
        let chunks = split_content(&text);
        assert!(chunks.len() > 1);
        let joined = join_chunks(chunks.iter().enumerate().map(|(i, c)| (i as i64 + 1, c.as_str())));
        assert_eq!(joined, crate::text::js_trim(&text));
    }
}
