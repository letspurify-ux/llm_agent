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

/// Every cut position of each boundary kind, ascending. The positions do
/// not depend on the chunk being cut, so they are found once per document:
/// scanning from the start again for every chunk made a long document's
/// split quadratic (seconds of a runtime thread for a few million characters).
fn boundaries(s: &[u16]) -> [Vec<usize>; 3] {
    std::array::from_fn(|kind| {
        let mut found = vec![];
        cuts(s, kind, |cut| {
            found.push(cut);
            true
        });
        found
    })
}

/// The last cut within `lo..=hi`, of the first kind that has one.
fn last_boundary(boundaries: &[Vec<usize>; 3], lo: usize, hi: usize) -> Option<usize> {
    boundaries.iter().find_map(|cuts| {
        let below = cuts.partition_point(|&cut| cut <= hi);
        below.checked_sub(1).map(|i| cuts[i]).filter(|&cut| cut >= lo)
    })
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
    let boundaries = boundaries(&s);
    let mut out = vec![];
    let mut at = 0usize;
    while at < s.len() {
        if s.len() - at <= max {
            out.push(String::from_utf16_lossy(&s[at..]));
            break;
        }
        let lo = at + target * 6 / 10;
        let hi = at + max;
        let end = match last_boundary(&boundaries, lo, hi) {
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

    /// The split as first written: every chunk scanned the document from
    /// its start again, quadratic in the document's length.
    fn reference_split(text: &str) -> Vec<String> {
        let (target, max, overlap) = (CHUNK_TARGET_LEN, CHUNK_MAX_LEN, CHUNK_OVERLAP);
        let s: Vec<u16> = crate::text::js_trim(text).encode_utf16().collect();
        if s.len() <= max {
            return vec![String::from_utf16_lossy(&s)];
        }
        let last_boundary = |lo: usize, hi: usize| {
            for kind in 0..3 {
                let mut at = None;
                cuts(&s, kind, |cut| {
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
        };
        let mut out = vec![];
        let mut at = 0usize;
        while at < s.len() {
            if s.len() - at <= max {
                out.push(String::from_utf16_lossy(&s[at..]));
                break;
            }
            let end = match last_boundary(at + target * 6 / 10, at + max) {
                Some(cut) if cut > at => cut,
                _ => align_cut(&s, at + max),
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

    #[test]
    fn long_documents_split_as_before_in_linear_time() {
        let pieces = ["배치 재시작 절차를 설명한다. ", "\n\n", "\n## 절차\n", "word ", "😀", "x", "?\n", "\n \t\n", "#"];
        let mut seed = 7u64;
        for size in [500, 3_000, 20_000, 120_000] {
            let mut text = String::new();
            while text.len() < size {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                text.push_str(pieces[(seed >> 33) as usize % pieces.len()]);
            }
            assert_eq!(split_content(&text), reference_split(&text), "size {size}");
        }
        let long = "가나다라마바사 아자차카타파하. ".repeat(100_000);
        let started = std::time::Instant::now();
        let chunks = split_content(&long);
        assert!(chunks.len() > 1000);
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
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
