//! Log levels over time, for the minimap's "by time" axis.
//!
//! The file's time span (earliest to latest timestamp, found while the
//! [`LevelIndex`](crate::logfile::levels::LevelIndex) is built) is split into
//! [`FINE_BUCKETS`] equal slices. One parallel pass puts every log line into the slice of
//! its timestamp and keeps, per slice, the most severe level and the first line number.
//! The minimap's pixel columns are then merged from these slices, so resizing never
//! rescans the file. Nothing is stored per line, and the lines need not be in time order.
//!
//! The pass over all lines is cached per session; the pass over a filter's matches reads
//! only the matching lines and is cached with the filter result.
//!
//! Lines without a parseable timestamp (stack traces, formats without a time) are left out.
//! Line numbers in this module are 0-based.

use crate::logfile::index::LogFile;
use crate::logfile::levels::{code, LevelIndex};
use crate::logfile::view::{View, ViewLines};
use crate::parsing::format::LogFormat;
use rayon::prelude::*;
use std::time::{Duration, Instant};

/// Time slices computed per pass; the minimap merges them into its pixel columns.
pub const FINE_BUCKETS: usize = 16_384;

/// Parse the timestamp of a log line, `YYYY-MM-DD HH:MM:SS[.fraction]` (also with `T`
/// between date and time, and `,` before the fraction), as nanoseconds since
/// 1970-01-01 in the log's own clock. Time zones are not interpreted. Anything after the
/// fraction (a zone, `Z`) is ignored.
pub fn parse_timestamp(ts: &str) -> Option<i64> {
    let b = ts.trim().as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let mut v = 0i64;
        for &c in &b[r] {
            if !c.is_ascii_digit() {
                return None;
            }
            v = v * 10 + (c - b'0') as i64;
        }
        Some(v)
    };
    if b[4] != b'-' || b[7] != b'-' || !(b[10] == b' ' || b[10] == b'T') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let mut nanos = 0i64;
    if b.len() > 20 && (b[19] == b'.' || b[19] == b',') {
        let mut scale = 100_000_000i64;
        for &c in b[20..].iter().take_while(|c| c.is_ascii_digit()).take(9) {
            nanos += (c - b'0') as i64 * scale;
            scale /= 10;
        }
    }
    let days = days_from_civil(y, mo, d);
    Some(((days * 86_400 + h * 3600 + mi * 60 + s) * 1_000_000_000) + nanos)
}

/// Days since 1970-01-01 of a date (Howard Hinnant's `days_from_civil`).
pub fn days_from_civil(y: i64, mo: i64, d: i64) -> i64 {
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Most severe level and first line per time slice.
pub struct TimeBins {
    /// Most severe level code per slice ([`code::NONE`] for an empty slice)
    pub levels: Vec<u8>,
    /// First (lowest) line per slice, `u64::MAX` for an empty slice
    pub first_line: Vec<u64>,
    /// Lines placed in a slice
    pub timed_lines: u64,
    pub build_time: Duration,
}

impl TimeBins {
    fn empty() -> Self {
        Self {
            levels: vec![code::NONE; FINE_BUCKETS],
            first_line: vec![u64::MAX; FINE_BUCKETS],
            timed_lines: 0,
            build_time: Duration::ZERO,
        }
    }

    fn merge(mut self, other: Self) -> Self {
        for i in 0..FINE_BUCKETS {
            self.levels[i] = self.levels[i].max(other.levels[i]);
            self.first_line[i] = self.first_line[i].min(other.first_line[i]);
        }
        self.timed_lines += other.timed_lines;
        self
    }

    fn add(&mut self, span: (i64, i64), line: u64, ts: i64, level: u8) {
        let (t0, t1) = span;
        let width = (t1 - t0) as i128 + 1;
        let i = (((ts - t0) as i128 * FINE_BUCKETS as i128) / width).clamp(0, FINE_BUCKETS as i128 - 1) as usize;
        self.levels[i] = self.levels[i].max(level);
        self.first_line[i] = self.first_line[i].min(line);
        self.timed_lines += 1;
    }

    /// Bin every log line of the file.
    pub fn build_all(file: &LogFile, levels: &LevelIndex, format: &LogFormat) -> Self {
        let started = Instant::now();
        let Some(span) = levels.time_span() else {
            return Self::empty();
        };
        let mut bins = file
            .chunks()
            .par_iter()
            .fold(Self::empty, |mut acc, chunk| {
                for (line, bytes) in file.chunk_lines(chunk) {
                    let c = levels.code(line);
                    if c == code::NONE {
                        continue;
                    }
                    if let Some(ts) = format.time_of(bytes) {
                        acc.add(span, line, ts, c);
                    }
                }
                acc
            })
            .reduce(Self::empty, Self::merge);
        bins.build_time = started.elapsed();
        bins
    }

    /// Bin only the lines in `ranges` (sorted, disjoint half-open line ranges), reading
    /// just those lines.
    pub fn build_ranges(file: &LogFile, levels: &LevelIndex, format: &LogFormat, ranges: &[(u64, u64)]) -> Self {
        let started = Instant::now();
        let Some(span) = levels.time_span() else {
            return Self::empty();
        };
        let view = View::build(ranges, 0, file.line_count());
        const BLOCK: u64 = 256 * 1024;
        let blocks: Vec<u64> = (0..view.row_count()).step_by(BLOCK as usize).collect();
        let mut bins = blocks
            .par_iter()
            .fold(Self::empty, |mut acc, &first| {
                let n = BLOCK.min(view.row_count() - first);
                for (_, line, bytes) in ViewLines::new(file, &view, first, n) {
                    let c = levels.code(line);
                    if c == code::NONE {
                        continue;
                    }
                    if let Some(ts) = format.time_of(bytes) {
                        acc.add(span, line, ts, c);
                    }
                }
                acc
            })
            .reduce(Self::empty, Self::merge);
        bins.build_time = started.elapsed();
        bins
    }

    /// Merge the slices into `n` (at most [`FINE_BUCKETS`]) equal columns:
    /// `(most severe level, first line or u64::MAX)` per column.
    pub fn columns(&self, n: usize) -> (Vec<u8>, Vec<u64>) {
        let n = n.clamp(1, FINE_BUCKETS);
        (0..n)
            .map(|j| {
                let (lo, hi) = (j * FINE_BUCKETS / n, (j + 1) * FINE_BUCKETS / n);
                let lv = self.levels[lo..hi].iter().copied().max().unwrap_or(code::NONE);
                let fl = self.first_line[lo..hi].iter().copied().min().unwrap_or(u64::MAX);
                (lv, fl)
            })
            .unzip()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timestamps() {
        let base = parse_timestamp("1970-01-01 00:00:00").unwrap();
        assert_eq!(base, 0);
        assert_eq!(parse_timestamp("1970-01-02T00:00:01").unwrap(), 86_401 * 1_000_000_000);
        assert_eq!(parse_timestamp("2000-03-01 00:00:00").unwrap(), 951_868_800 * 1_000_000_000);
        assert_eq!(parse_timestamp("1970-01-01 00:00:00.5").unwrap(), 500_000_000);
        assert_eq!(parse_timestamp("1970-01-01 00:00:00,000001").unwrap(), 1_000);
        assert_eq!(parse_timestamp("1970-01-01 00:00:00.123456789123").unwrap(), 123_456_789);
        assert_eq!(parse_timestamp("1969-12-31 23:59:59").unwrap(), -1_000_000_000);
        assert!(parse_timestamp("2025-13-01 00:00:00").is_none());
        assert!(parse_timestamp("not a time at all!!").is_none());
        assert!(parse_timestamp("12:00:00").is_none());
    }

    fn legacy() -> LogFormat {
        LogFormat::compile(crate::parsing::format::LEGACY_PATTERN).unwrap()
    }

    fn file(text: &str) -> (LogFile, LevelIndex) {
        let f = LogFile::from_test_bytes(text.as_bytes(), 64);
        let l = LevelIndex::build(&f, &legacy());
        (f, l)
    }

    #[test]
    fn bins_by_time_not_by_line() {
        // 3 lines in the first second, 1 line 99 s later: the gap is empty
        let (f, l) = file(
            "[2025-01-01 00:00:00] [INFO] [a] x\n\
             [2025-01-01 00:00:00.5] [ERROR] [a] x\n\
             \tat stack.Frame\n\
             [2025-01-01 00:00:01] [INFO] [a] x\n\
             [2025-01-01 00:01:40] [WARN] [a] x\n",
        );
        assert_eq!(l.time_span().map(|(a, b)| (b - a) / 1_000_000_000), Some(100));
        let bins = TimeBins::build_all(&f, &l, &legacy());
        assert_eq!(bins.timed_lines, 4);
        let (lv, first) = bins.columns(100);
        assert_eq!(lv[0], code::ERROR);
        assert_eq!(first[0], 0);
        assert_eq!(lv[1], code::INFO);
        assert_eq!(first[1], 3);
        assert!(lv[2..99].iter().all(|&c| c == code::NONE));
        assert!(first[2..99].iter().all(|&c| c == u64::MAX));
        assert_eq!((lv[99], first[99]), (code::WARN, 4));

        // only line 3 and 4
        let only = TimeBins::build_ranges(&f, &l, &legacy(), &[(3, 5)]);
        let (lv, first) = only.columns(100);
        assert_eq!((lv[0], lv[1], first[1], lv[99]), (code::NONE, code::INFO, 3, code::WARN));
    }

    #[test]
    fn out_of_order_lines_and_columns_agree_with_naive_binning() {
        let mut s = String::new();
        let mut x = 17u64;
        let mut lines = Vec::new();
        for i in 0..3000u64 {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let sec = (x >> 33) % 7200;
            let lvl = ["DEBUG", "INFO", "WARN", "ERROR"][((x >> 20) % 4) as usize];
            s.push_str(&format!("[2025-01-01 {:02}:{:02}:{:02}] [{lvl}] [d] m{i}\n", sec / 3600, sec / 60 % 60, sec % 60));
            lines.push(sec);
        }
        let (f, l) = file(&s);
        let bins = TimeBins::build_all(&f, &l, &legacy());
        let (lo, hi) = (*lines.iter().min().unwrap() as i128, *lines.iter().max().unwrap() as i128);
        let ns = 1_000_000_000i128;
        let mut want = vec![u64::MAX; FINE_BUCKETS];
        for (i, &sec) in lines.iter().enumerate() {
            let b = ((sec as i128 - lo) * ns * FINE_BUCKETS as i128 / ((hi - lo) * ns + 1)) as usize;
            want[b] = want[b].min(i as u64);
        }
        assert_eq!(bins.first_line, want);
        assert_eq!(bins.timed_lines, 3000);
        let (lv, first) = bins.columns(1000);
        assert_eq!(lv.len(), 1000);
        assert_eq!(first.iter().filter(|&&f| f != u64::MAX).min(), Some(&0));
    }
}
