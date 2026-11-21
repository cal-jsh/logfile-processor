//! The message part of a filter: plain keywords and regular expressions. A message
//! matches if it contains any keyword or any regular expression matches somewhere in it.
//! Also finds the matched text, so the viewer can mark it.

use regex::{Regex, RegexBuilder};
use regex_syntax::hir::literal::{ExtractKind, Extractor};

/// Longest regular expression accepted (in bytes of the pattern).
const MAX_PATTERN_LEN: usize = 4096;
/// Compiled size limit per regular expression (the `regex` crate's default is 10 MB).
const SIZE_LIMIT: usize = 16 << 20;
/// Most marked spans per piece of text: enough for any line on screen.
const MAX_SPANS: usize = 200;

/// Compile a filter regex: Rust `regex` syntax, case-sensitive unless it says `(?i)`.
/// The error is meant for people: for a syntax error it shows the pattern with the
/// spot marked, over several lines.
pub fn compile_regex(pattern: &str) -> Result<Regex, String> {
    compile(pattern, false)
}

/// Like [`compile_regex`], ignoring case (the search panel).
pub fn compile_regex_ignore_case(pattern: &str) -> Result<Regex, String> {
    compile(pattern, true)
}

fn compile(pattern: &str, ignore_case: bool) -> Result<Regex, String> {
    if pattern.is_empty() {
        return Err("Empty regular expression".into());
    }
    if pattern.len() > MAX_PATTERN_LEN {
        return Err(format!("Regular expression too long (over {MAX_PATTERN_LEN} bytes)"));
    }
    RegexBuilder::new(pattern)
        .case_insensitive(ignore_case)
        .size_limit(SIZE_LIMIT)
        .build()
        .map_err(|e| match e {
            regex::Error::Syntax(s) => s,
            regex::Error::CompiledTooBig(_) => "Regular expression too big once compiled".into(),
            e => e.to_string(),
        })
}

/// Keywords and regular expressions, compiled.
#[derive(Clone, Debug)]
pub struct TextMatcher {
    keywords: Vec<String>,
    regexes: Vec<Regex>,
}

impl TextMatcher {
    pub fn new(keywords: &[String], patterns: &[String]) -> Result<Self, String> {
        let regexes = patterns
            .iter()
            .map(|p| compile_regex(p).map_err(|e| format!("Invalid regular expression: {e}")))
            .collect::<Result<_, _>>()?;
        Ok(Self { keywords: keywords.to_vec(), regexes })
    }

    pub fn is_empty(&self) -> bool {
        self.keywords.is_empty() && self.regexes.is_empty()
    }

    pub fn has_regex(&self) -> bool {
        !self.regexes.is_empty()
    }

    pub fn keywords(&self) -> &[String] {
        &self.keywords
    }

    /// Any keyword in `text`, or any regex matching in it.
    pub fn is_match(&self, text: &str) -> bool {
        self.keywords.iter().any(|k| text.contains(k.as_str())) || self.regexes.iter().any(|r| r.is_match(text))
    }

    /// Byte ranges of the matched text in `text`, sorted, overlapping and touching ones
    /// joined. Empty regex matches (e.g. of `a*`) mark nothing.
    pub fn spans(&self, text: &str) -> Vec<(usize, usize)> {
        let mut v: Vec<(usize, usize)> = Vec::new();
        for k in self.keywords.iter().filter(|k| !k.is_empty()) {
            v.extend(text.match_indices(k.as_str()).take(MAX_SPANS).map(|(i, m)| (i, i + m.len())));
        }
        for r in &self.regexes {
            v.extend(r.find_iter(text).filter(|m| !m.is_empty()).take(MAX_SPANS).map(|m| (m.start(), m.end())));
        }
        merge_spans(v)
    }

    /// A regex (on bytes) that finds every line that can match, searched over a whole
    /// chunk of the file before any line is decoded and split: per keyword the keyword;
    /// per regular expression the literals each of its matches contains (e.g. `failed`
    /// for `Request \d+ failed`), or else the regex itself if it has no anchors or word
    /// boundaries (which mean something else in the whole line than in the message).
    /// `None` if some regex has neither (e.g. `^\d+`): then every line is checked.
    ///
    /// Lines with invalid UTF-8 are matched after decoding (U+FFFD for the bad bytes); a
    /// regex that only matches because of such a U+FFFD may be missed by this search.
    pub fn candidate_pattern(&self) -> Option<String> {
        let mut alts: Vec<String> = Vec::new();
        for k in &self.keywords {
            if k.is_empty() {
                return None;
            }
            alts.push(regex::escape(k));
        }
        for r in &self.regexes {
            match regex_literals(r.as_str()) {
                Some(lits) => alts.extend(lits.iter().map(|l| literal_regex(l))),
                None if no_look_around(r.as_str()) => alts.push(format!("(?:{})", r.as_str())),
                None => return None,
            }
        }
        alts.sort();
        alts.dedup();
        Some(alts.join("|"))
    }
}

/// `lit` as a regex: escaped text, or byte by byte if it is not valid UTF-8 (a literal
/// cut inside a character).
fn literal_regex(lit: &[u8]) -> String {
    match std::str::from_utf8(lit) {
        Ok(s) => regex::escape(s),
        Err(_) => lit.iter().map(|b| format!("(?-u:\\x{b:02X})")).collect(),
    }
}

/// Whether `pattern` has no anchors and no word boundaries.
fn no_look_around(pattern: &str) -> bool {
    regex_syntax::Parser::new().parse(pattern).is_ok_and(|h| h.properties().look_set().is_empty())
}

/// Literals of which every match of `pattern` contains one: its prefixes, or its
/// suffixes if they are better (longer). `None` if neither gives a usable set.
fn regex_literals(pattern: &str) -> Option<Vec<Vec<u8>>> {
    let hir = regex_syntax::Parser::new().parse(pattern).ok()?;
    let mut best: Option<Vec<Vec<u8>>> = None;
    for kind in [ExtractKind::Prefix, ExtractKind::Suffix] {
        let mut seq = Extractor::new().kind(kind.clone()).extract(&hir);
        // may shorten or drop literals, never so that a match lacks all of them
        match kind {
            ExtractKind::Prefix => seq.optimize_for_prefix_by_preference(),
            _ => seq.optimize_for_suffix_by_preference(),
        }
        let Some(lits) = seq.literals() else { continue };
        // an empty literal is in every line; an empty set means "never matches", which
        // the regex itself will say
        if lits.is_empty() || lits.iter().any(|l| l.as_bytes().is_empty()) {
            continue;
        }
        let set: Vec<Vec<u8>> = lits.iter().map(|l| l.as_bytes().to_vec()).collect();
        let shortest = |s: &Vec<Vec<u8>>| s.iter().map(Vec::len).min().unwrap_or(0);
        if best.as_ref().map_or(true, |b| shortest(&set) > shortest(b)) {
            best = Some(set);
        }
    }
    best
}

/// Sort and join overlapping or touching ranges.
pub fn merge_spans(mut v: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    v.sort_unstable();
    let mut out: Vec<(usize, usize)> = Vec::with_capacity(v.len());
    for (s, e) in v {
        match out.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out.truncate(MAX_SPANS);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(k: &[&str], p: &[&str]) -> TextMatcher {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        TextMatcher::new(&s(k), &s(p)).unwrap()
    }

    #[test]
    fn keyword_or_regex() {
        let t = m(&["timeout"], &[r"code=\d{3}\b"]);
        assert!(t.is_match("request timeout after 3s"));
        assert!(t.is_match("failed with code=503 here"));
        assert!(!t.is_match("failed with code=50"));
        assert!(!t.is_match("all good"));
        // case-sensitive unless the pattern says otherwise
        assert!(!m(&[], &["error"]).is_match("ERROR"));
        assert!(m(&[], &["(?i)error"]).is_match("ERROR"));
    }

    #[test]
    fn invalid_regex_is_an_error_with_the_spot() {
        let e = TextMatcher::new(&[], &["a(b".into()]).unwrap_err();
        assert!(e.contains("unclosed group"), "{e}");
        assert!(compile_regex("").is_err());
        assert!(compile_regex(&"a".repeat(5000)).is_err());
    }

    #[test]
    fn spans_are_merged_and_skip_empty_matches() {
        let t = m(&["ab"], &["b+c", "x*"]);
        assert_eq!(t.spans("zabbbc ab"), vec![(1, 6), (7, 9)]);
        // byte offsets, also after multi-byte characters
        assert_eq!(m(&[], &[r"\d+"]).spans("é 42"), vec![(3, 5)]);
    }

    #[test]
    fn literals_for_the_precheck() {
        let lits = |p: &str| regex_literals(p).map(|v| v.into_iter().map(|l| String::from_utf8(l).unwrap()).collect::<Vec<_>>());
        assert_eq!(lits("timeout after"), Some(vec!["timeout after".to_string()]));
        // suffix wins when the prefix is a class
        let l = lits(r"\w+Exception").unwrap();
        assert!(l.iter().all(|x| x.contains("Exception")), "{l:?}");
        assert_eq!(lits(r"\d+"), None);
        assert_eq!(lits(r"^"), None);
        let ci = lits("(?i)err").unwrap();
        assert!(ci.contains(&"ERR".to_string()) && ci.contains(&"err".to_string()), "{ci:?}");
        // the search for candidate lines: literals, else the regex if it has no anchors
        assert_eq!(m(&["a.b"], &["yz", r"\d+"]).candidate_pattern().as_deref(), Some(r"(?:\d+)|a\.b|yz"));
        assert_eq!(m(&["x"], &[r"^\d"]).candidate_pattern(), None);
        assert_eq!(m(&["x"], &[r"\bid\b"]).candidate_pattern().as_deref(), Some("id|x"));
        assert_eq!(m(&[""], &[]).candidate_pattern(), None);
        assert_eq!(literal_regex(&[b'a', 0xC3]), r"(?-u:\x61)(?-u:\xC3)");
    }
}
