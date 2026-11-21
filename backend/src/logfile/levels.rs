//! Per-line log levels for the minimap.
//!
//! A [`LevelIndex`] stores a small severity code for every line of the file, packed two
//! lines per byte (half a byte per line: 50 MB for 100 million lines), plus the most
//! severe code of every [`BLOCK`] lines. It is built once per file, in parallel over the
//! index chunks, the first time the minimap asks for it.
//!
//! [`LevelIndex::buckets`] then splits the line range into `n` equal buckets (one per
//! pixel column of the minimap) and returns the most severe level in each, either over
//! all lines or only over the lines of a filter result. Whole blocks inside a bucket are
//! read from the block maxima, so the cost does not grow with the bucket size.
//!
//! Line numbers in this module are 0-based.

use crate::logfile::index::LogFile;
use crate::logfile::scan::{finish_summary, line_text, PartialSummary, SummaryPlan};
use crate::model::log_summary::LogSummary;
use crate::parsing::format::LogFormat;
use rayon::prelude::*;
use std::time::{Duration, Instant};

/// Lines per block of the block maxima.
pub const BLOCK: u64 = 64;

/// Severity codes, ordered so that a larger code is more severe.
pub mod code {
    /// Not a line in the log format (stack traces, banners, ...)
    pub const NONE: u8 = 0;
    /// A log line with a level that is not one of the known ones
    pub const OTHER: u8 = 1;
    pub const TRACE: u8 = 2;
    pub const DEBUG: u8 = 3;
    pub const INFO: u8 = 4;
    pub const WARN: u8 = 5;
    pub const ERROR: u8 = 6;
    pub const CRITICAL: u8 = 7;
    /// The most severe code
    pub const MAX: u8 = CRITICAL;
}

/// Severity code of a level name. Common aliases (and spdlog's one-letter `%L` names)
/// map to the six known levels. CRITICAL (and FATAL) is its own level above ERROR, as
/// in the level filter, so the summary, minimap and lanes agree with the filter chips.
pub fn level_code(level: &str) -> u8 {
    let l = level.trim();
    let is = |s: &str| l.eq_ignore_ascii_case(s);
    if is("CRITICAL") || is("CRIT") || is("FATAL") || is("C") || is("F") {
        code::CRITICAL
    } else if is("ERROR") || is("ERR") || is("SEVERE") || is("E") {
        code::ERROR
    } else if is("WARN") || is("WARNING") || is("W") {
        code::WARN
    } else if is("INFO") || is("NOTICE") || is("I") {
        code::INFO
    } else if is("DEBUG") || is("DBG") || is("D") {
        code::DEBUG
    } else if is("TRACE") || is("VERBOSE") || is("T") || is("V") {
        code::TRACE
    } else {
        code::OTHER
    }
}

pub struct LevelIndex {
    /// Two lines per byte: even lines in the low half, odd lines in the high half.
    packed: Vec<u8>,
    /// Most severe code of lines `i * BLOCK .. (i + 1) * BLOCK`.
    blocks: Vec<u8>,
    line_count: u64,
    /// Earliest and latest parseable timestamp of a log line (ns, see
    /// [`parse_timestamp`](crate::logfile::timeline::parse_timestamp))
    time_span: Option<(i64, i64)>,
    /// Earliest and latest timestamp per index chunk of the file (same order as
    /// [`LogFile::chunks`]), `None` for a chunk without timestamps. A time range filter
    /// skips the chunks outside it, and jumping to a time finds its chunk from these.
    chunk_spans: Vec<Option<(i64, i64)>>,
    pub build_time: Duration,
}

impl LevelIndex {
    pub fn build(file: &LogFile, format: &LogFormat) -> Self {
        Self::build_inner(file, format, None).0
    }

    /// Build the index and the file's summary in the same pass over the file (each
    /// line is parsed once for both). The viewer opens a file with this, in the
    /// background, so the summary, the minimap and the unfiltered view all wait for one
    /// pass instead of three.
    pub fn build_with_summary(file: &LogFile, format: &LogFormat) -> (Self, LogSummary) {
        let plan = SummaryPlan::new(format);
        let (idx, parts) = Self::build_inner(file, format, Some(&plan));
        let summary = finish_summary(file, format, &plan, parts);
        (idx, summary)
    }

    fn build_inner<'a>(file: &'a LogFile, format: &LogFormat, plan: Option<&SummaryPlan>) -> (Self, Vec<PartialSummary<'a>>) {
        let started = Instant::now();
        let line_count = file.line_count();
        let level_field = format.level_field();

        // Each chunk packs its own lines. A chunk starting on an odd line leaves the low
        // half of its first byte empty, so neighbouring chunks are merged with OR.
        type Part<'a> = (usize, Vec<u8>, Option<(i64, i64)>, Option<PartialSummary<'a>>);
        let parts: Vec<Part<'a>> = file
            .chunks()
            .par_iter()
            .map(|chunk| {
                let first = chunk.first_line;
                let mut out = Vec::with_capacity((chunk.line_count / 2 + 2) as usize);
                let mut byte = 0u8;
                let mut line = first;
                let mut span: Option<(i64, i64)> = None;
                let mut summary = plan.map(PartialSummary::new);
                for (_, bytes) in file.chunk_lines(chunk) {
                    // the same field split as the summary and the filter
                    let text = line_text(bytes);
                    let (c, ts) = match format.parse(&text) {
                        None => (code::NONE, None),
                        Some(p) => {
                            if let (Some(plan), Some(s)) = (plan, summary.as_mut()) {
                                s.add_parsed(plan, &text, &p);
                            }
                            let c = level_field.map_or(code::OTHER, |l| level_code(p.get(&text, l)));
                            (c, format.time_ns(&text, &p))
                        }
                    };
                    if let Some(ts) = ts {
                        span = Some(span.map_or((ts, ts), |(a, b)| (a.min(ts), b.max(ts))));
                    }
                    if line % 2 == 0 {
                        byte = c;
                    } else {
                        out.push(byte | (c << 4));
                        byte = 0;
                    }
                    line += 1;
                }
                if line % 2 == 1 {
                    out.push(byte); // a final even line
                }
                // when the chunk starts on an odd line, its first value went into the
                // high half of the byte `first / 2` (whose low half is the previous chunk's)
                ((first / 2) as usize, out, span, summary)
            })
            .collect();

        let mut packed = vec![0u8; line_count.div_ceil(2) as usize];
        let mut time_span: Option<(i64, i64)> = None;
        let mut chunk_spans = Vec::with_capacity(parts.len());
        let mut summaries = Vec::new();
        for (at, bytes, span, summary) in parts {
            chunk_spans.push(span);
            summaries.extend(summary);
            if let Some((a, b)) = span {
                time_span = Some(time_span.map_or((a, b), |(x, y)| (x.min(a), y.max(b))));
            }
            for (i, b) in bytes.into_iter().enumerate() {
                packed[at + i] |= b;
            }
        }

        let mut blocks = vec![0u8; line_count.div_ceil(BLOCK) as usize];
        let per_block = (BLOCK / 2) as usize;
        blocks
            .par_iter_mut()
            .zip(packed.par_chunks(per_block))
            .for_each(|(m, bytes)| {
                *m = bytes.iter().fold(0u8, |acc, &b| acc.max(b & 0x0f).max(b >> 4));
            });

        (Self { packed, blocks, line_count, time_span, chunk_spans, build_time: started.elapsed() }, summaries)
    }

    /// The lines in the log format (code other than [`code::NONE`]) as sorted, disjoint,
    /// non-adjacent half-open ranges: the unfiltered view, without scanning the file again.
    pub fn format_ranges(&self) -> Vec<(u64, u64)> {
        // in parallel over slices of whole bytes (an even number of lines each)
        const PART_BYTES: usize = 1 << 20;
        let parts: Vec<Vec<(u64, u64)>> = self
            .packed
            .par_chunks(PART_BYTES)
            .enumerate()
            .map(|(k, bytes)| {
                let first = (k * PART_BYTES * 2) as u64;
                let end = (first + bytes.len() as u64 * 2).min(self.line_count);
                let mut ranges: Vec<(u64, u64)> = Vec::new();
                let mut run: Option<u64> = None;
                for line in first..end {
                    let b = bytes[((line - first) / 2) as usize];
                    let c = if line % 2 == 0 { b & 0x0f } else { b >> 4 };
                    match (c != code::NONE, run) {
                        (true, None) => run = Some(line),
                        (false, Some(s)) => {
                            ranges.push((s, line));
                            run = None;
                        }
                        _ => {}
                    }
                }
                if let Some(s) = run {
                    ranges.push((s, end));
                }
                ranges
            })
            .collect();
        let mut ranges: Vec<(u64, u64)> = Vec::new();
        for part in parts {
            for r in part {
                match ranges.last_mut() {
                    Some(last) if last.1 == r.0 => last.1 = r.1,
                    _ => ranges.push(r),
                }
            }
        }
        ranges
    }

    pub fn line_count(&self) -> u64 {
        self.line_count
    }

    /// Earliest and latest timestamp of the log lines, if any has one.
    pub fn time_span(&self) -> Option<(i64, i64)> {
        self.time_span
    }

    /// Earliest and latest timestamp of each index chunk (see the field).
    pub fn chunk_spans(&self) -> &[Option<(i64, i64)>] {
        &self.chunk_spans
    }

    /// Severity code of 0-based `line`.
    pub fn code(&self, line: u64) -> u8 {
        let b = self.packed[(line / 2) as usize];
        if line % 2 == 0 {
            b & 0x0f
        } else {
            b >> 4
        }
    }

    /// Most severe code of lines `start..end`.
    pub fn max_in(&self, start: u64, end: u64) -> u8 {
        let end = end.min(self.line_count);
        if start >= end {
            return code::NONE;
        }
        let first_full = start.div_ceil(BLOCK);
        let last_full = end / BLOCK; // exclusive
        if first_full >= last_full {
            return (start..end).map(|l| self.code(l)).max().unwrap_or(code::NONE);
        }
        let head = (start..first_full * BLOCK).map(|l| self.code(l)).max().unwrap_or(0);
        let tail = (last_full * BLOCK..end).map(|l| self.code(l)).max().unwrap_or(0);
        let mid = self.blocks[first_full as usize..last_full as usize]
            .iter()
            .copied()
            .max()
            .unwrap_or(0);
        head.max(mid).max(tail)
    }

    /// Lines `bucket_start(i)..bucket_start(i + 1)` form bucket `i` of `n`.
    fn bucket_start(&self, i: u64, n: u64) -> u64 {
        ((i as u128 * self.line_count as u128) / n as u128) as u64
    }

    /// Number of buckets actually used for a request of `n`: one line per bucket at most.
    pub fn bucket_count(&self, n: u64) -> u64 {
        n.min(self.line_count)
    }

    /// The most severe code in each of `n` equal buckets of the file.
    pub fn buckets(&self, n: u64) -> Vec<u8> {
        let n = self.bucket_count(n);
        (0..n)
            .into_par_iter()
            .map(|i| self.max_in(self.bucket_start(i, n), self.bucket_start(i + 1, n)))
            .collect()
    }

    /// Like [`buckets`](Self::buckets), but counting only the lines in `ranges`
    /// (sorted, disjoint half-open line ranges, e.g. the matches of a filter).
    /// A bucket without any of those lines is [`code::NONE`].
    pub fn buckets_in(&self, n: u64, ranges: &[(u64, u64)]) -> Vec<u8> {
        let n = self.bucket_count(n);
        (0..n)
            .into_par_iter()
            .map(|i| {
                let (bs, be) = (self.bucket_start(i, n), self.bucket_start(i + 1, n));
                let mut j = ranges.partition_point(|r| r.1 <= bs);
                let mut m = code::NONE;
                while let Some(&(s, e)) = ranges.get(j) {
                    if s >= be || m == code::MAX {
                        break;
                    }
                    m = m.max(self.max_in(s.max(bs), e.min(be)));
                    j += 1;
                }
                m
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAMES: [&str; 8] = ["", "CUSTOM", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"];

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
    }

    /// A file whose line `i` has code `codes[i]`.
    fn legacy() -> LogFormat {
        LogFormat::compile(crate::parsing::format::LEGACY_PATTERN).unwrap()
    }

    fn file_of(codes: &[u8], chunk_size: usize) -> LogFile {
        let mut s = String::new();
        for (i, &c) in codes.iter().enumerate() {
            if c == code::NONE {
                s.push_str(&format!("    at some.stack.Frame({i})\n"));
            } else {
                s.push_str(&format!("[2025-01-01 00:00:00] [{}] [core] line {i}\n", NAMES[c as usize]));
            }
        }
        LogFile::from_test_bytes(s.as_bytes(), chunk_size)
    }

    fn reference(codes: &[u8], n: u64, keep: impl Fn(u64) -> bool) -> Vec<u8> {
        let len = codes.len() as u64;
        let n = n.min(len);
        (0..n)
            .map(|i| {
                let (s, e) = (i * len / n, (i + 1) * len / n);
                (s..e).filter(|&l| keep(l)).map(|l| codes[l as usize]).max().unwrap_or(0)
            })
            .collect()
    }

    #[test]
    fn level_names() {
        assert_eq!(level_code("ERROR"), code::ERROR);
        assert_eq!(level_code("warning"), code::WARN);
        assert_eq!(level_code("Info"), code::INFO);
        assert_eq!(level_code("FOO"), code::OTHER);
        assert_eq!(level_code("W"), code::WARN);
        assert_eq!(level_code("E"), code::ERROR);
        assert_eq!(level_code("SEVERE"), code::ERROR);
    }

    #[test]
    fn critical_is_its_own_level_above_error() {
        for name in ["critical", "CRITICAL", "Crit", "C", "FATAL", "f"] {
            assert_eq!(level_code(name), code::CRITICAL, "{name}");
        }
        assert!(code::CRITICAL > code::ERROR);
        // fits the half byte per line of the packed index
        assert!(code::MAX < 16);

        // a CRITICAL line is the most severe in its bucket, and kept apart from ERROR
        let mut codes = vec![code::INFO; 300];
        codes[10] = code::ERROR;
        codes[200] = code::CRITICAL;
        let idx = LevelIndex::build(&file_of(&codes, 64), &legacy());
        assert_eq!(idx.code(10), code::ERROR);
        assert_eq!(idx.code(200), code::CRITICAL);
        assert_eq!(idx.buckets(3), [code::ERROR, code::INFO, code::CRITICAL]);
        assert_eq!(idx.buckets_in(3, &[(0, 300)]), [code::ERROR, code::INFO, code::CRITICAL]);
    }

    #[test]
    fn codes_and_buckets_match_a_naive_computation() {
        let mut rng = Lcg(7);
        for case in 0..60 {
            let len = (rng.next() % 3000) as usize;
            // runs of one level, like real logs, plus single outliers
            let mut codes = Vec::with_capacity(len);
            while codes.len() < len {
                let c = (rng.next() % 8) as u8;
                let run = 1 + rng.next() % 300;
                for _ in 0..run.min((len - codes.len()) as u64) {
                    codes.push(if rng.next() % 50 == 0 { (rng.next() % 8) as u8 } else { c });
                }
            }
            let chunk_size = [37, 500, 4096, 1 << 20][case % 4];
            let file = file_of(&codes, chunk_size);
            let idx = LevelIndex::build(&file, &legacy());
            assert_eq!(idx.line_count(), len as u64);
            for (l, &c) in codes.iter().enumerate() {
                assert_eq!(idx.code(l as u64), c, "case {case} line {l}");
            }

            // a filter result: random ranges
            let mut ranges = Vec::new();
            let mut l = 0u64;
            while l < len as u64 {
                l += rng.next() % 200;
                let e = (l + 1 + rng.next() % 150).min(len as u64);
                if l < e {
                    ranges.push((l, e));
                }
                l = e + 1;
            }
            let in_ranges = |line: u64| ranges.iter().any(|r| r.0 <= line && line < r.1);

            for n in [1u64, 3, 64, 333, 1000, 5000] {
                assert_eq!(idx.buckets(n), reference(&codes, n, |_| true), "case {case} n {n}");
                assert_eq!(
                    idx.buckets_in(n, &ranges),
                    reference(&codes, n, in_ranges),
                    "case {case} n {n} filtered"
                );
            }
        }
    }

    #[test]
    fn max_in_uses_blocks_correctly() {
        let mut codes = vec![code::INFO; 1000];
        codes[130] = code::ERROR; // inside block 2
        codes[63] = code::WARN; // last line of block 0
        let idx = LevelIndex::build(&file_of(&codes, 100), &legacy());
        assert_eq!(idx.max_in(0, 63), code::INFO);
        assert_eq!(idx.max_in(0, 64), code::WARN);
        assert_eq!(idx.max_in(64, 1000), code::ERROR);
        assert_eq!(idx.max_in(131, 1000), code::INFO);
        assert_eq!(idx.max_in(5, 5), code::NONE);
    }
}
