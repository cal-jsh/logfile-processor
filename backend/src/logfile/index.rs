//! Memory-mapped log file with a sparse line index.
//!
//! The file is mapped read-only and never copied into a `String`. The index stores the
//! byte offset of every [`CHECKPOINT_EVERY`]-th line (counted per chunk), so reaching any
//! line is a binary search plus a short `memchr` scan. It is built in parallel: the file
//! is split into chunks that start at line boundaries, each chunk is scanned on a rayon
//! thread, and the per-chunk line counts are prefix-summed.
//!
//! Line numbers in this module are 0-based. The HTTP API converts to 1-based.

use memchr::{memchr, memchr_iter};
use memmap2::Mmap;
use rayon::prelude::*;
use std::fs::File;
use std::path::Path;
use std::time::{Duration, Instant};

/// A checkpoint is stored for every this many lines.
pub const CHECKPOINT_EVERY: u64 = 1024;

/// Target size of the chunks the file is split into for parallel work.
pub const CHUNK_SIZE: usize = 16 * 1024 * 1024;

/// A byte range of the file that starts at a line start and ends just after a `\n`
/// (or at end of file).
#[derive(Clone, Debug)]
pub struct Chunk {
    pub start: usize,
    pub end: usize,
    /// 0-based number of the first line in the chunk.
    pub first_line: u64,
    #[cfg_attr(not(test), allow(dead_code))]
    pub line_count: u64,
}

pub struct LogFile {
    /// `None` for an empty file (an empty file cannot be mapped on every platform).
    mmap: Option<Mmap>,
    /// `(line, byte offset)` pairs, sorted by line. The first is always `(0, 0)`.
    checkpoints: Vec<(u64, usize)>,
    chunks: Vec<Chunk>,
    line_count: u64,
    pub index_time: Duration,
}

impl LogFile {
    pub fn open(path: &Path) -> std::io::Result<Self> {
        let file = File::open(path)?;
        let len = file.metadata()?.len();
        let mmap = if len == 0 {
            None
        } else {
            // SAFETY: the map is read-only. If another process truncates the file while
            // it is mapped, reads can fault (Linux SIGBUS); Windows refuses the truncate.
            // Uploaded files are owned by this server and never modified after upload.
            Some(unsafe { Mmap::map(&file)? })
        };
        let started = Instant::now();
        let mut lf = LogFile {
            mmap,
            checkpoints: Vec::new(),
            chunks: Vec::new(),
            line_count: 0,
            index_time: Duration::ZERO,
        };
        lf.build_index(CHUNK_SIZE);
        lf.index_time = started.elapsed();
        Ok(lf)
    }

    /// Build a `LogFile` over in-memory bytes (tests).
    #[cfg(test)]
    pub fn from_test_bytes(data: &[u8], chunk_size: usize) -> Self {
        let mut mm = memmap2::MmapMut::map_anon(data.len().max(1)).unwrap();
        mm[..data.len()].copy_from_slice(data);
        let mmap = mm.make_read_only().unwrap();
        let mut lf = LogFile {
            mmap: if data.is_empty() { None } else { Some(mmap) },
            checkpoints: Vec::new(),
            chunks: Vec::new(),
            line_count: 0,
            index_time: Duration::ZERO,
        };
        lf.build_index(chunk_size);
        lf
    }

    pub fn bytes(&self) -> &[u8] {
        self.mmap.as_deref().unwrap_or(&[])
    }

    pub fn len(&self) -> usize {
        self.bytes().len()
    }

    /// Number of lines in the file. A final line without `\n` counts as a line.
    pub fn line_count(&self) -> u64 {
        self.line_count
    }

    pub fn chunks(&self) -> &[Chunk] {
        &self.chunks
    }

    fn build_index(&mut self, chunk_size: usize) {
        let data = self.mmap.as_deref().unwrap_or(&[]);

        // 1. Chunk boundaries, each just after a '\n' (cheap: one memchr per chunk).
        let mut bounds = Vec::new();
        let mut start = 0usize;
        while start < data.len() {
            let target = start.saturating_add(chunk_size.max(1));
            let end = if target >= data.len() {
                data.len()
            } else {
                match memchr(b'\n', &data[target..]) {
                    Some(p) => target + p + 1,
                    None => data.len(),
                }
            };
            bounds.push((start, end));
            start = end;
        }

        // 2. Count lines and collect local checkpoints per chunk, in parallel.
        let per_chunk: Vec<(u64, Vec<(u64, usize)>)> = bounds
            .par_iter()
            .map(|&(s, e)| {
                let slice = &data[s..e];
                let mut cps = vec![(0u64, s)];
                let mut newlines = 0u64;
                for p in memchr_iter(b'\n', slice) {
                    newlines += 1;
                    let next = s + p + 1;
                    if newlines % CHECKPOINT_EVERY == 0 && next < e {
                        cps.push((newlines, next));
                    }
                }
                let lines = newlines + u64::from(slice.last() != Some(&b'\n'));
                (lines, cps)
            })
            .collect();

        // 3. Prefix-sum into global line numbers.
        let mut checkpoints = Vec::with_capacity(per_chunk.iter().map(|c| c.1.len()).sum());
        let mut chunks = Vec::with_capacity(bounds.len());
        let mut first_line = 0u64;
        for (&(s, e), (lines, cps)) in bounds.iter().zip(per_chunk) {
            checkpoints.extend(cps.into_iter().map(|(l, off)| (first_line + l, off)));
            chunks.push(Chunk { start: s, end: e, first_line, line_count: lines });
            first_line += lines;
        }
        if checkpoints.is_empty() {
            checkpoints.push((0, 0));
        }
        self.checkpoints = checkpoints;
        self.chunks = chunks;
        self.line_count = first_line;
    }

    /// Byte offset where 0-based `line` starts. `line` may equal `line_count()`.
    pub fn line_start(&self, line: u64) -> usize {
        self.line_start_from(line, None)
    }

    /// Like [`line_start`](Self::line_start), but may continue from a known position
    /// `(line, offset)` when that is closer than the nearest checkpoint. Reading many
    /// short runs of lines in file order (a filtered view) then never rescans.
    pub fn line_start_from(&self, line: u64, known: Option<(u64, usize)>) -> usize {
        let data = self.bytes();
        if line >= self.line_count {
            return data.len();
        }
        let i = self.checkpoints.partition_point(|&(l, _)| l <= line) - 1;
        let (mut cur, mut off) = match known {
            Some(k) if k.0 <= line && k.0 >= self.checkpoints[i].0 => k,
            _ => self.checkpoints[i],
        };
        while cur < line {
            match memchr(b'\n', &data[off..]) {
                Some(p) => off += p + 1,
                None => return data.len(),
            }
            cur += 1;
        }
        off
    }

    /// Iterate lines from 0-based `start`, yielding `(line, bytes without "\n" / "\r\n")`.
    pub fn lines_from(&self, start: u64) -> LineIter<'_> {
        LineIter { data: self.bytes(), pos: self.line_start(start), line: start }
    }

    /// Iterate lines from `start`, continuing from a known position if it helps.
    pub fn lines_from_hint(&self, start: u64, known: Option<(u64, usize)>) -> LineIter<'_> {
        LineIter { data: self.bytes(), pos: self.line_start_from(start, known), line: start }
    }

    /// Iterate the lines of one chunk.
    pub fn chunk_lines(&self, chunk: &Chunk) -> LineIter<'_> {
        LineIter { data: &self.bytes()[..chunk.end], pos: chunk.start, line: chunk.first_line }
    }
}

pub struct LineIter<'a> {
    data: &'a [u8],
    pos: usize,
    line: u64,
}

impl LineIter<'_> {
    /// `(next line, its byte offset)`.
    pub fn cursor(&self) -> (u64, usize) {
        (self.line, self.pos)
    }
}

impl<'a> Iterator for LineIter<'a> {
    type Item = (u64, &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.data.len() {
            return None;
        }
        let rest = &self.data[self.pos..];
        let (mut text, advance) = match memchr(b'\n', rest) {
            Some(p) => (&rest[..p], p + 1),
            None => (rest, rest.len()),
        };
        if text.last() == Some(&b'\r') {
            text = &text[..text.len() - 1];
        }
        let item = (self.line, text);
        self.pos += advance;
        self.line += 1;
        Some(item)
    }
}

/// The first [`SAMPLE_LINES`](crate::parsing::format::SAMPLE_LINES) lines of the file,
/// decoded (invalid UTF-8 replaced), for detecting or checking the line format.
pub fn sample_lines(file: &LogFile) -> Vec<String> {
    file.lines_from(0)
        .take(crate::parsing::format::SAMPLE_LINES)
        .map(|(_, b)| display_text(b, 64 * 1024).0)
        .collect()
}

/// Decode a line for display, cutting it at `max_bytes` (on a UTF-8 character boundary).
/// Returns the text and whether it was cut.
pub fn display_text(line: &[u8], max_bytes: usize) -> (String, bool) {
    if line.len() <= max_bytes {
        return (String::from_utf8_lossy(line).into_owned(), false);
    }
    let mut cut = max_bytes;
    while cut > 0 && (line[cut] & 0xC0) == 0x80 {
        cut -= 1;
    }
    (String::from_utf8_lossy(&line[..cut]).into_owned(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(lf: &LogFile, start: u64, n: usize) -> Vec<(u64, String)> {
        lf.lines_from(start)
            .take(n)
            .map(|(l, b)| (l, String::from_utf8_lossy(b).into_owned()))
            .collect()
    }

    fn sample(n: usize) -> String {
        (0..n).map(|i| format!("line {i}\n")).collect()
    }

    #[test]
    fn counts_lines_with_and_without_trailing_newline() {
        assert_eq!(LogFile::from_test_bytes(b"", 8).line_count(), 0);
        assert_eq!(LogFile::from_test_bytes(b"a", 8).line_count(), 1);
        assert_eq!(LogFile::from_test_bytes(b"a\n", 8).line_count(), 1);
        assert_eq!(LogFile::from_test_bytes(b"a\nb", 8).line_count(), 2);
        assert_eq!(LogFile::from_test_bytes(b"\n\n\n", 8).line_count(), 3);
    }

    #[test]
    fn random_access_matches_sequential_read_for_any_chunk_size() {
        let text = sample(5000);
        let expected: Vec<String> = text.lines().map(str::to_string).collect();
        for chunk_size in [1, 7, 100, 4096, 1 << 20] {
            let lf = LogFile::from_test_bytes(text.as_bytes(), chunk_size);
            assert_eq!(lf.line_count(), 5000, "chunk_size {chunk_size}");
            for start in [0u64, 1, 1023, 1024, 1025, 2047, 2048, 4999] {
                let got = collect(&lf, start, 3);
                for (l, t) in got {
                    assert_eq!(t, expected[l as usize], "chunk_size {chunk_size} line {l}");
                }
            }
            // chunks cover the file and their line counts add up
            let sum: u64 = lf.chunks().iter().map(|c| c.line_count).sum();
            assert_eq!(sum, 5000);
            let all: Vec<String> = lf
                .chunks()
                .iter()
                .flat_map(|c| lf.chunk_lines(c).map(|(_, b)| String::from_utf8_lossy(b).into_owned()))
                .collect();
            assert_eq!(all, expected);
        }
    }

    #[test]
    fn line_start_from_known_position_agrees() {
        let text = sample(5000);
        let lf = LogFile::from_test_bytes(text.as_bytes(), 1000);
        for (known, target) in [(10u64, 20u64), (1000, 1030), (1020, 2050), (3000, 100), (4999, 4999)] {
            let k = (known, lf.line_start(known));
            assert_eq!(lf.line_start_from(target, Some(k)), lf.line_start(target));
        }
    }

    #[test]
    fn strips_crlf_and_reads_past_end() {
        let lf = LogFile::from_test_bytes(b"a\r\nb\r\nc", 2);
        assert_eq!(
            collect(&lf, 0, 10),
            vec![(0, "a".into()), (1, "b".into()), (2, "c".into())]
        );
        assert!(collect(&lf, 3, 10).is_empty());
        assert!(collect(&lf, 99, 10).is_empty());
    }

    #[test]
    fn display_text_cuts_on_char_boundary() {
        let (t, cut) = display_text("aé".as_bytes(), 2);
        assert_eq!((t.as_str(), cut), ("a", true));
        let (t, cut) = display_text(b"abc", 3);
        assert_eq!((t.as_str(), cut), ("abc", false));
    }
}
