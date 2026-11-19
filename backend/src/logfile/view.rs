//! Filter results as line numbers, and context expansion at display time.
//!
//! A filter scan produces a [`MatchSet`]: the matching line numbers, stored as sorted
//! runs of consecutive lines. A [`View`] is a match set expanded by ±`context` lines:
//! the rows the viewer shows. Building a view only merges ranges, so changing the
//! context never rescans the file.
//!
//! Line numbers are 0-based here. Rows are 0-based positions in a view.

use crate::logfile::index::{LineIter, LogFile};
use crate::logfile::timeline::TimeBins;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub struct MatchSet {
    /// Sorted, disjoint, non-adjacent half-open ranges of matching lines.
    ranges: Vec<(u64, u64)>,
    match_count: u64,
    line_count: u64,
    pub scan_time: Duration,
    /// The most recently built view (the viewer asks for the same context repeatedly).
    last_view: Mutex<Option<Arc<View>>>,
    /// The matches binned by time (minimap "by time"), computed on first use.
    pub time_bins: OnceLock<Arc<TimeBins>>,
}

impl MatchSet {
    pub fn new(ranges: Vec<(u64, u64)>, line_count: u64, scan_time: Duration) -> Self {
        let match_count = ranges.iter().map(|r| r.1 - r.0).sum();
        Self { ranges, match_count, line_count, scan_time, last_view: Mutex::new(None), time_bins: OnceLock::new() }
    }

    pub fn match_count(&self) -> u64 {
        self.match_count
    }

    pub fn line_count(&self) -> u64 {
        self.line_count
    }

    /// The matching lines as sorted, disjoint half-open ranges.
    pub fn ranges(&self) -> &[(u64, u64)] {
        &self.ranges
    }

    pub fn is_match(&self, line: u64) -> bool {
        let i = self.ranges.partition_point(|r| r.1 <= line);
        self.ranges.get(i).is_some_and(|r| r.0 <= line)
    }

    /// Match line numbers, skipping the first `offset` matches.
    pub fn line_numbers(&self, offset: u64, limit: usize) -> Vec<u64> {
        // find the range holding the `offset`-th match
        let mut skipped = 0u64;
        let mut out = Vec::with_capacity(limit.min(1 << 16));
        for &(s, e) in &self.ranges {
            let len = e - s;
            if skipped + len <= offset {
                skipped += len;
                continue;
            }
            let from = s + offset.saturating_sub(skipped);
            skipped = offset;
            for l in from..e {
                if out.len() >= limit {
                    return out;
                }
                out.push(l);
            }
        }
        out
    }

    /// The view for `context` lines around each match, cached for the last context used.
    pub fn view(&self, context: u64) -> Arc<View> {
        let mut last = self.last_view.lock().unwrap();
        if let Some(v) = last.as_ref().filter(|v| v.context == context) {
            return v.clone();
        }
        let v = Arc::new(View::build(&self.ranges, context, self.line_count));
        *last = Some(v.clone());
        v
    }
}

pub struct View {
    pub context: u64,
    /// Sorted, disjoint, non-adjacent half-open line ranges shown in the view.
    segments: Vec<(u64, u64)>,
    /// `row_starts[i]` is the row of `segments[i].0`.
    row_starts: Vec<u64>,
    row_count: u64,
}

impl View {
    pub fn build(matches: &[(u64, u64)], context: u64, line_count: u64) -> Self {
        let mut segments: Vec<(u64, u64)> = Vec::with_capacity(matches.len());
        for &(s, e) in matches {
            let s = s.saturating_sub(context);
            let e = e.saturating_add(context).min(line_count);
            match segments.last_mut() {
                // overlapping or adjacent windows merge
                Some(last) if last.1 >= s => last.1 = last.1.max(e),
                _ => segments.push((s, e)),
            }
        }
        let mut row_starts = Vec::with_capacity(segments.len());
        let mut rows = 0u64;
        for &(s, e) in &segments {
            row_starts.push(rows);
            rows += e - s;
        }
        Self { context, segments, row_starts, row_count: rows }
    }

    pub fn row_count(&self) -> u64 {
        self.row_count
    }

    /// The file line shown at `row`.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn line_of_row(&self, row: u64) -> Option<u64> {
        if row >= self.row_count {
            return None;
        }
        let i = self.row_starts.partition_point(|&r| r <= row) - 1;
        Some(self.segments[i].0 + (row - self.row_starts[i]))
    }

    /// The first row showing `line` or a later line (`row_count` if there is none).
    pub fn row_of_line(&self, line: u64) -> u64 {
        let i = self.segments.partition_point(|s| s.1 <= line);
        match self.segments.get(i) {
            Some(&(s, _)) => self.row_starts[i] + line.saturating_sub(s),
            None => self.row_count,
        }
    }

    /// Runs of consecutive lines for rows `first_row..first_row + count`, as
    /// `(first row, first line, number of lines)`.
    pub fn runs(&self, first_row: u64, count: u64) -> Vec<(u64, u64, u64)> {
        let end_row = first_row.saturating_add(count).min(self.row_count);
        let mut out = Vec::new();
        if first_row >= end_row {
            return out;
        }
        let mut i = self.row_starts.partition_point(|&r| r <= first_row) - 1;
        let mut row = first_row;
        while row < end_row {
            let (s, e) = self.segments[i];
            let line = s + (row - self.row_starts[i]);
            let n = (e - line).min(end_row - row);
            out.push((row, line, n));
            row += n;
            i += 1;
        }
        out
    }
}

/// Iterate rows `first_row..first_row + count` of a view as `(row, line, bytes)`,
/// reading the file sequentially (each run continues from where the last one ended).
pub struct ViewLines<'a> {
    file: &'a LogFile,
    runs: std::vec::IntoIter<(u64, u64, u64)>,
    current: Option<(u64, LineIter<'a>, u64)>, // (row, lines, remaining)
    known: Option<(u64, usize)>,
}

impl<'a> ViewLines<'a> {
    pub fn new(file: &'a LogFile, view: &View, first_row: u64, count: u64) -> Self {
        Self { file, runs: view.runs(first_row, count).into_iter(), current: None, known: None }
    }
}

impl<'a> Iterator for ViewLines<'a> {
    type Item = (u64, u64, &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some((row, it, remaining)) = &mut self.current {
                if *remaining > 0 {
                    if let Some((line, bytes)) = it.next() {
                        let item = (*row, line, bytes);
                        *row += 1;
                        *remaining -= 1;
                        self.known = Some(it.cursor());
                        return Some(item);
                    }
                }
                self.current = None;
            }
            let (row, line, n) = self.runs.next()?;
            let it = self.file.lines_from_hint(line, self.known);
            self.current = Some((row, it, n));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parsing::line_filter::ContextWindow;

    /// A tiny deterministic PRNG so the test needs no extra crate.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
    }

    fn to_ranges(matches: &[bool]) -> Vec<(u64, u64)> {
        let mut r: Vec<(u64, u64)> = Vec::new();
        for (i, &m) in matches.iter().enumerate() {
            let i = i as u64;
            if m {
                match r.last_mut() {
                    Some(last) if last.1 == i => last.1 = i + 1,
                    _ => r.push((i, i + 1)),
                }
            }
        }
        r
    }

    /// Expand with the original streaming ContextWindow: (line, is_context) in order.
    fn reference(matches: &[bool], context: usize) -> Vec<(u64, bool)> {
        let mut w = ContextWindow::new(context);
        let mut out = Vec::new();
        for (i, &m) in matches.iter().enumerate() {
            for o in w.push(i as u64, String::new(), m) {
                out.push((o.line_number, o.context));
            }
        }
        out
    }

    #[test]
    fn view_matches_streaming_context_window_semantics() {
        let mut rng = Lcg(42);
        for case in 0..400 {
            let n = (rng.next() % 200) as usize;
            let density = 1 + rng.next() % 30;
            let matches: Vec<bool> = (0..n).map(|_| rng.next() % 100 < density).collect();
            let context = (rng.next() % 6) as usize;

            let ms = MatchSet::new(to_ranges(&matches), n as u64, Duration::ZERO);
            let view = ms.view(context as u64);
            let got: Vec<(u64, bool)> = (0..view.row_count())
                .map(|r| {
                    let l = view.line_of_row(r).unwrap();
                    (l, !ms.is_match(l))
                })
                .collect();
            assert_eq!(got, reference(&matches, context), "case {case}, context {context}");

            // runs() agrees with line_of_row(), and row_of_line() inverts it
            let flat: Vec<u64> = view
                .runs(0, view.row_count())
                .into_iter()
                .flat_map(|(_, l, k)| l..l + k)
                .collect();
            assert_eq!(flat, got.iter().map(|x| x.0).collect::<Vec<_>>());
            for r in 0..view.row_count() {
                assert_eq!(view.row_of_line(view.line_of_row(r).unwrap()), r);
            }
            assert_eq!(ms.match_count(), matches.iter().filter(|m| **m).count() as u64);
        }
    }

    #[test]
    fn runs_window_in_the_middle() {
        // matches at 10 and 20, context 1 => lines 9..12 and 19..22
        let ms = MatchSet::new(vec![(10, 11), (20, 21)], 100, Duration::ZERO);
        let v = ms.view(1);
        assert_eq!(v.row_count(), 6);
        assert_eq!(v.runs(2, 3), vec![(2, 11, 1), (3, 19, 2)]);
        assert_eq!(v.row_of_line(15), 3);
        assert_eq!(v.row_of_line(50), 6);
        assert!(v.runs(6, 10).is_empty());
    }

    #[test]
    fn view_lines_reads_the_right_text() {
        let text: String = (0..3000).map(|i| format!("l{i}\n")).collect();
        let file = LogFile::from_test_bytes(text.as_bytes(), 500);
        let matches: Vec<(u64, u64)> = (0..3000).step_by(37).map(|l| (l, l + 1)).collect();
        let ms = MatchSet::new(matches, 3000, Duration::ZERO);
        let view = ms.view(2);
        let got: Vec<(u64, u64, String)> = ViewLines::new(&file, &view, 5, 400)
            .map(|(r, l, b)| (r, l, String::from_utf8_lossy(b).into_owned()))
            .collect();
        assert_eq!(got.len(), 400);
        for (r, l, t) in got {
            assert_eq!(view.line_of_row(r), Some(l));
            assert_eq!(t, format!("l{l}"));
        }
    }

    #[test]
    fn line_numbers_paging() {
        let ms = MatchSet::new(vec![(1, 4), (10, 12)], 100, Duration::ZERO);
        assert_eq!(ms.line_numbers(0, 100), vec![1, 2, 3, 10, 11]);
        assert_eq!(ms.line_numbers(2, 2), vec![3, 10]);
        assert_eq!(ms.line_numbers(4, 10), vec![11]);
        assert!(ms.line_numbers(5, 10).is_empty());
    }

    #[test]
    fn context_is_clipped_to_file() {
        let ms = MatchSet::new(vec![(0, 1), (9, 10)], 10, Duration::ZERO);
        let v = ms.view(3);
        assert_eq!(v.runs(0, 100), vec![(0, 0, 4), (4, 6, 4)]);
    }
}
