//! Per-line categories of a text field (e.g. the domain), for colouring the minimap.
//!
//! Values are grouped by their first `.`-separated segment, so `core.algo` and
//! `core.proc` both count as `core`. The [`TOP`] groups with the most lines get codes
//! `1..=TOP` (by line count, then by name, so the same file always gives the same codes);
//! all other groups share [`OTHER`]. A line without the field (not in the log format, or an
//! empty value) is [`NONE`]. Codes are stored half a byte per line, like the level index.
//!
//! A minimap column shows the code with the most lines in it (ties go to the more common
//! group); [`NONE`] lines are not counted. For the "by time" axis, [`CategoryTimeBins`]
//! counts the codes per time slice, so columns can be merged from slices like
//! [`TimeBins`](crate::logfile::timeline::TimeBins).
//!
//! Line numbers in this module are 0-based.

use crate::logfile::index::LogFile;
use crate::logfile::levels::{code, LevelIndex};
use crate::logfile::timeline::FINE_BUCKETS;
use crate::logfile::view::{View, ViewLines};
use crate::parsing::format::LogFormat;
use rayon::prelude::*;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Groups with a code of their own.
pub const TOP: usize = 12;
/// Code of a line without a value.
pub const NONE: u8 = 0;
/// Code shared by all groups outside the top ones.
pub const OTHER: u8 = TOP as u8 + 1;
/// Number of distinct codes.
const CODES: usize = OTHER as usize + 1;

/// Distinct groups one chunk tracks by name; more fall into [`OTHER`].
const MAX_LOCAL: usize = u16::MAX as usize - 1;
const LOCAL_OVERFLOW: u16 = u16::MAX;

/// The group of a field value: its first `.`-separated segment.
pub fn group_of(value: &str) -> &str {
    let v = value.trim();
    v.split('.').next().unwrap_or(v).trim()
}

/// One group, for the legend.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Group {
    pub name: String,
    pub lines: u64,
}

pub struct CategoryIndex {
    /// Groups with a code of their own: code `i + 1` is `top[i]`
    pub top: Vec<Group>,
    /// Lines in the [`OTHER`] groups, and how many groups that is
    pub other_lines: u64,
    pub other_groups: u64,
    /// Two lines per byte: even lines in the low half, odd lines in the high half
    packed: Vec<u8>,
    line_count: u64,
    pub build_time: Duration,
}

/// What one chunk found: a local group id per line (`0` none) and the local groups.
struct ChunkGroups {
    first_line: u64,
    ids: Vec<u16>,
    names: Vec<String>,
    counts: Vec<u64>,
    overflow_lines: u64,
}

impl CategoryIndex {
    /// Index field number `field` of `format` over the whole file.
    pub fn build(file: &LogFile, format: &LogFormat, field: usize) -> Self {
        let started = Instant::now();
        let line_count = file.line_count();

        let parts: Vec<ChunkGroups> = file
            .chunks()
            .par_iter()
            .map(|chunk| {
                let mut ids = Vec::with_capacity(chunk.line_count as usize);
                // local id `i + 1` is `names[i]`
                let mut names: Vec<String> = Vec::new();
                let mut counts: Vec<u64> = Vec::new();
                let mut lookup: HashMap<String, u16> = HashMap::new();
                let mut overflow_lines = 0u64;
                let mut last: (u16, usize) = (0, 0); // id and names index of the previous value
                for (_, bytes) in file.chunk_lines(chunk) {
                    let line = match std::str::from_utf8(bytes) {
                        Ok(s) => std::borrow::Cow::Borrowed(s),
                        Err(_) => String::from_utf8_lossy(bytes),
                    };
                    let id = match format.parse(&line) {
                        None => 0,
                        Some(p) => {
                            let g = group_of(p.get(&line, field));
                            if g.is_empty() {
                                0
                            } else if last.0 != 0 && last.0 != LOCAL_OVERFLOW && names[last.1] == g {
                                last.0 // runs of one group are common
                            } else if let Some(&id) = lookup.get(g) {
                                id
                            } else if names.len() < MAX_LOCAL {
                                names.push(g.to_string());
                                counts.push(0);
                                let id = names.len() as u16;
                                lookup.insert(g.to_string(), id);
                                id
                            } else {
                                LOCAL_OVERFLOW
                            }
                        }
                    };
                    if id == LOCAL_OVERFLOW {
                        overflow_lines += 1;
                    } else if id != 0 {
                        counts[id as usize - 1] += 1;
                        last = (id, id as usize - 1);
                    }
                    ids.push(id);
                }
                ChunkGroups { first_line: chunk.first_line, ids, names, counts, overflow_lines }
            })
            .collect();

        // the top groups over the whole file
        let mut totals: HashMap<&str, u64> = HashMap::new();
        let mut overflow = 0u64;
        for p in &parts {
            for (n, &c) in p.names.iter().zip(&p.counts) {
                *totals.entry(n.as_str()).or_default() += c;
            }
            overflow += p.overflow_lines;
        }
        let mut ranked: Vec<(&str, u64)> = totals.iter().map(|(n, c)| (*n, *c)).collect();
        ranked.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let top: Vec<Group> = ranked.iter().take(TOP).map(|(n, c)| Group { name: n.to_string(), lines: *c }).collect();
        let other_lines = ranked.iter().skip(TOP).map(|g| g.1).sum::<u64>() + overflow;
        let other_groups = ranked.len().saturating_sub(TOP) as u64;
        let code_of: HashMap<&str, u8> = top.iter().enumerate().map(|(i, g)| (g.name.as_str(), i as u8 + 1)).collect();

        // codes per chunk, packed; a chunk starting on an odd line fills the high half of
        // its first byte, and neighbouring chunks are merged with OR (as in LevelIndex)
        let packed_parts: Vec<(usize, Vec<u8>)> = parts
            .par_iter()
            .map(|p| {
                let remap: Vec<u8> = std::iter::once(NONE)
                    .chain(p.names.iter().map(|n| code_of.get(n.as_str()).copied().unwrap_or(OTHER)))
                    .collect();
                let mut out = Vec::with_capacity(p.ids.len() / 2 + 2);
                let mut byte = 0u8;
                let mut line = p.first_line;
                for &id in &p.ids {
                    let c = if id == LOCAL_OVERFLOW { OTHER } else { remap[id as usize] };
                    if line % 2 == 0 {
                        byte = c;
                    } else {
                        out.push(byte | (c << 4));
                        byte = 0;
                    }
                    line += 1;
                }
                if line % 2 == 1 {
                    out.push(byte);
                }
                ((p.first_line / 2) as usize, out)
            })
            .collect();
        let mut packed = vec![0u8; line_count.div_ceil(2) as usize];
        for (at, bytes) in packed_parts {
            for (i, b) in bytes.into_iter().enumerate() {
                packed[at + i] |= b;
            }
        }

        Self { top, other_lines, other_groups, packed, line_count, build_time: started.elapsed() }
    }

    pub fn line_count(&self) -> u64 {
        self.line_count
    }

    /// Code of 0-based `line`.
    pub fn code(&self, line: u64) -> u8 {
        let b = self.packed[(line / 2) as usize];
        if line % 2 == 0 {
            b & 0x0f
        } else {
            b >> 4
        }
    }

    /// Add the codes of lines `start..end` to `counts`.
    fn count_in(&self, start: u64, end: u64, counts: &mut [u64; 16]) {
        let end = end.min(self.line_count);
        if start >= end {
            return;
        }
        let (mut s, e) = (start, end);
        if s % 2 == 1 {
            counts[self.code(s) as usize] += 1;
            s += 1;
        }
        let full_end = e - (e - s) % 2; // whole bytes in s..full_end
        for &b in &self.packed[(s / 2) as usize..(full_end / 2) as usize] {
            counts[(b & 0x0f) as usize] += 1;
            counts[(b >> 4) as usize] += 1;
        }
        if full_end < e {
            counts[self.code(full_end) as usize] += 1;
        }
    }

    fn bucket_start(&self, i: u64, n: u64) -> u64 {
        ((i as u128 * self.line_count as u128) / n as u128) as u64
    }

    /// The dominant code in each of `n` equal buckets of the file (one line per bucket at
    /// most, as [`LevelIndex::bucket_count`]).
    pub fn buckets(&self, n: u64) -> Vec<u8> {
        let n = n.min(self.line_count);
        (0..n)
            .into_par_iter()
            .map(|i| {
                let mut counts = [0u64; 16];
                self.count_in(self.bucket_start(i, n), self.bucket_start(i + 1, n), &mut counts);
                dominant(&counts)
            })
            .collect()
    }

    /// Like [`buckets`](Self::buckets), counting only the lines in `ranges` (sorted,
    /// disjoint half-open line ranges).
    pub fn buckets_in(&self, n: u64, ranges: &[(u64, u64)]) -> Vec<u8> {
        let n = n.min(self.line_count);
        (0..n)
            .into_par_iter()
            .map(|i| {
                let (bs, be) = (self.bucket_start(i, n), self.bucket_start(i + 1, n));
                let mut counts = [0u64; 16];
                let mut j = ranges.partition_point(|r| r.1 <= bs);
                while let Some(&(s, e)) = ranges.get(j) {
                    if s >= be {
                        break;
                    }
                    self.count_in(s.max(bs), e.min(be), &mut counts);
                    j += 1;
                }
                dominant(&counts)
            })
            .collect()
    }
}

/// The code with the most lines, ties to the lower (more common) code; [`NONE`] if empty.
fn dominant(counts: &[u64]) -> u8 {
    let mut best = NONE;
    let mut most = 0u64;
    for (c, &k) in counts.iter().enumerate().take(CODES).skip(1) {
        if k > most {
            most = k;
            best = c as u8;
        }
    }
    best
}

/// Lines per code per time slice.
pub struct CategoryTimeBins {
    counts: Vec<[u32; CODES]>,
    pub build_time: Duration,
}

impl CategoryTimeBins {
    fn empty() -> Self {
        Self { counts: vec![[0; CODES]; FINE_BUCKETS], build_time: Duration::ZERO }
    }

    fn merge(mut self, other: Self) -> Self {
        for (a, b) in self.counts.iter_mut().zip(&other.counts) {
            for c in 0..CODES {
                a[c] += b[c];
            }
        }
        self
    }

    fn add(&mut self, span: (i64, i64), ts: i64, c: u8) {
        let (t0, t1) = span;
        let width = (t1 - t0) as i128 + 1;
        let i = (((ts - t0) as i128 * FINE_BUCKETS as i128) / width).clamp(0, FINE_BUCKETS as i128 - 1) as usize;
        self.counts[i][c as usize] += 1;
    }

    /// Bin every line with a category and a timestamp.
    pub fn build_all(file: &LogFile, levels: &LevelIndex, cats: &CategoryIndex, format: &LogFormat) -> Self {
        let started = Instant::now();
        let Some(span) = levels.time_span() else {
            return Self::empty();
        };
        let mut bins = file
            .chunks()
            .par_iter()
            .fold(Self::empty, |mut acc, chunk| {
                for (line, bytes) in file.chunk_lines(chunk) {
                    let c = cats.code(line);
                    if c == NONE || levels.code(line) == code::NONE {
                        continue;
                    }
                    if let Some(ts) = format.time_of(bytes) {
                        acc.add(span, ts, c);
                    }
                }
                acc
            })
            .reduce(Self::empty, Self::merge);
        bins.build_time = started.elapsed();
        bins
    }

    /// Bin only the lines in `ranges`, reading just those lines.
    pub fn build_ranges(
        file: &LogFile,
        levels: &LevelIndex,
        cats: &CategoryIndex,
        format: &LogFormat,
        ranges: &[(u64, u64)],
    ) -> Self {
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
                    let c = cats.code(line);
                    if c == NONE || levels.code(line) == code::NONE {
                        continue;
                    }
                    if let Some(ts) = format.time_of(bytes) {
                        acc.add(span, ts, c);
                    }
                }
                acc
            })
            .reduce(Self::empty, Self::merge);
        bins.build_time = started.elapsed();
        bins
    }

    /// The dominant code of each of `n` (at most [`FINE_BUCKETS`]) equal columns.
    pub fn columns(&self, n: usize) -> Vec<u8> {
        let n = n.clamp(1, FINE_BUCKETS);
        (0..n)
            .map(|j| {
                let (lo, hi) = (j * FINE_BUCKETS / n, (j + 1) * FINE_BUCKETS / n);
                let mut counts = [0u64; CODES];
                for s in &self.counts[lo..hi] {
                    for c in 0..CODES {
                        counts[c] += s[c] as u64;
                    }
                }
                dominant(&counts)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parsing::format::LEGACY_PATTERN;

    fn legacy() -> LogFormat {
        LogFormat::compile(LEGACY_PATTERN).unwrap()
    }

    /// A file whose line `i` has domain `domains[i]` (`None`: a stack trace line).
    fn file_of(domains: &[Option<String>], chunk_size: usize) -> LogFile {
        let mut s = String::new();
        for (i, d) in domains.iter().enumerate() {
            match d {
                None => s.push_str(&format!("    at some.stack.Frame({i})\n")),
                Some(d) => s.push_str(&format!("[2025-01-01 00:00:{:02}] [INFO] [{d}] line {i}\n", i % 60)),
            }
        }
        LogFile::from_test_bytes(s.as_bytes(), chunk_size)
    }

    #[test]
    fn groups_by_first_segment() {
        assert_eq!(group_of("core.algo"), "core");
        assert_eq!(group_of(" core "), "core");
        assert_eq!(group_of("net"), "net");
        assert_eq!(group_of(".x"), "");
    }

    #[test]
    fn codes_and_buckets_match_a_naive_computation() {
        let mut x = 99u64;
        let mut rnd = move || {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            x >> 33
        };
        let fmt = legacy();
        let field = fmt.field_index("domain").unwrap();
        for case in 0..24 {
            // 30 groups with skewed sizes, in runs, some stack trace lines
            let len = (rnd() % 4000) as usize;
            let mut domains = Vec::with_capacity(len);
            while domains.len() < len {
                let g = (rnd() % 30).min(rnd() % 30);
                let sub = rnd() % 3;
                for _ in 0..(1 + rnd() % 200).min((len - domains.len()) as u64) {
                    domains.push(if rnd() % 40 == 0 { None } else { Some(format!("g{g:02}.sub{sub}")) });
                }
            }
            let file = file_of(&domains, [41, 700, 1 << 20][case % 3]);
            let idx = CategoryIndex::build(&file, &fmt, field);

            // the expected top groups and codes
            let mut totals: HashMap<String, u64> = HashMap::new();
            for d in domains.iter().flatten() {
                *totals.entry(group_of(d).to_string()).or_default() += 1;
            }
            let mut ranked: Vec<_> = totals.into_iter().collect();
            ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            let names: Vec<_> = idx.top.iter().map(|g| (g.name.clone(), g.lines)).collect();
            assert_eq!(names, ranked.iter().take(TOP).cloned().collect::<Vec<_>>(), "case {case}");
            assert_eq!(idx.other_groups as usize, ranked.len().saturating_sub(TOP));
            let want_code = |l: usize| match &domains[l] {
                None => NONE,
                Some(d) => ranked.iter().take(TOP).position(|g| g.0 == group_of(d)).map_or(OTHER, |p| p as u8 + 1),
            };
            for l in 0..len {
                assert_eq!(idx.code(l as u64), want_code(l), "case {case} line {l}");
            }

            let ranges: Vec<(u64, u64)> = (0..len as u64).step_by(97).map(|s| (s, (s + 31).min(len as u64))).collect();
            let naive = |n: u64, keep: &dyn Fn(u64) -> bool| -> Vec<u8> {
                let n = n.min(len as u64);
                (0..n)
                    .map(|i| {
                        let mut counts = [0u64; 16];
                        for l in (i * len as u64 / n)..((i + 1) * len as u64 / n) {
                            if keep(l) {
                                counts[want_code(l as usize) as usize] += 1;
                            }
                        }
                        dominant(&counts)
                    })
                    .collect()
            };
            for n in [1u64, 7, 100, 1000, 5000] {
                assert_eq!(idx.buckets(n), naive(n, &|_| true), "case {case} n {n}");
                let in_r = |l: u64| ranges.iter().any(|r| r.0 <= l && l < r.1);
                assert_eq!(idx.buckets_in(n, &ranges), naive(n, &in_r), "case {case} n {n} filtered");
            }
        }
    }

    #[test]
    fn time_bins_count_by_slice() {
        let text = "[2025-01-01 00:00:00] [INFO] [core.algo] x\n\
                    [2025-01-01 00:00:00] [INFO] [net] x\n\
                    [2025-01-01 00:00:00] [INFO] [core.proc] x\n\
                    \tat stack.Frame\n\
                    [2025-01-01 00:01:40] [WARN] [net.tcp] x\n";
        let f = LogFile::from_test_bytes(text.as_bytes(), 64);
        let fmt = legacy();
        let l = LevelIndex::build(&f, &fmt);
        let c = CategoryIndex::build(&f, &fmt, fmt.field_index("domain").unwrap());
        assert_eq!(c.top.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["core", "net"]);
        let bins = CategoryTimeBins::build_all(&f, &l, &c, &fmt);
        let cols = bins.columns(100);
        assert_eq!((cols[0], cols[50], cols[99]), (1, NONE, 2));
        let only = CategoryTimeBins::build_ranges(&f, &l, &c, &fmt, &[(1, 2)]);
        assert_eq!(only.columns(100)[0], 2);
    }
}
