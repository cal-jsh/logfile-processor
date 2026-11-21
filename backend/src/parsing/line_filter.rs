// local
use crate::parsing::format::LogFormat;
// std
use std::collections::{BTreeMap, VecDeque};

/// Level / field / keyword filter applied to a single log line.
///
/// `None` (or no entry) for a criterion means "don't filter on it".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LineFilter {
    pub levels: Option<Vec<String>>,
    /// Other fields by name (`domain`, `thread`, ...): the line's value must be one of these
    pub fields: BTreeMap<String, Vec<String>>,
    pub keywords: Option<Vec<String>>,
    /// Time range `[from, to)` in ns since 1970 in the log's own clock (see
    /// [`parse_timestamp`](crate::logfile::timeline::parse_timestamp)): the line must have
    /// a timestamp in it. Lines without a timestamp never match a time range.
    pub time: Option<(i64, i64)>,
}

fn split_csv(s: Option<&str>) -> Option<Vec<String>> {
    s.map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
}

impl LineFilter {
    /// Build a filter from the query parameters of the view API: comma-separated
    /// `levels` and `keywords`, and `fields` as a JSON object of value lists, e.g.
    /// `{"domain":["core"],"thread":["12","13"]}`.
    pub fn from_query(levels: Option<&str>, fields: Option<&str>, keywords: Option<&str>) -> Result<Self, String> {
        let fields: BTreeMap<String, Vec<String>> = match fields {
            Some(j) if !j.trim().is_empty() => {
                serde_json::from_str(j).map_err(|e| format!("Invalid fields filter: {e}"))?
            }
            _ => BTreeMap::new(),
        };
        Ok(Self { levels: split_csv(levels), fields, keywords: split_csv(keywords), time: None })
    }

    /// Add a time range from the query parameters `time_from` / `time_to` (ms since 1970
    /// in the log's own clock, `from` included, `to` excluded). A missing end is open.
    pub fn with_time_ms(mut self, from: Option<f64>, to: Option<f64>) -> Result<Self, String> {
        if from.is_none() && to.is_none() {
            return Ok(self);
        }
        let ns = |ms: f64| -> Result<i64, String> {
            if !ms.is_finite() {
                return Err("Invalid time range".into());
            }
            Ok((ms * 1e6).round().clamp(i64::MIN as f64, i64::MAX as f64) as i64)
        };
        let a = from.map(ns).transpose()?.unwrap_or(i64::MIN);
        let b = to.map(ns).transpose()?.unwrap_or(i64::MAX);
        if a >= b {
            return Err("Empty time range: time_from must be before time_to".into());
        }
        self.time = Some((a, b));
        Ok(self)
    }

    /// Levels, domains and keywords as comma-separated lists (tests).
    #[cfg(test)]
    pub fn from_csv(levels: Option<&str>, domains: Option<&str>, keywords: Option<&str>) -> Self {
        let mut fields = BTreeMap::new();
        if let Some(d) = split_csv(domains) {
            fields.insert("domain".to_string(), d);
        }
        Self { levels: split_csv(levels), fields, keywords: split_csv(keywords), time: None }
    }

    pub fn is_empty(&self) -> bool {
        self.levels.is_none() && self.fields.is_empty() && self.keywords.is_none() && self.time.is_none()
    }

    /// Whether the line matches all active criteria. Lines that don't have the format
    /// never match. (The scan uses [`CompiledFilter`](crate::logfile::scan::CompiledFilter),
    /// which gives the same result faster.)
    pub fn matches(&self, fmt: &LogFormat, line: &str) -> bool {
        let Some(p) = fmt.parse(line) else {
            return false;
        };
        let field = |name: &str| fmt.field_index(name).map(|i| p.get(line, i));
        let level_ok = self.levels.as_ref().map_or(true, |v| {
            fmt.level_field().is_some_and(|l| v.iter().any(|s| s == p.get(line, l)))
        });
        let fields_ok = self
            .fields
            .iter()
            .all(|(name, values)| field(name).is_some_and(|f| values.iter().any(|s| s == f)));
        let message = fmt.message_field().map_or(line, |m| p.get(line, m));
        let keyword_ok = self
            .keywords
            .as_ref()
            .map_or(true, |v| v.iter().any(|kw| message.contains(kw.as_str())));
        let time_ok = self
            .time
            .map_or(true, |(a, b)| fmt.time_ns(line, &p).is_some_and(|t| t >= a && t < b));
        level_ok && fields_ok && keyword_ok && time_ok
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
    use crate::parsing::format::LEGACY_PATTERN;

    fn legacy() -> LogFormat {
        LogFormat::compile(LEGACY_PATTERN).unwrap()
    }

    fn line(n: u64, matched: bool) -> String {
        let msg = if matched { "BOOM" } else { "filler" };
        format!("[2025-01-01T08:00:00.000Z] [INFO] [Core] line{n} {msg}")
    }

    /// Run `n` lines (1-based) through the filter, with `matches` marking BOOM lines.
    /// Returns (line_number, context) pairs.
    fn run(n: u64, matches: &[u64], context: usize) -> Vec<(u64, bool)> {
        let filter = LineFilter::from_csv(None, None, Some("BOOM"));
        let fmt = legacy();
        let mut win = ContextWindow::new(context);
        let mut out = Vec::new();
        for i in 1..=n {
            let l = line(i, matches.contains(&i));
            let m = filter.matches(&fmt, &l);
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
        let fmt = legacy();
        let mut win = ContextWindow::new(1);
        let lines = [
            "not a log line",
            "  at stack.trace()",
            "[t] [ERROR] [Core] BOOM",
            "continuation",
        ];
        let mut out = Vec::new();
        for (i, l) in lines.iter().enumerate() {
            out.extend(win.push(i as u64 + 1, l.to_string(), filter.matches(&fmt, l)));
        }
        let got: Vec<(u64, bool)> = out.iter().map(|o| (o.line_number, o.context)).collect();
        assert_eq!(got, vec![(2, true), (3, false), (4, true)]);
    }

    #[test]
    fn level_and_domain_filters() {
        let fmt = legacy();
        let f = LineFilter::from_csv(Some("WARN, ERROR"), Some("Net"), None);
        assert!(f.matches(&fmt, "[t] [ERROR] [Net] x"));
        assert!(!f.matches(&fmt, "[t] [INFO] [Net] x"));
        assert!(!f.matches(&fmt, "[t] [ERROR] [Core] x"));
    }

    #[test]
    fn field_filters_from_json() {
        let fmt = LogFormat::compile("[%{time}] [%t] [%l] %v").unwrap();
        let f = LineFilter::from_query(None, Some(r#"{"thread":["7","9"]}"#), Some("go")).unwrap();
        assert!(f.matches(&fmt, "[t] [7] [INFO] go"));
        assert!(!f.matches(&fmt, "[t] [8] [INFO] go"));
        assert!(!f.matches(&fmt, "[t] [7] [INFO] stop"));
        // a field the format does not have matches nothing
        let f = LineFilter::from_query(None, Some(r#"{"domain":["x"]}"#), None).unwrap();
        assert!(!f.matches(&fmt, "[t] [7] [INFO] go"));
        assert!(LineFilter::from_query(None, Some("{nope"), None).is_err());
    }
}
