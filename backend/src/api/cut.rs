//! Cut a time range out of an open log file into a new file next to it.
//!
//! The cut is the contiguous part of the file from the first line stamped at or after
//! the range start up to (not including) the first line stamped at or after the range
//! end. Lines without a timestamp in between (stack traces, wrapped messages) stay with
//! the line they belong to, and the bytes are copied as they are, so the new file is an
//! exact slice of the old one. Both ends are found from the level index's per-chunk time
//! spans, which means only the two 16 MB chunks holding them are parsed; the rest is a
//! plain copy streamed from the memory map.

use crate::log_storage::get_user_log;
use crate::logfile::index::LogFile;
use crate::logfile::timeline::first_line_at_or_after;
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// Bytes written per `write` call.
const WRITE_BLOCK: usize = 8 * 1024 * 1024;

#[derive(Serialize, Debug)]
pub struct CutResult {
    /// Full path of the new file
    pub path: String,
    /// Its file name, for messages
    pub name: String,
    pub line_count: u64,
    pub byte_count: u64,
    /// 1-based line numbers of the first and last line taken from the source
    pub first_line: u64,
    pub last_line: u64,
    pub millis: u64,
}

/// Write the lines of `[from_ms, to_ms)` (log clock, as on the minimap) of an open
/// session to a new file in the folder of its log file. The name is made from the
/// log's name and the range (see [`cut_file_name`]); an existing file is never
/// overwritten (` (2)`, ` (3)`, … are tried instead).
pub async fn cut_time_range(session_id: &str, from_ms: f64, to_ms: f64) -> Result<CutResult, String> {
    if !from_ms.is_finite() || !to_ms.is_finite() || to_ms <= from_ms {
        return Err("The time range is empty".into());
    }
    let session = get_user_log(session_id).ok_or("Session ID not found")?;
    let (levels, _) = session.levels().await.map_err(|e| match e {
        crate::log_storage::QueryError::Cancelled => "Cancelled".to_string(),
        crate::log_storage::QueryError::Internal(m) => m,
    })?;
    let (from, to) = ((from_ms * 1e6).round() as i64, (to_ms * 1e6).round() as i64);
    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let file = &session.file;
        let Some((first, _)) = first_line_at_or_after(file, &levels, &session.format, from) else {
            return Err("No log lines in this time range".to_string());
        };
        // Every line stamped at or after `to` is also at or after `from`, so this is
        // never before `first`.
        let end = first_line_at_or_after(file, &levels, &session.format, to)
            .map(|(l, _)| l)
            .unwrap_or(file.line_count());
        if end <= first {
            return Err("No log lines in this time range".to_string());
        }
        let dir = session.path.parent().map(Path::to_path_buf).unwrap_or_default();
        let name = cut_file_name(&session.path, from, to);
        let (path, bytes) = write_lines(file, first, end, &dir, &name).map_err(|e| e.to_string())?;
        let result = CutResult {
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            line_count: end - first,
            byte_count: bytes,
            first_line: first + 1,
            last_line: end,
            millis: started.elapsed().as_millis() as u64,
        };
        tracing::info!(
            "Cut lines {}..={} ({} bytes) to {} in {} ms",
            result.first_line,
            result.last_line,
            bytes,
            result.path,
            result.millis
        );
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy lines `[first, end)` to a new file `name` in `dir` (with ` (2)` etc. if taken).
/// Written to a `.part` file first and renamed when complete, so a failed or partial
/// cut never leaves a file that looks finished.
fn write_lines(file: &LogFile, first: u64, end: u64, dir: &Path, name: &str) -> std::io::Result<(PathBuf, u64)> {
    let (a, b) = (file.line_start(first), file.line_start(end));
    let mut data = &file.bytes()[a..b];
    let part = free_path(dir, &format!("{name}.part"));
    let result = (|| {
        let mut out = std::fs::File::create_new(&part)?;
        while !data.is_empty() {
            let n = data.len().min(WRITE_BLOCK);
            out.write_all(&data[..n])?;
            data = &data[n..];
        }
        out.sync_all()?;
        drop(out);
        // `create_new` + rename that refuses to replace: find a free name and move.
        loop {
            let target = free_path(dir, name);
            match rename_no_replace(&part, &target) {
                Ok(()) => return Ok(target),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
    })();
    match result {
        Ok(target) => Ok((target, (b - a) as u64)),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Rename `from` to `to`, failing with `AlreadyExists` instead of replacing `to`.
fn rename_no_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    // `hard_link` fails if `to` exists, on Windows and Unix alike.
    std::fs::hard_link(from, to)?;
    std::fs::remove_file(from)
}

/// `dir/name`, or `dir/stem (2).ext`, `(3)`, … for the first name not taken.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// Name of a cut: the log's name with the range inserted before the extension,
/// `app_2026-11-20_0130-0240.log`. A range over midnight names both dates
/// (`app_2026-11-20_2330-2026-11-21_0110.log`); a range inside one minute adds seconds
/// (`app_2026-11-20_013005-013051.log`). Times are the log's own clock, as shown.
pub fn cut_file_name(log: &Path, from_ns: i64, to_ns: i64) -> String {
    let stem = log.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "log".into());
    let ext = log.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_else(|| ".log".into());
    let (d0, h0, m0, s0) = clock(from_ns);
    let (d1, h1, m1, s1) = clock(to_ns);
    let same_minute = d0 == d1 && h0 == h1 && m0 == m1;
    let t = |h: i64, m: i64, s: i64| {
        if same_minute {
            format!("{h:02}{m:02}{s:02}")
        } else {
            format!("{h:02}{m:02}")
        }
    };
    let range = if d0 == d1 {
        format!("{d0}_{}-{}", t(h0, m0, s0), t(h1, m1, s1))
    } else {
        format!("{d0}_{}-{d1}_{}", t(h0, m0, s0), t(h1, m1, s1))
    };
    format!("{stem}_{range}{ext}")
}

/// `(YYYY-MM-DD, hour, minute, second)` of nanoseconds since 1970 in the log's clock.
fn clock(ns: i64) -> (String, i64, i64, i64) {
    let secs = ns.div_euclid(1_000_000_000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (format!("{y:04}-{m:02}-{d:02}"), rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logfile::levels::LevelIndex;
    use crate::logfile::timeline::parse_timestamp;
    use crate::parsing::format::LogFormat;

    fn ns(ts: &str) -> i64 {
        parse_timestamp(ts).unwrap()
    }

    #[test]
    fn names() {
        let p = Path::new(r"C:\logs\mylog.log");
        assert_eq!(cut_file_name(p, ns("2026-11-20 01:30:00"), ns("2026-11-20 02:40:00")), "mylog_2026-11-20_0130-0240.log");
        assert_eq!(cut_file_name(p, ns("2026-11-20 01:30:12"), ns("2026-11-20 02:41:00.5")), "mylog_2026-11-20_0130-0241.log");
        assert_eq!(
            cut_file_name(p, ns("2026-11-20 23:30:00"), ns("2026-11-21 01:10:30")),
            "mylog_2026-11-20_2330-2026-11-21_0110.log"
        );
        assert_eq!(cut_file_name(p, ns("2026-11-20 01:30:05"), ns("2026-11-20 01:30:51")), "mylog_2026-11-20_013005-013051.log");
        assert_eq!(cut_file_name(Path::new("server"), ns("2026-01-02 03:04:00"), ns("2026-01-02 05:00:00")), "server_2026-01-02_0304-0500.log");
        assert_eq!(cut_file_name(Path::new("a.b.txt"), ns("2024-02-29 00:00:00"), ns("2024-02-29 12:00:00")), "a.b_2024-02-29_0000-1200.txt");
    }

    #[test]
    fn copies_the_slice_with_untimed_lines() {
        let text = "\
[2026-11-20 01:00:00.000] [info] [a] [1] one
[2026-11-20 01:10:00.000] [info] [a] [1] two
  at stack frame
[2026-11-20 01:20:00.000] [error] [a] [1] three
[2026-11-20 01:30:00.000] [info] [a] [1] four
";
        let file = LogFile::from_test_bytes(text.as_bytes(), 40);
        let format = LogFormat::compile("[%{time}] [%l] [%n] [%{thread}] %v").unwrap();
        let levels = LevelIndex::build(&file, &format);
        let from = ns("2026-11-20 01:05:00");
        let to = ns("2026-11-20 01:30:00");
        let (first, _) = first_line_at_or_after(&file, &levels, &format, from).unwrap();
        let end = first_line_at_or_after(&file, &levels, &format, to).unwrap().0;
        assert_eq!((first, end), (1, 4));
        let dir = std::env::temp_dir().join(format!("cut_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (p1, n) = write_lines(&file, first, end, &dir, "x.log").unwrap();
        let got = std::fs::read_to_string(&p1).unwrap();
        assert_eq!(got.len() as u64, n);
        assert_eq!(got, text.lines().skip(1).take(3).map(|l| format!("{l}\n")).collect::<String>());
        // a second cut never replaces the first
        let (p2, _) = write_lines(&file, 0, 1, &dir, "x.log").unwrap();
        assert_eq!(p2.file_name().unwrap(), "x (2).log");
        assert_eq!(std::fs::read_to_string(&p1).unwrap(), got);
        assert!(!dir.join("x.log.part").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
