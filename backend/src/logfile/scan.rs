//! Parallel passes over a [`LogFile`]: the filter scan (producing match line numbers)
//! and the summary.

use crate::logfile::index::LogFile;
use crate::logfile::view::MatchSet;
use crate::model::log_summary::LogSummary;
use crate::parsing::line_filter::LineFilter;
use crate::parsing::parser::split_log_line;
use memchr::memmem;
use rayon::prelude::*;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

/// Decode a line for matching. Invalid UTF-8 is replaced, as the old line reader did.
fn as_text(line: &[u8]) -> Cow<'_, str> {
    String::from_utf8_lossy(line)
}

/// A [`LineFilter`] plus byte-level pre-checks.
///
/// A line can only have level `X` if it contains `[X]`, domain `D` if it contains
/// `[D]`, and a keyword in its message if the keyword is somewhere in the line. Lines
/// failing any of these are rejected with a SIMD substring search before they are
/// decoded and split. The result is identical to `LineFilter::matches`.
pub struct CompiledFilter {
    filter: LineFilter,
    /// Each group must have at least one needle present in the line.
    prechecks: Vec<Vec<memmem::Finder<'static>>>,
}

impl CompiledFilter {
    pub fn new(filter: LineFilter) -> Self {
        let finders = |v: &Option<Vec<String>>, bracket: bool| {
            v.as_ref().map(|items| {
                items
                    .iter()
                    .map(|k| {
                        let needle = if bracket { format!("[{k}]") } else { k.clone() };
                        memmem::Finder::new(needle.as_bytes()).into_owned()
                    })
                    .collect::<Vec<_>>()
            })
        };
        let prechecks = [
            finders(&filter.keywords, false),
            finders(&filter.levels, true),
            finders(&filter.domains, true),
        ]
        .into_iter()
        .flatten()
        .collect();
        Self { filter, prechecks }
    }

    pub fn matches(&self, line: &[u8]) -> bool {
        for group in &self.prechecks {
            if !group.iter().any(|f| f.find(line).is_some()) {
                return false;
            }
        }
        self.filter.matches(&as_text(line))
    }
}

/// Returned when a scan was cancelled because a newer query replaced it.
#[derive(Debug)]
pub struct Cancelled;

/// Scan the whole file in parallel and collect the line numbers that match.
pub fn scan_matches(
    file: &LogFile,
    filter: &CompiledFilter,
    cancel: &AtomicBool,
) -> Result<MatchSet, Cancelled> {
    let started = Instant::now();
    let per_chunk: Vec<Option<Vec<(u64, u64)>>> = file
        .chunks()
        .par_iter()
        .map(|chunk| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            // runs of consecutive matching lines, as half-open [start, end)
            let mut ranges: Vec<(u64, u64)> = Vec::new();
            for (line, bytes) in file.chunk_lines(chunk) {
                if filter.matches(bytes) {
                    match ranges.last_mut() {
                        Some(r) if r.1 == line => r.1 = line + 1,
                        _ => ranges.push((line, line + 1)),
                    }
                }
            }
            Some(ranges)
        })
        .collect();

    let mut ranges: Vec<(u64, u64)> = Vec::new();
    for chunk_ranges in per_chunk {
        let chunk_ranges = chunk_ranges.ok_or(Cancelled)?;
        for r in chunk_ranges {
            match ranges.last_mut() {
                Some(last) if last.1 == r.0 => last.1 = r.1,
                _ => ranges.push(r),
            }
        }
    }
    Ok(MatchSet::new(ranges, file.line_count(), started.elapsed()))
}

#[derive(Default)]
struct PartialSummary<'a> {
    total_lines: usize,
    levels: HashMap<Cow<'a, str>, usize>,
    domains: HashSet<Cow<'a, str>>,
    first_ts: Option<Cow<'a, str>>,
    last_ts: Option<Cow<'a, str>>,
}

impl<'a> PartialSummary<'a> {
    fn add(&mut self, ts: Cow<'a, str>, level: Cow<'a, str>, domain: Cow<'a, str>) {
        self.total_lines += 1;
        *self.levels.entry(level).or_insert(0) += 1;
        self.domains.insert(domain);
        if self.first_ts.is_none() {
            self.first_ts = Some(ts.clone());
        }
        self.last_ts = Some(ts);
    }
}

/// Compute the same summary as `parser::parse_log(text, None, None)`, in parallel over
/// the memory-mapped file. Valid UTF-8 lines are borrowed from the map, not copied.
pub fn summarize(file: &LogFile) -> LogSummary {
    let parts: Vec<PartialSummary<'_>> = file
        .chunks()
        .par_iter()
        .map(|chunk| {
            let mut p = PartialSummary::default();
            for (_, bytes) in file.chunk_lines(chunk) {
                match std::str::from_utf8(bytes) {
                    Ok(line) => {
                        if let Some(f) = split_log_line(line) {
                            p.add(f.ts.into(), f.level.into(), f.domain.into());
                        }
                    }
                    Err(_) => {
                        // invalid UTF-8 is replaced, as the old line reader did
                        let line = String::from_utf8_lossy(bytes);
                        if let Some(f) = split_log_line(&line) {
                            p.add(
                                f.ts.to_string().into(),
                                f.level.to_string().into(),
                                f.domain.to_string().into(),
                            );
                        }
                    }
                }
            }
            p
        })
        .collect();

    // merge in file order
    let mut levels: HashMap<String, usize> = HashMap::new();
    let mut domains: HashSet<String> = HashSet::new();
    let mut total_lines = 0usize;
    let mut start_timestamp: Option<String> = None;
    let mut stop_timestamp: Option<String> = None;
    for p in parts {
        total_lines += p.total_lines;
        for (l, n) in p.levels {
            *levels.entry(l.into_owned()).or_insert(0) += n;
        }
        domains.extend(p.domains.into_iter().map(Cow::into_owned));
        if start_timestamp.is_none() {
            start_timestamp = p.first_ts.map(Cow::into_owned);
        }
        if let Some(ts) = p.last_ts {
            stop_timestamp = Some(ts.into_owned());
        }
    }

    LogSummary {
        total_lines,
        line_count: file.line_count(),
        levels,
        unique_domains: domains.into_iter().collect(),
        start_timestamp,
        stop_timestamp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parsing::parser::parse_log;

    fn sample() -> String {
        let mut s = String::new();
        for i in 0..3000 {
            let level = ["INFO", "WARN", "ERROR", "DEBUG"][i % 4];
            let domain = ["core", "net", "ui"][i % 3];
            let msg = if i % 17 == 0 { "BOOM happened" } else { "all fine" };
            s.push_str(&format!("[2025-01-01 00:00:{:02}] [{level}] [{domain}] {msg} {i}\n", i % 60));
            if i % 101 == 0 {
                s.push_str("    at a stack trace line BOOM\n");
            }
        }
        s
    }

    #[test]
    fn scan_matches_equals_sequential_filter() {
        let text = sample();
        for chunk_size in [64, 4096, 1 << 20] {
            let file = LogFile::from_test_bytes(text.as_bytes(), chunk_size);
            for (lv, dm, kw) in [
                (None, None, Some("BOOM")),
                (Some("ERROR,WARN"), Some("net"), None),
                (None, None, None),
                (Some("INFO"), None, Some("BOOM,fine")),
            ] {
                let filter = LineFilter::from_csv(lv, dm, kw);
                let expected: Vec<u64> = text
                    .lines()
                    .enumerate()
                    .filter(|(_, l)| filter.matches(l))
                    .map(|(i, _)| i as u64)
                    .collect();
                let ms = scan_matches(&file, &CompiledFilter::new(filter), &AtomicBool::new(false))
                    .unwrap_or_else(|_| panic!("cancelled"));
                assert_eq!(ms.line_numbers(0, usize::MAX), expected, "chunk {chunk_size}");
            }
        }
    }

    #[test]
    fn cancelled_scan_returns_error() {
        let text = sample();
        let file = LogFile::from_test_bytes(text.as_bytes(), 64);
        let f = CompiledFilter::new(LineFilter::default());
        assert!(scan_matches(&file, &f, &AtomicBool::new(true)).is_err());
    }

    #[test]
    fn summary_equals_parse_log() {
        let text = sample();
        let file = LogFile::from_test_bytes(text.as_bytes(), 256);
        let a = summarize(&file);
        let b = parse_log(&text, None, None);
        assert_eq!(a.total_lines, b.total_lines);
        assert_eq!(a.levels, b.levels);
        assert_eq!(a.start_timestamp, b.start_timestamp);
        assert_eq!(a.stop_timestamp, b.stop_timestamp);
        let mut da = a.unique_domains.clone();
        let mut db = b.unique_domains.clone();
        da.sort();
        db.sort();
        assert_eq!(da, db);
        assert_eq!(a.line_count, b.line_count);
        assert_eq!(a.line_count, text.lines().count() as u64);
    }
}

/// Benchmark on a real file: `LOGFILE_BENCH=<path> cargo test --release bench_large_file
/// -- --ignored --nocapture`. Prints index, summary, scan and row-fetch timings.
#[cfg(test)]
mod bench {
    use super::*;
    use crate::logfile::index::display_text;

    fn ms(d: std::time::Duration) -> f64 {
        d.as_secs_f64() * 1000.0
    }

    #[test]
    #[ignore]
    fn bench_large_file() {
        let Ok(path) = std::env::var("LOGFILE_BENCH") else {
            eprintln!("set LOGFILE_BENCH to a log file path");
            return;
        };
        let t = Instant::now();
        let file = LogFile::open(std::path::Path::new(&path)).unwrap();
        println!(
            "open + index: {:.0} ms (index {:.0} ms) for {} bytes, {} lines, {} chunks, {} threads",
            ms(t.elapsed()),
            ms(file.index_time),
            file.len(),
            file.line_count(),
            file.chunks().len(),
            rayon::current_num_threads()
        );
        let t = Instant::now();
        let s = summarize(&file);
        println!("summary: {:.0} ms ({} log lines, {} levels)", ms(t.elapsed()), s.total_lines, s.levels.len());

        let no_cancel = AtomicBool::new(false);
        for (name, lv, dm, kw) in [
            ("rare keyword", None, None, Some("RAREFAILURE")),
            ("common keyword", None, None, Some("failed")),
            ("level ERROR", Some("ERROR"), None, None),
            ("level+domain", Some("ERROR,WARN"), Some("network"), None),
            ("no filter", None, None, None),
        ] {
            let t = Instant::now();
            let m = scan_matches(&file, &CompiledFilter::new(LineFilter::from_csv(lv, dm, kw)), &no_cancel)
                .unwrap_or_else(|_| panic!("cancelled"));
            let scan = t.elapsed();
            let t = Instant::now();
            let v = m.view(3);
            println!(
                "scan {name:15}: {:7.0} ms, {:>11} matches; view ±3 context: {:.2} ms, {} rows",
                ms(scan),
                m.match_count(),
                ms(t.elapsed()),
                v.row_count()
            );
        }

        // random-access latency: 256 lines at spread-out positions
        let n = file.line_count();
        let mut worst = 0f64;
        let mut total = 0f64;
        let probes = 200u64;
        for i in 0..probes {
            let start = (i * 7_919_993) % n.max(1);
            let t = Instant::now();
            let lines: Vec<String> = file.lines_from(start).take(256).map(|(_, b)| display_text(b, 16384).0).collect();
            let d = ms(t.elapsed());
            assert!(!lines.is_empty());
            worst = worst.max(d);
            total += d;
        }
        println!("fetch 256 lines at random positions: avg {:.3} ms, worst {:.3} ms", total / probes as f64, worst);
    }
}
