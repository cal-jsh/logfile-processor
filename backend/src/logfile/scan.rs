//! Parallel passes over a [`LogFile`]: the filter scan (producing match line numbers)
//! and the summary.

use crate::logfile::index::{Chunk, LogFile};
use crate::logfile::view::MatchSet;
use crate::model::log_summary::{FieldValues, FormatInfo, LogSummary};
use crate::parsing::format::{FieldKind, LogFormat};
use crate::parsing::line_filter::LineFilter;
use memchr::memmem;
use rayon::prelude::*;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Values listed per field in the summary (thread ids, domains, ...).
pub const MAX_FIELD_VALUES: usize = 1000;

/// Decode a line for matching. Invalid UTF-8 is replaced, as the old line reader did.
fn as_text(line: &[u8]) -> Cow<'_, str> {
    String::from_utf8_lossy(line)
}

/// A [`LineFilter`] resolved against a format, plus byte-level pre-checks.
///
/// A line can only have level `X` if it contains `X` (with the characters around the
/// level in the format, e.g. `[X]`), likewise for other fields, and a keyword in its
/// message only if the keyword is somewhere in the line. Lines failing any of these are
/// rejected with a SIMD substring search before they are decoded and split. The result
/// is identical to `LineFilter::matches`.
///
/// With a time range and the chunks' time spans ([`with_chunk_spans`](Self::with_chunk_spans)),
/// chunks whose timestamps all lie outside the range are skipped without being read, so a
/// narrow range scans only the few chunks around it.
pub struct CompiledFilter {
    format: Arc<LogFormat>,
    /// `(field index, accepted values)`; the level is one of them
    criteria: Vec<(usize, Vec<String>)>,
    keywords: Option<Vec<String>>,
    /// A criterion names a field the format does not have: nothing matches
    impossible: bool,
    /// Each group must have at least one needle present in the line.
    prechecks: Vec<Vec<memmem::Finder<'static>>>,
    /// `[from, to)` in ns: the line's timestamp must be in it
    time: Option<(i64, i64)>,
    /// Earliest and latest timestamp per index chunk, to skip chunks outside `time`
    chunk_spans: Option<Arc<crate::logfile::levels::LevelIndex>>,
}

impl CompiledFilter {
    pub fn new(filter: LineFilter, format: Arc<LogFormat>) -> Self {
        let mut criteria = Vec::new();
        let mut impossible = false;
        let mut prechecks: Vec<Vec<memmem::Finder<'static>>> = Vec::new();
        let finders = |items: &[String], affixes: (Option<char>, Option<char>)| {
            items
                .iter()
                .map(|k| {
                    let mut needle = String::new();
                    needle.extend(affixes.0);
                    needle.push_str(k);
                    needle.extend(affixes.1);
                    memmem::Finder::new(needle.as_bytes()).into_owned()
                })
                .collect::<Vec<_>>()
        };
        if let Some(k) = &filter.keywords {
            prechecks.push(finders(k, (None, None)));
        }
        let wanted = filter
            .levels
            .map(|v| (format.level_field(), v))
            .into_iter()
            .chain(filter.fields.into_iter().map(|(name, v)| (format.field_index(&name), v)));
        for (field, values) in wanted {
            match field {
                Some(f) => {
                    prechecks.push(finders(&values, format.affixes(f)));
                    criteria.push((f, values));
                }
                None => impossible = true,
            }
        }
        Self { format, criteria, keywords: filter.keywords, impossible, prechecks, time: filter.time, chunk_spans: None }
    }

    /// Use the chunks' time spans of `levels` (built over the same file) to skip chunks
    /// outside the time range. Without them every chunk is read; the result is the same.
    pub fn with_chunk_spans(mut self, levels: Arc<crate::logfile::levels::LevelIndex>) -> Self {
        self.chunk_spans = Some(levels);
        self
    }

    /// Whether chunk `i` of the file can hold a match (false only when its timestamps are
    /// known and all outside the time range).
    pub fn chunk_may_match(&self, i: usize) -> bool {
        if self.impossible {
            return false;
        }
        let (Some((a, b)), Some(levels)) = (self.time, &self.chunk_spans) else {
            return true;
        };
        match levels.chunk_spans().get(i) {
            // no timestamp in the chunk: no line of it can be in a time range
            Some(None) => false,
            Some(Some((lo, hi))) => *hi >= a && *lo < b,
            None => true,
        }
    }

    pub fn matches(&self, line: &[u8]) -> bool {
        if self.impossible {
            return false;
        }
        for group in &self.prechecks {
            if !group.iter().any(|f| f.find(line).is_some()) {
                return false;
            }
        }
        let text = as_text(line);
        let Some(p) = self.format.parse(&text) else {
            return false;
        };
        for (f, values) in &self.criteria {
            let v = p.get(&text, *f);
            if !values.iter().any(|s| s == v) {
                return false;
            }
        }
        if let Some(kws) = &self.keywords {
            let message = self.format.message_field().map_or(&*text, |m| p.get(&text, m));
            if !kws.iter().any(|kw| message.contains(kw.as_str())) {
                return false;
            }
        }
        match self.time {
            None => true,
            Some((a, b)) => self.format.time_ns(&text, &p).is_some_and(|t| t >= a && t < b),
        }
    }
}

/// Returned when a scan was cancelled because a newer query replaced it.
#[derive(Debug)]
pub struct Cancelled;

/// The runs of consecutive matching lines of chunk number `i`, as half-open `[start, end)`.
fn chunk_matches(file: &LogFile, filter: &CompiledFilter, i: usize, chunk: &Chunk) -> Vec<(u64, u64)> {
    let mut ranges: Vec<(u64, u64)> = Vec::new();
    if !filter.chunk_may_match(i) {
        return ranges;
    }
    for (line, bytes) in file.chunk_lines(chunk) {
        if filter.matches(bytes) {
            match ranges.last_mut() {
                Some(r) if r.1 == line => r.1 = line + 1,
                _ => ranges.push((line, line + 1)),
            }
        }
    }
    ranges
}

/// Append runs in file order, joining a run that continues the last one.
fn append_ranges(ranges: &mut Vec<(u64, u64)>, more: Vec<(u64, u64)>) {
    for r in more {
        match ranges.last_mut() {
            Some(last) if last.1 == r.0 => last.1 = r.1,
            _ => ranges.push(r),
        }
    }
}

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
        .enumerate()
        .map(|(i, chunk)| (!cancel.load(Ordering::Relaxed)).then(|| chunk_matches(file, filter, i, chunk)))
        .collect();

    let mut ranges: Vec<(u64, u64)> = Vec::new();
    for chunk_ranges in per_chunk {
        append_ranges(&mut ranges, chunk_ranges.ok_or(Cancelled)?);
    }
    Ok(MatchSet::new(ranges, file.line_count(), started.elapsed()))
}

/// Like [`scan_matches`], but hands the matching runs to `sink` a few chunks at a time,
/// in file order, while the next chunks are scanned. Memory stays bounded however many
/// lines match (the command line writes them out as they come). A run may continue
/// the last one of the previous call. Stops at the first error of `sink`.
pub fn scan_streaming<E>(
    file: &LogFile,
    filter: &CompiledFilter,
    mut sink: impl FnMut(&[(u64, u64)]) -> Result<(), E>,
) -> Result<(), E> {
    // enough chunks per wave to keep every thread busy, one wave ahead of the sink
    let wave = rayon::current_num_threads().max(1) * 2;
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<(u64, u64)>>(1);
    std::thread::scope(|scope| {
        scope.spawn(move || {
            for (g, group) in file.chunks().chunks(wave).enumerate() {
                let per_chunk: Vec<Vec<(u64, u64)>> = group
                    .par_iter()
                    .enumerate()
                    .map(|(i, chunk)| chunk_matches(file, filter, g * wave + i, chunk))
                    .collect();
                let mut ranges = Vec::new();
                for r in per_chunk {
                    append_ranges(&mut ranges, r);
                }
                // the sink failed and is gone: stop scanning
                if tx.send(ranges).is_err() {
                    break;
                }
            }
        });
        for ranges in rx {
            sink(&ranges)?;
        }
        Ok(())
    })
}

/// Which fields the summary looks at.
struct SummaryPlan {
    level: Option<usize>,
    time: Option<usize>,
    /// Filterable fields (indices into the format's fields)
    fields: Vec<usize>,
}

struct PartialSummary<'a> {
    total_lines: usize,
    levels: HashMap<Cow<'a, str>, usize>,
    /// Distinct values per filterable field (same order as `SummaryPlan::fields`)
    values: Vec<HashSet<Cow<'a, str>>>,
    /// The field had more than [`MAX_FIELD_VALUES`] values
    more: Vec<bool>,
    first_ts: Option<Cow<'a, str>>,
    last_ts: Option<Cow<'a, str>>,
}

impl<'a> PartialSummary<'a> {
    fn new(plan: &SummaryPlan) -> Self {
        Self {
            total_lines: 0,
            levels: HashMap::new(),
            values: plan.fields.iter().map(|_| HashSet::new()).collect(),
            more: vec![false; plan.fields.len()],
            first_ts: None,
            last_ts: None,
        }
    }

    /// Count one parsed line. `get(i)` returns field `i` (borrowed or owned).
    fn add(&mut self, plan: &SummaryPlan, get: impl Fn(usize) -> Cow<'a, str>) {
        self.total_lines += 1;
        if let Some(l) = plan.level {
            *self.levels.entry(get(l)).or_insert(0) += 1;
        }
        for (k, &f) in plan.fields.iter().enumerate() {
            if self.more[k] {
                continue;
            }
            let v = get(f);
            if !self.values[k].contains(&v) {
                if self.values[k].len() >= MAX_FIELD_VALUES {
                    self.more[k] = true;
                } else {
                    self.values[k].insert(v);
                }
            }
        }
        if let Some(t) = plan.time {
            let ts = get(t);
            if self.first_ts.is_none() {
                self.first_ts = Some(ts.clone());
            }
            self.last_ts = Some(ts);
        }
    }
}

/// Count the log lines, levels and field values of the file, in parallel over the
/// memory-mapped file. Valid UTF-8 lines are borrowed from the map, not copied.
/// The sample counts in `format` are left at 0 for the caller to fill in.
pub fn summarize(file: &LogFile, format: &LogFormat) -> LogSummary {
    let defs = format.fields();
    let plan = SummaryPlan {
        level: format.level_field(),
        time: format.time_field(),
        fields: (0..defs.len()).filter(|&i| defs[i].filterable && defs[i].kind == FieldKind::Text).collect(),
    };
    let parts: Vec<PartialSummary<'_>> = file
        .chunks()
        .par_iter()
        .map(|chunk| {
            let mut p = PartialSummary::new(&plan);
            for (_, bytes) in file.chunk_lines(chunk) {
                match std::str::from_utf8(bytes) {
                    Ok(line) => {
                        if let Some(f) = format.parse(line) {
                            p.add(&plan, |i| Cow::Borrowed(f.get(line, i)));
                        }
                    }
                    Err(_) => {
                        // invalid UTF-8 is replaced, as the old line reader did
                        let line = String::from_utf8_lossy(bytes);
                        if let Some(f) = format.parse(&line) {
                            p.add(&plan, |i| Cow::Owned(f.get(&line, i).to_string()));
                        }
                    }
                }
            }
            p
        })
        .collect();

    // merge in file order
    let mut levels: HashMap<String, usize> = HashMap::new();
    let mut values: Vec<HashSet<String>> = plan.fields.iter().map(|_| HashSet::new()).collect();
    let mut more = vec![false; plan.fields.len()];
    let mut total_lines = 0usize;
    let mut start_timestamp: Option<String> = None;
    let mut stop_timestamp: Option<String> = None;
    for p in parts {
        total_lines += p.total_lines;
        for (l, n) in p.levels {
            *levels.entry(l.into_owned()).or_insert(0) += n;
        }
        for (k, set) in p.values.into_iter().enumerate() {
            more[k] |= p.more[k];
            for v in set {
                if values[k].len() < MAX_FIELD_VALUES {
                    values[k].insert(v.into_owned());
                } else if !values[k].contains(v.as_ref()) {
                    more[k] = true;
                }
            }
        }
        if start_timestamp.is_none() {
            start_timestamp = p.first_ts.map(Cow::into_owned);
        }
        if let Some(ts) = p.last_ts {
            stop_timestamp = Some(ts.into_owned());
        }
    }

    let fields = plan
        .fields
        .iter()
        .zip(values.into_iter().zip(more))
        .map(|(&f, (set, more))| {
            let mut values: Vec<String> = set.into_iter().collect();
            sort_natural(&mut values);
            FieldValues { name: defs[f].name.clone(), label: defs[f].label.clone(), values, more }
        })
        .collect();

    let ms = |ts: &Option<String>| ts.as_deref().and_then(|t| format.value_time_ns(t)).map(|ns| ns as f64 / 1e6);
    LogSummary {
        total_lines,
        line_count: file.line_count(),
        levels,
        fields,
        start_ms: ms(&start_timestamp),
        stop_ms: ms(&stop_timestamp),
        start_timestamp,
        stop_timestamp,
        format: FormatInfo {
            pattern: format.pattern().to_string(),
            detected: true,
            raw: format.is_raw(),
            sample_lines: 0,
            sample_matched: 0,
            columns: defs.to_vec(),
        },
    }
}

/// Sort numbers by value (thread ids), everything else alphabetically, numbers first.
fn sort_natural(v: &mut [String]) {
    v.sort_by(|a, b| match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(x), Ok(y)) => x.cmp(&y),
        (Ok(_), Err(_)) => std::cmp::Ordering::Less,
        (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
        _ => a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parsing::format::LEGACY_PATTERN;

    fn legacy() -> Arc<LogFormat> {
        Arc::new(LogFormat::compile(LEGACY_PATTERN).unwrap())
    }

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
        let fmt = legacy();
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
                    .filter(|(_, l)| filter.matches(&fmt, l))
                    .map(|(i, _)| i as u64)
                    .collect();
                let ms = scan_matches(&file, &CompiledFilter::new(filter, fmt.clone()), &AtomicBool::new(false))
                    .unwrap_or_else(|_| panic!("cancelled"));
                assert_eq!(ms.line_numbers(0, usize::MAX), expected, "chunk {chunk_size}");
            }
        }
    }

    #[test]
    fn thread_filter_on_another_format() {
        let mut text = String::new();
        for i in 0..500 {
            text.push_str(&format!(
                "2026-11-20 10:00:00.{:03} [{}] [{}] msg {i}\n",
                i % 1000,
                100 + i % 4,
                ["info", "warn"][i % 2]
            ));
        }
        let fmt = Arc::new(LogFormat::compile("%Y-%m-%d %H:%M:%S.%e [%t] [%l] %v").unwrap());
        let file = LogFile::from_test_bytes(text.as_bytes(), 512);
        let f = LineFilter::from_query(Some("warn"), Some(r#"{"thread":["101","103"]}"#), None).unwrap();
        let ms = scan_matches(&file, &CompiledFilter::new(f, fmt.clone()), &AtomicBool::new(false))
            .unwrap_or_else(|_| panic!("cancelled"));
        assert_eq!(ms.match_count(), 250);
        let s = summarize(&file, &fmt);
        assert_eq!(s.total_lines, 500);
        assert_eq!(s.fields.len(), 1);
        assert_eq!(s.fields[0].name, "thread");
        assert_eq!(s.fields[0].values, ["100", "101", "102", "103"]);
        assert_eq!(s.start_timestamp.as_deref(), Some("2026-11-20 10:00:00.000"));
    }

    /// A log over 2 hours, mostly in time order with some lines a few seconds back, stack
    /// trace lines, a stretch without any timestamps and a format line with a bad time.
    fn timed_sample() -> String {
        let mut s = String::new();
        let mut x = 99u64;
        let mut sec = 0i64;
        for i in 0..6000 {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            if (2000..2300).contains(&i) {
                s.push_str("    at a stack trace line\n");
                continue;
            }
            if i % 37 == 0 {
                s.push_str("    at frame BOOM\n");
            }
            if i == 4321 {
                s.push_str("[not a time] [ERROR] [core] BOOM\n");
            }
            sec = (sec + ((x >> 40) % 3) as i64).min(7199);
            let t = if (x >> 20) % 13 == 0 { (sec - 5).max(0) } else { sec };
            let level = ["INFO", "WARN", "ERROR", "DEBUG"][((x >> 30) % 4) as usize];
            let msg = if (x >> 10) % 7 == 0 { "BOOM" } else { "fine" };
            s.push_str(&format!("[2025-01-01 {:02}:{:02}:{:02}.{:03}] [{level}] [core] {msg} {i}\n", t / 3600, t / 60 % 60, t % 60, i % 1000));
        }
        s
    }

    fn ms_of(h: i64, m: i64, s: i64) -> f64 {
        ((crate::logfile::timeline::days_from_civil(2025, 1, 1) * 86_400 + h * 3600 + m * 60 + s) * 1000) as f64
    }

    #[test]
    fn time_range_scan_equals_sequential_filter_and_skips_chunks() {
        let text = timed_sample();
        let fmt = legacy();
        for chunk_size in [64, 2048, 1 << 20] {
            let file = LogFile::from_test_bytes(text.as_bytes(), chunk_size);
            let levels = Arc::new(crate::logfile::levels::LevelIndex::build(&file, &fmt));
            let ranges = [
                (Some(ms_of(0, 10, 0)), Some(ms_of(0, 20, 0))),
                (Some(ms_of(0, 59, 59)), Some(ms_of(1, 0, 1))),
                (None, Some(ms_of(0, 5, 0))),
                (Some(ms_of(1, 50, 0)), None),
                // nothing in it: after the end, just before the start, between two lines
                (Some(ms_of(3, 0, 0)), Some(ms_of(4, 0, 0))),
                (Some(ms_of(0, 0, 0) - 10_000.0), Some(ms_of(0, 0, 0))),
                (Some(ms_of(0, 30, 0) + 0.25), Some(ms_of(0, 30, 0) + 0.75)),
            ];
            for (from, to) in ranges {
                for (lv, kw) in [(None, None), (Some("ERROR"), None), (None, Some("BOOM")), (Some("WARN,INFO"), Some("fine"))] {
                    let filter = LineFilter::from_csv(lv, None, kw).with_time_ms(from, to).unwrap();
                    let expected: Vec<u64> = text
                        .lines()
                        .enumerate()
                        .filter(|(_, l)| filter.matches(&fmt, l))
                        .map(|(i, _)| i as u64)
                        .collect();
                    let plain = CompiledFilter::new(filter.clone(), fmt.clone());
                    let skipping = CompiledFilter::new(filter.clone(), fmt.clone()).with_chunk_spans(levels.clone());
                    let what = format!("chunk {chunk_size} {from:?}..{to:?} {lv:?} {kw:?}");
                    for f in [&plain, &skipping] {
                        let ms = scan_matches(&file, f, &AtomicBool::new(false)).unwrap_or_else(|_| panic!("cancelled"));
                        assert_eq!(ms.line_numbers(0, usize::MAX), expected, "{what}");
                        let mut streamed = Vec::new();
                        scan_streaming(&file, f, |r| {
                            append_ranges(&mut streamed, r.to_vec());
                            Ok::<(), ()>(())
                        })
                        .unwrap();
                        assert_eq!(streamed, ms.ranges(), "{what} streaming");
                    }
                    // every skipped chunk really has no line in the range
                    for (i, chunk) in file.chunks().iter().enumerate() {
                        if !skipping.chunk_may_match(i) {
                            let first = chunk.first_line;
                            assert!(expected.iter().all(|&l| l < first || l >= first + chunk.line_count), "{what} chunk {i}");
                        }
                    }
                }
            }
            // a narrow range in small chunks reads only a few of them
            if chunk_size == 2048 {
                let f = CompiledFilter::new(LineFilter::default().with_time_ms(Some(ms_of(0, 10, 0)), Some(ms_of(0, 11, 0))).unwrap(), fmt.clone())
                    .with_chunk_spans(levels.clone());
                let read = (0..file.chunks().len()).filter(|&i| f.chunk_may_match(i)).count();
                assert!(file.chunks().len() > 50 && read <= 4, "{read} of {} chunks", file.chunks().len());
            }
        }
    }

    #[test]
    fn time_range_bounds_and_validation() {
        let fmt = legacy();
        let at = |s: &str| format!("[2025-01-01 00:00:{s}] [INFO] [core] m");
        let f = LineFilter::default().with_time_ms(Some(ms_of(0, 0, 10)), Some(ms_of(0, 0, 20))).unwrap();
        // from included, to excluded, millisecond precision
        assert!(!f.matches(&fmt, &at("09.999")));
        assert!(f.matches(&fmt, &at("10.000")));
        assert!(f.matches(&fmt, &at("19.999")));
        assert!(!f.matches(&fmt, &at("20.000")));
        // no timestamp: never in a time range
        assert!(!f.matches(&fmt, "[soon] [INFO] [core] m"));
        assert!(!f.matches(&fmt, "    at frame"));
        assert!(!f.is_empty());
        assert!(LineFilter::default().with_time_ms(None, None).unwrap().is_empty());
        assert!(LineFilter::default().with_time_ms(Some(5.0), Some(5.0)).is_err());
        assert!(LineFilter::default().with_time_ms(Some(6.0), Some(5.0)).is_err());
        assert!(LineFilter::default().with_time_ms(Some(f64::NAN), None).is_err());
        assert_eq!(LineFilter::default().with_time_ms(None, Some(1.0)).unwrap().time, Some((i64::MIN, 1_000_000)));
        // a format without a time field matches nothing in a range
        let no_time = Arc::new(LogFormat::compile("[%l] %v").unwrap());
        let file = LogFile::from_test_bytes(b"[INFO] a\n[ERROR] b\n", 64);
        let levels = Arc::new(crate::logfile::levels::LevelIndex::build(&file, &no_time));
        let c = CompiledFilter::new(f.clone(), no_time).with_chunk_spans(levels);
        assert_eq!(scan_matches(&file, &c, &AtomicBool::new(false)).unwrap_or_else(|_| panic!()).match_count(), 0);
    }

    #[test]
    fn cancelled_scan_returns_error() {
        let text = sample();
        let file = LogFile::from_test_bytes(text.as_bytes(), 64);
        let f = CompiledFilter::new(LineFilter::default(), legacy());
        assert!(scan_matches(&file, &f, &AtomicBool::new(true)).is_err());
    }

    #[test]
    fn summary_counts_levels_domains_and_times() {
        let text = sample();
        let file = LogFile::from_test_bytes(text.as_bytes(), 256);
        let s = summarize(&file, &legacy());
        assert_eq!(s.total_lines, 3000);
        assert_eq!(s.line_count, text.lines().count() as u64);
        assert_eq!(s.levels.len(), 4);
        assert_eq!(s.levels["INFO"], 750);
        assert_eq!(s.fields.len(), 1);
        assert_eq!(s.fields[0].name, "domain");
        assert_eq!(s.fields[0].values, ["core", "net", "ui"]);
        assert!(!s.fields[0].more);
        assert_eq!(s.start_timestamp.as_deref(), Some("2025-01-01 00:00:00"));
        assert_eq!(s.stop_timestamp.as_deref(), Some("2025-01-01 00:00:59"));
    }

    #[test]
    fn field_values_are_capped() {
        let mut text = String::new();
        for i in 0..(MAX_FIELD_VALUES + 50) {
            text.push_str(&format!("[t] [INFO] [d{i}] m\n"));
        }
        let file = LogFile::from_test_bytes(text.as_bytes(), 1024);
        let s = summarize(&file, &legacy());
        assert_eq!(s.fields[0].values.len(), MAX_FIELD_VALUES);
        assert!(s.fields[0].more);
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
        let sample = crate::logfile::index::sample_lines(&file);
        let mut fmt = Arc::new(crate::parsing::format::detect(&sample.iter().map(|s| s.as_str()).collect::<Vec<_>>()).format);
        if let Some(p) = std::env::var("LOGFILE_PATTERN").ok().filter(|p| !p.is_empty()) {
            fmt = Arc::new(LogFormat::compile(&p).unwrap());
        }
        println!("detect: {:.1} ms, format {}", ms(t.elapsed()), fmt.pattern());
        let t = Instant::now();
        let s = summarize(&file, &fmt);
        println!("summary: {:.0} ms ({} log lines, {} levels)", ms(t.elapsed()), s.total_lines, s.levels.len());

        let no_cancel = AtomicBool::new(false);
        for (name, lv, dm, kw) in [
            ("rare keyword", None, None, Some("RAREFAILURE")),
            ("common keyword", None, None, Some("failed")),
            ("level ERROR", Some("ERROR"), None, None),
            ("level error", Some("error"), None, None),
            ("level+domain", Some("ERROR,WARN"), Some("network"), None),
            ("no filter", None, None, None),
        ] {
            let t = Instant::now();
            let m = scan_matches(&file, &CompiledFilter::new(LineFilter::from_csv(lv, dm, kw), fmt.clone()), &no_cancel)
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

        let t = Instant::now();
        let lv = Arc::new(crate::logfile::levels::LevelIndex::build(&file, &fmt));
        println!("level index: {:.0} ms", ms(t.elapsed()));
        let errors = scan_matches(&file, &CompiledFilter::new(LineFilter::from_csv(Some("ERROR"), None, None), fmt.clone()), &no_cancel)
            .unwrap_or_else(|_| panic!("cancelled"));

        // time ranges: a window in the middle of the span, alone and with a level filter
        if let Some((t0, t1)) = lv.time_span() {
            let span_ms = (t1 - t0) as f64 / 1e6;
            let mid = t0 as f64 / 1e6 + span_ms / 2.0;
            for (name, frac) in [("50%", 0.5), ("10%", 0.1), ("1%", 0.01), ("0.01%", 0.0001)] {
                for (what, level) in [("all levels", None), ("ERROR", Some("ERROR"))] {
                    let filter = LineFilter::from_csv(level, None, None)
                        .with_time_ms(Some(mid - span_ms * frac / 2.0), Some(mid + span_ms * frac / 2.0))
                        .unwrap();
                    let skipping = CompiledFilter::new(filter.clone(), fmt.clone()).with_chunk_spans(lv.clone());
                    let read = (0..file.chunks().len()).filter(|&i| skipping.chunk_may_match(i)).count();
                    let t = Instant::now();
                    let m = scan_matches(&file, &skipping, &no_cancel).unwrap_or_else(|_| panic!("cancelled"));
                    let fast = ms(t.elapsed());
                    let t = Instant::now();
                    let full = scan_matches(&file, &CompiledFilter::new(filter, fmt.clone()), &no_cancel).unwrap_or_else(|_| panic!("cancelled"));
                    assert_eq!(m.ranges(), full.ranges());
                    println!(
                        "time range {name:>5} {what:10}: {fast:6.0} ms reading {read}/{} chunks (all chunks: {:6.0} ms), {} matches",
                        file.chunks().len(),
                        ms(t.elapsed()),
                        m.match_count()
                    );
                }
            }
            let t = Instant::now();
            let mut found = 0;
            for i in 0..20 {
                let at = t0 + (t1 - t0) / 20 * i;
                found += crate::logfile::timeline::first_line_at_or_after(&file, &lv, &fmt, at).is_some() as u32;
            }
            println!("jump to time: {:.2} ms per lookup ({found}/20 found)", ms(t.elapsed()) / 20.0);
        }
        for n in [1000u64, 4000, 16384] {
            let t = Instant::now();
            let b = lv.buckets(n);
            let all = ms(t.elapsed());
            let t = Instant::now();
            let f = lv.buckets_in(n, errors.ranges());
            println!("minimap {n:5} buckets: all {all:.2} ms, ERROR filter {:.2} ms ({} / {})", ms(t.elapsed()), b.len(), f.len());
        }

        let t = Instant::now();
        let tb = crate::logfile::timeline::TimeBins::build_all(&file, &lv, &fmt);
        println!("time bins, all lines: {:.0} ms ({} timed lines)", ms(t.elapsed()), tb.timed_lines);
        let t = Instant::now();
        let tf = crate::logfile::timeline::TimeBins::build_ranges(&file, &lv, &fmt, errors.ranges());
        println!("time bins, ERROR filter: {:.0} ms ({} timed lines)", ms(t.elapsed()), tf.timed_lines);
        let t = Instant::now();
        let _ = tb.columns(4000);
        println!("time columns 4000: {:.2} ms", ms(t.elapsed()));

        if let Some(field) = fmt.field_index("domain") {
            use crate::logfile::categories::{CategoryIndex, CategoryTimeBins};
            let t = Instant::now();
            let ci = CategoryIndex::build(&file, &fmt, field);
            println!(
                "domain index: {:.0} ms ({} top groups, {} other groups)",
                ms(t.elapsed()),
                ci.top.len(),
                ci.other_groups
            );
            for n in [1000u64, 4000, 16384] {
                let t = Instant::now();
                let b = ci.buckets(n);
                let all = ms(t.elapsed());
                let t = Instant::now();
                let f = ci.buckets_in(n, errors.ranges());
                println!("domain minimap {n:5} buckets: all {all:.2} ms, ERROR filter {:.2} ms ({} / {})", ms(t.elapsed()), b.len(), f.len());
            }
            let t = Instant::now();
            let _ = CategoryTimeBins::build_all(&file, &lv, &ci, &fmt);
            println!("domain time bins, all lines: {:.0} ms", ms(t.elapsed()));
            let t = Instant::now();
            let cb = CategoryTimeBins::build_ranges(&file, &lv, &ci, &fmt, errors.ranges());
            println!("domain time bins, ERROR filter: {:.0} ms", ms(t.elapsed()));
            let t = Instant::now();
            let _ = cb.columns(4000);
            println!("domain time columns 4000: {:.2} ms", ms(t.elapsed()));
        }

        if let Some(field) = fmt.field_index("thread") {
            use crate::logfile::lanes::{LaneBins, LaneIndex};
            let t = Instant::now();
            let li = LaneIndex::build(&file, &lv, &fmt, field);
            println!(
                "thread lane index: {:.0} ms ({} lanes, {} in other)",
                ms(t.elapsed()),
                li.lanes.lanes.len(),
                li.lanes.other_values
            );
            let t = Instant::now();
            let _ = li.bins.columns(3000);
            println!("thread lane columns 3000: {:.2} ms", ms(t.elapsed()));
            let span = li.bins.span;
            for (name, div) in [("1/100 of the span", 100i64), ("1/10000 of the span", 10_000)] {
                let mid = span.0 + (span.1 - span.0) / 2;
                let w = (mid, mid + (span.1 - span.0) / div);
                let t = Instant::now();
                let lines = li.window_lines(w, file.line_count());
                let b = LaneBins::build_window(&file, &lv, &fmt, field, &li.lanes, w, &lines.into_iter().collect::<Vec<_>>());
                println!("thread lane window {name}: {:.0} ms ({} lines read, {} in window)", ms(t.elapsed()), lines.map_or(0, |l| l.1 - l.0), b.timed_lines);
            }
            let t = Instant::now();
            let b = LaneBins::build_window(&file, &lv, &fmt, field, &li.lanes, span, errors.ranges());
            println!("thread lanes, ERROR filter: {:.0} ms ({} lines)", ms(t.elapsed()), b.timed_lines);
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
