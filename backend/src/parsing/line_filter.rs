// local
use crate::parsing::parser::{split_log_line, LogFields};
// std
use std::collections::VecDeque;

/// Level / domain / keyword filter applied to a single log line.
///
/// `None` for a criterion means "don't filter on it".
#[derive(Clone, Debug, Default)]
pub struct LineFilter {
    pub levels: Option<Vec<String>>,
    pub domains: Option<Vec<String>>,
    pub keywords: Option<Vec<String>>,
}

impl LineFilter {
    /// Build a filter from the comma-separated query parameters of `/stream_logs`.
    pub fn from_csv(levels: Option<&str>, domains: Option<&str>, keywords: Option<&str>) -> Self {
        fn split(s: Option<&str>) -> Option<Vec<String>> {
            s.map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
        }
        Self {
            levels: split(levels),
            domains: split(domains),
            keywords: split(keywords),
        }
    }

    /// Whether the line matches all active criteria.
    /// Lines that don't follow the `[ts] [LEVEL] [domain] message` format never match.
    pub fn matches(&self, line: &str) -> bool {
        let Some(LogFields { level, domain, message, .. }) = split_log_line(line) else {
            return false;
        };

        let level_ok = self
            .levels
            .as_ref()
            .map_or(true, |v| v.iter().any(|s| s == level));
        let domain_ok = self
            .domains
            .as_ref()
            .map_or(true, |v| v.iter().any(|s| s == domain));
        let keyword_ok = self
            .keywords
            .as_ref()
            .map_or(true, |v| v.iter().any(|kw| message.contains(kw.as_str())));
        level_ok && domain_ok && keyword_ok
    }
}

/// One line selected for output.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputLine {
    /// 1-based line number in the original file.
    pub line_number: u64,
    pub line: String,
    /// `true` if the line is only included as context around a match.
    pub context: bool,
}

/// Expands matches with up to `context` lines before and after them.
///
/// Feed every line of the file, in order, to [`ContextWindow::push`]. Each line is
/// emitted at most once, in file order, and overlapping windows are merged.
///
/// The server now expands context from match line numbers instead
/// (`logfile::view::View`), so that changing the context needs no rescan. This
/// streaming version is kept as the reference those semantics are tested against.
#[cfg_attr(not(test), allow(dead_code))]
pub struct ContextWindow {
    context: usize,
    /// Unemitted lines just before the current position (at most `context`).
    before: VecDeque<(u64, String)>,
    /// How many upcoming lines still belong to the last match's trailing context.
    after_remaining: usize,
}

#[cfg_attr(not(test), allow(dead_code))]
impl ContextWindow {
    pub fn new(context: usize) -> Self {
        Self {
            context,
            before: VecDeque::with_capacity(context),
            after_remaining: 0,
        }
    }

    pub fn push(&mut self, line_number: u64, line: String, matched: bool) -> Vec<OutputLine> {
        if matched {
            let mut out: Vec<OutputLine> = self
                .before
                .drain(..)
                .map(|(n, l)| OutputLine { line_number: n, line: l, context: true })
                .collect();
            out.push(OutputLine { line_number, line, context: false });
            self.after_remaining = self.context;
            out
        } else if self.after_remaining > 0 {
            self.after_remaining -= 1;
            vec![OutputLine { line_number, line, context: true }]
        } else {
            if self.context > 0 {
                if self.before.len() == self.context {
                    self.before.pop_front();
                }
                self.before.push_back((line_number, line));
            }
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(n: u64, matched: bool) -> String {
        let msg = if matched { "BOOM" } else { "filler" };
        format!("[2025-01-01T08:00:00.000Z] [INFO] [Core] line{n} {msg}")
    }

    /// Run `n` lines (1-based) through the filter, with `matches` marking BOOM lines.
    /// Returns (line_number, context) pairs.
    fn run(n: u64, matches: &[u64], context: usize) -> Vec<(u64, bool)> {
        let filter = LineFilter::from_csv(None, None, Some("BOOM"));
        let mut win = ContextWindow::new(context);
        let mut out = Vec::new();
        for i in 1..=n {
            let l = line(i, matches.contains(&i));
            let m = filter.matches(&l);
            for o in win.push(i, l.clone(), m) {
                // the text must belong to the reported line number
                assert!(o.line.contains(&format!("line{} ", o.line_number)));
                out.push((o.line_number, o.context));
            }
        }
        out
    }

    fn nums(v: &[(u64, bool)]) -> Vec<u64> {
        v.iter().map(|x| x.0).collect()
    }

    #[test]
    fn no_context_emits_only_matches_with_real_line_numbers() {
        let out = run(20, &[5, 12, 20], 0);
        assert_eq!(out, vec![(5, false), (12, false), (20, false)]);
    }

    #[test]
    fn context_includes_lines_before_and_after() {
        let out = run(20, &[5, 12, 20], 2);
        assert_eq!(
            out,
            vec![
                (3, true), (4, true), (5, false), (6, true), (7, true),
                (10, true), (11, true), (12, false), (13, true), (14, true),
                (18, true), (19, true), (20, false),
            ]
        );
    }

    #[test]
    fn overlapping_windows_are_merged_without_duplicates() {
        // matches 5 and 7 with context 3: window is 2..=10, each line once
        let out = run(20, &[5, 7], 3);
        assert_eq!(nums(&out), (2..=10).collect::<Vec<_>>());
        let matched: Vec<u64> = out.iter().filter(|x| !x.1).map(|x| x.0).collect();
        assert_eq!(matched, vec![5, 7]);
    }

    #[test]
    fn adjacent_matches_are_all_reported_as_matches() {
        let out = run(10, &[4, 5, 6], 1);
        assert_eq!(
            out,
            vec![(3, true), (4, false), (5, false), (6, false), (7, true)]
        );
    }

    #[test]
    fn match_on_first_and_last_line() {
        let out = run(6, &[1, 6], 2);
        assert_eq!(
            out,
            vec![(1, false), (2, true), (3, true), (4, true), (5, true), (6, false)]
        );
    }

    #[test]
    fn match_inside_trailing_context_extends_window() {
        // context 2: match at 3 opens 4..5; match at 5 extends to 7
        let out = run(12, &[3, 5], 2);
        assert_eq!(nums(&out), vec![1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn non_log_lines_count_toward_line_numbers() {
        let filter = LineFilter::from_csv(None, None, Some("BOOM"));
        let mut win = ContextWindow::new(1);
        let lines = [
            "not a log line",
            "  at stack.trace()",
            "[t] [ERROR] [Core] BOOM",
            "continuation",
        ];
        let mut out = Vec::new();
        for (i, l) in lines.iter().enumerate() {
            out.extend(win.push(i as u64 + 1, l.to_string(), filter.matches(l)));
        }
        let got: Vec<(u64, bool)> = out.iter().map(|o| (o.line_number, o.context)).collect();
        assert_eq!(got, vec![(2, true), (3, false), (4, true)]);
    }

    #[test]
    fn level_and_domain_filters() {
        let f = LineFilter::from_csv(Some("WARN, ERROR"), Some("Net"), None);
        assert!(f.matches("[t] [ERROR] [Net] x"));
        assert!(!f.matches("[t] [INFO] [Net] x"));
        assert!(!f.matches("[t] [ERROR] [Core] x"));
    }
}
