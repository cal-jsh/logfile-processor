//! Swimlanes: one lane per thread (or per value of another text field), each lane binned
//! by time, for the "Thread lanes" view.
//!
//! [`LaneIndex::build`] reads every log line once, in parallel over the index chunks, and
//! keeps per lane and per time slice ([`SLICES`] equal slices of the file's time span) the
//! most severe level, the number of lines and the first line. Nothing is stored per line:
//! each chunk records runs of `(lane, slice)` cells, which are merged at the end, so the
//! index is about 13 bytes per lane and slice (10 MB for 49 lanes) whatever the file size.
//!
//! Files can have thousands of threads. The [`MAX_LANES`] threads with the most lines get a
//! lane each; all others share one "other" lane at the bottom. Lanes are ordered by name
//! (numbers compared as numbers), so `worker-2` comes before `worker-10`.
//!
//! Zooming in or filtering builds a [`LaneBins`] for a time window or a set of lines
//! ([`LaneBins::build_window`]): the window's lines are found from the first line of each
//! slice of the whole-file index, so only those lines are read. Lines written far out of
//! time order (more than a slice away) can be missed there.
//!
//! Lines without a parseable timestamp are left out. Line numbers here are 0-based.

use crate::logfile::index::LogFile;
use crate::logfile::levels::{code, LevelIndex};
use crate::logfile::view::{View, ViewLines};
use crate::parsing::format::LogFormat;
use rayon::prelude::*;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Time slices per [`LaneBins`]; columns are merged from them.
pub const SLICES: usize = 16_384;
const SLICE_BITS: u32 = 14;
/// Lanes with a thread of their own; the others share the "other" lane.
pub const MAX_LANES: usize = 48;

/// One lane, for the labels.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Lane {
    pub name: String,
    pub lines: u64,
}

/// Which value goes to which lane.
pub struct Lanes {
    /// Lanes with a value of their own, in display order
    pub lanes: Vec<Lane>,
    /// Values sharing the last lane, and their lines (`0`: there is no such lane)
    pub other_values: u64,
    pub other_lines: u64,
    lookup: HashMap<String, u32>,
}

impl Lanes {
    /// Lanes drawn, including the "other" lane if there is one.
    pub fn count(&self) -> usize {
        self.lanes.len() + usize::from(self.other_values > 0)
    }

    fn lane_of(&self, value: &str) -> u32 {
        self.lookup.get(value).copied().unwrap_or(self.lanes.len() as u32)
    }
}

/// Compare names with digit runs as numbers: `t-2` < `t-10`.
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let si = i;
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            let sj = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let na = std::str::from_utf8(&a[si..i]).unwrap().trim_start_matches('0');
            let nb = std::str::from_utf8(&b[sj..j]).unwrap().trim_start_matches('0');
            let o = na.len().cmp(&nb.len()).then_with(|| na.cmp(nb));
            if o != Ordering::Equal {
                return o;
            }
        } else {
            let o = a[i].to_ascii_lowercase().cmp(&b[j].to_ascii_lowercase());
            if o != Ordering::Equal {
                return o;
            }
            i += 1;
            j += 1;
        }
    }
    (a.len() - i).cmp(&(b.len() - j)).then_with(|| a.cmp(b))
}

/// One `(lane, slice)` cell found by a pass.
#[derive(Clone, Copy)]
struct Cell {
    /// `lane << SLICE_BITS | slice`
    key: u32,
    /// Lines per level code
    counts: [u32; LEVELS],
    first: u64,
}

/// Level codes counted per cell (`code::NONE` is never counted).
const LEVELS: usize = code::ERROR as usize + 1;

/// Cells of one pass over some lines; consecutive lines of a lane in the same slice
/// update one cell.
#[derive(Default)]
struct Acc {
    cells: Vec<Cell>,
    /// Per lane: 1 + index of its latest cell, 0 none
    last: Vec<u32>,
    timed: u64,
}

impl Acc {
    #[inline]
    fn add(&mut self, lane: u32, slice: usize, level: u8, line: u64) {
        let l = lane as usize;
        if l >= self.last.len() {
            self.last.resize(l + 1, 0);
        }
        let key = (lane << SLICE_BITS) | slice as u32;
        self.timed += 1;
        let li = self.last[l];
        if li != 0 {
            let c = &mut self.cells[li as usize - 1];
            if c.key == key {
                c.counts[level as usize] += 1;
                c.first = c.first.min(line);
                return;
            }
        }
        let mut counts = [0; LEVELS];
        counts[level as usize] = 1;
        self.cells.push(Cell { key, counts, first: line });
        self.last[l] = self.cells.len() as u32;
    }
}

/// Lines per level and first line per lane and time slice of one time window.
pub struct LaneBins {
    /// The window, ns in the log's own clock, both ends included
    pub span: (i64, i64),
    lanes: usize,
    /// Indexed `lane * SLICES + slice`; counts saturate at `u16::MAX` (more than 65535
    /// lines of one level, lane and slice only happen in very wide windows)
    counts: Vec<[u16; LEVELS]>,
    first: Vec<u64>,
    /// Lines placed in a slice
    pub timed_lines: u64,
    pub build_time: Duration,
}

#[inline]
fn slice_of(span: (i64, i64), ts: i64) -> usize {
    let width = (span.1 - span.0) as i128 + 1;
    (((ts - span.0) as i128 * SLICES as i128) / width).clamp(0, SLICES as i128 - 1) as usize
}

impl LaneBins {
    fn from_cells<'a>(span: (i64, i64), lanes: usize, accs: impl Iterator<Item = (&'a Acc, &'a dyn Fn(u32) -> u32)>) -> Self {
        let n = lanes * SLICES;
        let mut b = Self {
            span,
            lanes,
            counts: vec![[0; LEVELS]; n],
            first: vec![u64::MAX; n],
            timed_lines: 0,
            build_time: Duration::ZERO,
        };
        for (acc, lane_map) in accs {
            b.timed_lines += acc.timed;
            for c in &acc.cells {
                let lane = lane_map(c.key >> SLICE_BITS) as usize;
                let i = lane * SLICES + (c.key & (SLICES as u32 - 1)) as usize;
                for (a, &k) in b.counts[i].iter_mut().zip(&c.counts) {
                    *a = a.saturating_add(k.min(u16::MAX as u32) as u16);
                }
                b.first[i] = b.first[i].min(c.first);
            }
        }
        b
    }

    /// Bin the lines in `ranges` (sorted, disjoint half-open line ranges) whose time is in
    /// `span`, reading just those lines.
    #[allow(clippy::too_many_arguments)]
    pub fn build_window(
        file: &LogFile,
        levels: &LevelIndex,
        format: &LogFormat,
        field: usize,
        lanes: &Lanes,
        span: (i64, i64),
        ranges: &[(u64, u64)],
    ) -> Self {
        let started = Instant::now();
        let view = View::build(ranges, 0, file.line_count());
        const BLOCK: u64 = 256 * 1024;
        let blocks: Vec<u64> = (0..view.row_count()).step_by(BLOCK as usize).collect();
        let accs: Vec<Acc> = blocks
            .par_iter()
            .map(|&first| {
                let mut acc = Acc::default();
                let n = BLOCK.min(view.row_count() - first);
                let mut last: Option<(String, u32)> = None;
                for (_, line, bytes) in ViewLines::new(file, &view, first, n) {
                    let lc = levels.code(line);
                    if lc == code::NONE {
                        continue;
                    }
                    let text = decode(bytes);
                    let Some(p) = format.parse(&text) else { continue };
                    let Some(ts) = format.time_ns(&text, &p) else { continue };
                    if ts < span.0 || ts > span.1 {
                        continue;
                    }
                    let v = p.get(&text, field).trim();
                    let lane = match &last {
                        Some((name, lane)) if name == v => *lane,
                        _ => {
                            let lane = lanes.lane_of(v);
                            last = Some((v.to_string(), lane));
                            lane
                        }
                    };
                    acc.add(lane, slice_of(span, ts), lc, line);
                }
                acc
            })
            .collect();
        let id = |l: u32| l;
        let mut b = Self::from_cells(span, lanes.count(), accs.iter().map(|a| (a, &id as &dyn Fn(u32) -> u32)));
        b.build_time = started.elapsed();
        b
    }

    pub fn lane_count(&self) -> usize {
        self.lanes
    }

    fn col_range(j: usize, n: usize) -> (usize, usize) {
        (j * SLICES / n, (j + 1) * SLICES / n)
    }

    /// Lines per level of `lane` in slices `lo..hi`.
    fn counts_in(&self, lane: usize, lo: usize, hi: usize) -> [u32; LEVELS] {
        let mut out = [0u32; LEVELS];
        for c in &self.counts[lane * SLICES + lo..lane * SLICES + hi] {
            for (o, &k) in out.iter_mut().zip(c) {
                *o += k as u32;
            }
        }
        out
    }

    /// Merge the slices into `n` (at most [`SLICES`]) equal columns, per lane.
    pub fn columns(&self, n: usize) -> Vec<LaneColumns> {
        let n = n.clamp(1, SLICES);
        (0..self.lanes)
            .into_par_iter()
            .map(|lane| {
                let mut out = LaneColumns { dominant: Vec::with_capacity(n), alert: Vec::with_capacity(n), count: Vec::with_capacity(n) };
                for j in 0..n {
                    let (lo, hi) = Self::col_range(j, n);
                    let c = self.counts_in(lane, lo, hi);
                    let (d, a) = dominant_and_alert(&c);
                    out.dominant.push(d);
                    out.alert.push(a);
                    out.count.push(c.iter().sum());
                }
                out
            })
            .collect()
    }

    /// The column nearest to `column` (within `radius` columns, looking at it first, then
    /// alternately right and left) in which `lane` has lines: `(column, first line)`.
    pub fn first_near(&self, lane: usize, n: usize, column: usize, radius: usize) -> Option<(usize, u64)> {
        if lane >= self.lanes {
            return None;
        }
        let n = n.clamp(1, SLICES);
        let base = lane * SLICES;
        let at = |j: usize| {
            let (lo, hi) = Self::col_range(j, n);
            let first = self.first[base + lo..base + hi].iter().copied().min().unwrap_or(u64::MAX);
            (first != u64::MAX).then_some((j, first))
        };
        for d in 0..=radius {
            if column + d < n {
                if let Some(r) = at(column + d) {
                    return Some(r);
                }
            }
            if d > 0 && column >= d {
                if let Some(r) = at(column - d) {
                    return Some(r);
                }
            }
        }
        None
    }
}

/// One lane's columns.
#[derive(Debug, PartialEq)]
pub struct LaneColumns {
    /// The level with the most lines (ties to the more severe one), [`code::NONE`] if empty
    pub dominant: Vec<u8>,
    /// [`code::ERROR`] or [`code::WARN`] if the column has such lines but another level
    /// dominates, else [`code::NONE`]; so a single error stays visible in a busy column
    pub alert: Vec<u8>,
    /// Lines (counts saturate per slice, see [`LaneBins`])
    pub count: Vec<u32>,
}

/// Dominant level and alert level of a column's level counts.
fn dominant_and_alert(c: &[u32; LEVELS]) -> (u8, u8) {
    let mut d = code::NONE;
    let mut most = 0;
    for (l, &k) in c.iter().enumerate().skip(1) {
        if k > 0 && k >= most {
            most = k;
            d = l as u8;
        }
    }
    let worst = [code::ERROR, code::WARN].into_iter().find(|&l| c[l as usize] > 0).unwrap_or(code::NONE);
    (d, if worst > d { worst } else { code::NONE })
}

fn decode(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    match std::str::from_utf8(bytes) {
        Ok(s) => std::borrow::Cow::Borrowed(s),
        Err(_) => String::from_utf8_lossy(bytes),
    }
}

/// The lanes of a file and all its lines binned by time.
pub struct LaneIndex {
    pub lanes: Lanes,
    pub bins: std::sync::Arc<LaneBins>,
    /// First line per slice over all lanes (`u64::MAX` for an empty slice), to find the
    /// lines of a time window
    slice_first: Vec<u64>,
    pub build_time: Duration,
}

/// What one chunk found, with chunk-local lane ids (`id` is `names[id]`).
struct ChunkLanes {
    names: Vec<String>,
    counts: Vec<u64>,
    acc: Acc,
}

impl LaneIndex {
    /// Index field number `field` of `format` over the whole file.
    pub fn build(file: &LogFile, levels: &LevelIndex, format: &LogFormat, field: usize) -> Self {
        let started = Instant::now();
        let span = levels.time_span().unwrap_or((0, 0));
        let parts: Vec<ChunkLanes> = file
            .chunks()
            .par_iter()
            .map(|chunk| {
                let mut out = ChunkLanes { names: Vec::new(), counts: Vec::new(), acc: Acc::default() };
                let mut lookup: HashMap<String, u32> = HashMap::new();
                for (line, bytes) in file.chunk_lines(chunk) {
                    let lc = levels.code(line);
                    if lc == code::NONE {
                        continue;
                    }
                    let text = decode(bytes);
                    let Some(p) = format.parse(&text) else { continue };
                    let Some(ts) = format.time_ns(&text, &p) else { continue };
                    let v = p.get(&text, field).trim();
                    if v.is_empty() {
                        continue;
                    }
                    let id = match lookup.get(v) {
                        Some(&id) => id,
                        None => {
                            let id = out.names.len() as u32;
                            out.names.push(v.to_string());
                            out.counts.push(0);
                            lookup.insert(v.to_string(), id);
                            id
                        }
                    };
                    out.counts[id as usize] += 1;
                    out.acc.add(id, slice_of(span, ts), lc, line);
                }
                out
            })
            .collect();

        // the busiest values get a lane each, shown in name order
        let mut totals: HashMap<&str, u64> = HashMap::new();
        for p in &parts {
            for (n, &c) in p.names.iter().zip(&p.counts) {
                *totals.entry(n.as_str()).or_default() += c;
            }
        }
        let mut ranked: Vec<(&str, u64)> = totals.into_iter().collect();
        ranked.sort_unstable_by(|a, b| b.1.cmp(&a.1).then_with(|| natural_cmp(a.0, b.0)));
        let mut top: Vec<Lane> = ranked.iter().take(MAX_LANES).map(|(n, c)| Lane { name: n.to_string(), lines: *c }).collect();
        top.sort_by(|a, b| natural_cmp(&a.name, &b.name));
        let rest = &ranked[ranked.len().min(MAX_LANES)..];
        let lookup: HashMap<String, u32> = top.iter().enumerate().map(|(i, l)| (l.name.clone(), i as u32)).collect();
        let lanes = Lanes {
            other_values: rest.len() as u64,
            other_lines: rest.iter().map(|r| r.1).sum(),
            lanes: top,
            lookup,
        };

        let maps: Vec<Vec<u32>> = parts.iter().map(|p| p.names.iter().map(|n| lanes.lane_of(n)).collect()).collect();
        let fns: Vec<Box<dyn Fn(u32) -> u32 + '_>> = maps.iter().map(|m| Box::new(move |l: u32| m[l as usize]) as Box<dyn Fn(u32) -> u32>).collect();
        let bins = LaneBins::from_cells(
            span,
            lanes.count(),
            parts.iter().zip(&fns).map(|(p, f)| (&p.acc, f.as_ref() as &dyn Fn(u32) -> u32)),
        );
        let slice_first: Vec<u64> = (0..SLICES)
            .map(|s| (0..bins.lanes).map(|l| bins.first[l * SLICES + s]).min().unwrap_or(u64::MAX))
            .collect();
        let mut bins = bins;
        let build_time = started.elapsed();
        bins.build_time = build_time;
        Self { lanes, bins: std::sync::Arc::new(bins), slice_first, build_time }
    }

    /// Lines to read for time window `span` (ns): from the first line of the slice before
    /// it to the first line of the second slice after it, so lines a little out of order
    /// are still found. `None` if no line can be in the window.
    pub fn window_lines(&self, span: (i64, i64), line_count: u64) -> Option<(u64, u64)> {
        let full = self.bins.span;
        if span.1 < full.0 || span.0 > full.1 {
            return None;
        }
        let sa = slice_of(full, span.0.max(full.0)).saturating_sub(1);
        let sb = slice_of(full, span.1.min(full.1));
        let start = self.slice_first[sa..=sb].iter().copied().min().unwrap_or(u64::MAX);
        if start == u64::MAX {
            return None;
        }
        let end = self.slice_first.get(sb + 2..).and_then(|s| s.iter().copied().find(|&f| f != u64::MAX)).unwrap_or(line_count);
        // a later slice can start before an earlier one when lines are out of order
        Some((start, end.max(start + 1).min(line_count)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parsing::format::LogFormat;

    fn fmt() -> LogFormat {
        LogFormat::compile("[%Y-%m-%d %H:%M:%S.%e] [%l] [%t] %v").unwrap()
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["w-10", "w-2", "main", "W-1", "io", "w-02"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["io", "main", "W-1", "w-02", "w-2", "w-10"]);
    }

    /// Random lines on `threads` threads over an hour, some stack trace lines, as text and
    /// as `(thread, second, level code)` per line.
    fn random_log(lines: usize, threads: u64, seed: u64) -> (String, Vec<Option<(String, i64, u8)>>) {
        let mut x = seed;
        let mut rnd = move || {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            x >> 33
        };
        let mut s = String::new();
        let mut want = Vec::new();
        let mut sec = 0i64;
        for i in 0..lines {
            if rnd() % 30 == 0 {
                s.push_str("    at Frame::run (x.cpp:1)\n");
                want.push(None);
                continue;
            }
            // mostly in order, sometimes a little back in time
            sec = (sec + (rnd() % 3) as i64 - if rnd() % 10 == 0 { 2 } else { 0 }).clamp(0, 3599);
            let t = format!("t-{}", (rnd() % threads).min(rnd() % threads));
            let (lv, c) = [("DEBUG", code::DEBUG), ("INFO", code::INFO), ("WARN", code::WARN), ("ERROR", code::ERROR)][(rnd() % 4) as usize];
            s.push_str(&format!("[2025-01-01 {:02}:{:02}:{:02}.000] [{lv}] [{t}] m{i}\n", sec / 3600, sec / 60 % 60, sec % 60));
            want.push(Some((t, sec, c)));
        }
        (s, want)
    }

    #[test]
    fn index_matches_a_naive_computation() {
        let f = fmt();
        let field = f.field_index("thread").unwrap();
        for (case, threads) in [3u64, 60, 200].into_iter().enumerate() {
            let (text, want) = random_log(5000, threads, 7 + case as u64);
            for chunk in [97usize, 4096, 1 << 20] {
                let file = LogFile::from_test_bytes(text.as_bytes(), chunk);
                let levels = LevelIndex::build(&file, &f);
                let idx = LaneIndex::build(&file, &levels, &f, field);

                // lanes: the busiest MAX_LANES threads, in name order
                let mut totals: HashMap<String, u64> = HashMap::new();
                for (t, _, _) in want.iter().flatten() {
                    *totals.entry(t.clone()).or_default() += 1;
                }
                let mut ranked: Vec<_> = totals.into_iter().collect();
                ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| natural_cmp(&a.0, &b.0)));
                let mut top: Vec<_> = ranked.iter().take(MAX_LANES).cloned().collect();
                top.sort_by(|a, b| natural_cmp(&a.0, &b.0));
                let got: Vec<_> = idx.lanes.lanes.iter().map(|l| (l.name.clone(), l.lines)).collect();
                assert_eq!(got, top, "case {case} chunk {chunk}");
                assert_eq!(idx.lanes.other_values as usize, ranked.len().saturating_sub(MAX_LANES));
                assert_eq!(idx.bins.timed_lines as usize, want.iter().flatten().count());

                // columns against a naive binning
                let span = levels.time_span().unwrap();
                let lane_of = |t: &str| top.iter().position(|x| x.0 == t).unwrap_or(top.len());
                for n in [1usize, 13, 600] {
                    let cols = idx.bins.columns(n);
                    assert_eq!(cols.len(), idx.lanes.count());
                    let mut counts = vec![vec![[0u32; LEVELS]; n]; cols.len()];
                    for (t, sec, c) in want.iter().flatten() {
                        let ts = (crate::logfile::timeline::days_from_civil(2025, 1, 1) * 86_400 + sec) * 1_000_000_000;
                        let s = slice_of(span, ts);
                        let j = (0..n).find(|&j| LaneBins::col_range(j, n).1 > s).unwrap();
                        counts[lane_of(t)][j][*c as usize] += 1;
                    }
                    for (l, got) in cols.iter().enumerate() {
                        for j in 0..n {
                            let c = &counts[l][j];
                            let most = *c.iter().max().unwrap();
                            let dom = if most == 0 { 0 } else { (0..LEVELS).rev().find(|&x| c[x] == most).unwrap() as u8 };
                            let worst = (0..LEVELS).rev().find(|&x| c[x] > 0).unwrap_or(0) as u8;
                            let alert = if worst >= code::WARN && worst > dom { worst } else { 0 };
                            assert_eq!(
                                (got.dominant[j], got.alert[j], got.count[j]),
                                (dom, alert, c.iter().sum::<u32>()),
                                "case {case} chunk {chunk} n {n} lane {l} column {j}"
                            );
                        }
                    }
                }

                // a filter over all lines gives the same bins
                let all = LaneBins::build_window(&file, &levels, &f, field, &idx.lanes, span, &[(0, file.line_count())]);
                assert_eq!(all.columns(600), idx.bins.columns(600));
            }
        }
    }

    #[test]
    fn windows_and_first_lines() {
        let f = fmt();
        let field = f.field_index("thread").unwrap();
        let (text, want) = random_log(20_000, 8, 3);
        let file = LogFile::from_test_bytes(text.as_bytes(), 4096);
        let levels = LevelIndex::build(&file, &f);
        let idx = LaneIndex::build(&file, &levels, &f, field);
        let full = levels.time_span().unwrap();
        let ns = 1_000_000_000i64;

        // a 10 minute window: every line in it is found
        let w = (full.0 + 600 * ns, full.0 + 1200 * ns - 1);
        let (s, e) = idx.window_lines(w, file.line_count()).unwrap();
        let in_window: Vec<usize> = want
            .iter()
            .enumerate()
            .filter_map(|(i, x)| x.as_ref().filter(|x| { let t = full.0 + (x.1 - want.iter().flatten().map(|y| y.1).min().unwrap()) * ns; t >= w.0 && t <= w.1 }).map(|_| i))
            .collect();
        assert!(in_window.iter().all(|&i| (s..e).contains(&(i as u64))), "window lines {s}..{e}");
        let bins = LaneBins::build_window(&file, &levels, &f, field, &idx.lanes, w, &[(s, e)]);
        assert_eq!(bins.timed_lines as usize, in_window.len());

        // the first line near a column is the lowest line of that lane there
        let (col, first) = bins.first_near(0, 100, 0, 5).unwrap();
        let lane0 = &idx.lanes.lanes[0].name;
        let expect = in_window
            .iter()
            .copied()
            .filter(|&i| {
                let x = want[i].as_ref().unwrap();
                let t = full.0 + (x.1 - want.iter().flatten().map(|y| y.1).min().unwrap()) * ns;
                &x.0 == lane0 && slice_of(w, t) >= LaneBins::col_range(col, 100).0 && slice_of(w, t) < LaneBins::col_range(col, 100).1
            })
            .min()
            .unwrap();
        assert_eq!(first, expect as u64);
        assert!(idx.window_lines((full.1 + ns, full.1 + 2 * ns), file.line_count()).is_none());
    }
}
