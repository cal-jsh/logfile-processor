//! Export as a Perfetto trace (Chrome JSON trace event format), to open in
//! <https://ui.perfetto.dev>.
//!
//! Each log line becomes an instant event (`"ph":"i"`, thread scoped) on one track per
//! value of the track field (the thread, by default), at the line's own time:
//!
//! * `name` and `cat`: the level. Perfetto colours events by name, so each level gets
//!   one colour, and its histograms and aggregations group by level,
//! * `args`: `message`, the line number, every other field of the format (domain,
//!   thread, ...), `context: true` for context lines around a match, and `more`: lines
//!   without a time (stack traces) that follow the line. Perfetto's search also finds
//!   arg values, so a search for message text or a domain works.
//!
//! The JSON format was chosen over Perfetto's protobuf format because it needs no
//! dependency or schema, streams line by line and is readable; the protobuf format would
//! load somewhat faster but does not lift the browser's memory limit much, which is
//! what [`DEFAULT_MAX_EVENTS`] guards against.
//!
//! Times are the log's own clock (no time zone) as µs since 1970, so Perfetto's
//! "UTC" time display shows exactly the times in the log.

use crate::parsing::format::{FieldKind, LogFormat};
use std::collections::{HashMap, HashSet};
use std::io::Write;

/// Events written at most by default. The Perfetto UI parses JSON traces in the
/// browser, in WebAssembly memory. Measured with ui.perfetto.dev v59 in Edge
/// (2026-11-22, ~200 bytes per event): 2M events (420 MB) load in 13 s, 4M (820 MB)
/// in 35 s, 8M (1.7 GB) in 77 s with 4.3 GB of browser memory, near the 4 GB
/// WebAssembly limit.
pub const DEFAULT_MAX_EVENTS: u64 = 4_000_000;

/// Bytes of following lines without a time (`more`) kept per event.
const MORE_MAX: usize = 64 * 1024;

/// The field to make tracks of when none is given: `thread`, else the first text
/// field (as the viewer's thread lanes), else none (one track).
pub fn default_track_field(format: &LogFormat) -> Option<usize> {
    let text = |i: &usize| format.fields()[*i].kind == FieldKind::Text;
    let all = 0..format.fields().len();
    all.clone().filter(text).find(|&i| format.fields()[i].name == "thread").or_else(|| all.clone().find(text))
}

/// The track field by name or label (any case); `None`: [`default_track_field`].
pub fn track_field(format: &LogFormat, name: Option<&str>) -> Result<Option<usize>, String> {
    let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(default_track_field(format));
    };
    format
        .fields()
        .iter()
        .position(|f| f.kind == FieldKind::Text && (f.name.eq_ignore_ascii_case(name) || f.label.eq_ignore_ascii_case(name)))
        .map(Some)
        .ok_or_else(|| format!("the lines have no field '{name}' to make tracks of"))
}

/// Writes rows as trace events; see the module docs. Call [`header`](Self::header),
/// then [`row`](Self::row) per line in file order, then [`finish`](Self::finish).
pub struct PerfettoWriter<'a> {
    format: &'a LogFormat,
    process_name: String,
    track: Option<usize>,
    /// Fields written as args: text fields
    args: Vec<usize>,
    tids: HashMap<String, u32>,
    /// Thread ids given out
    used: HashSet<u32>,
    next_tid: u32,
    /// The last event, without its closing braces: `more` lines may still follow it
    event: Vec<u8>,
    open: bool,
    more: String,
    max_events: u64,
    /// Events written (or started)
    pub events: u64,
    /// Stopped at `max_events`; later rows are ignored
    pub truncated: bool,
    /// Lines without a time before the first event (they have no event to join)
    pub skipped: u64,
}

impl<'a> PerfettoWriter<'a> {
    pub fn new(format: &'a LogFormat, process_name: &str, track: Option<usize>, max_events: u64) -> Self {
        let args = (0..format.fields().len()).filter(|&i| format.fields()[i].kind == FieldKind::Text).collect();
        Self {
            format,
            process_name: process_name.to_string(),
            track,
            args,
            tids: HashMap::new(),
            // 1 is the process id: a thread with the same id would be its "main thread"
            used: HashSet::from([1]),
            next_tid: 2,
            event: Vec::with_capacity(1024),
            open: false,
            more: String::new(),
            max_events,
            events: 0,
            truncated: false,
            skipped: 0,
        }
    }

    pub fn header(&mut self, out: &mut impl Write) -> std::io::Result<()> {
        let mut b = Vec::new();
        b.extend_from_slice(b"{\"traceEvents\":[\n{\"ph\":\"M\",\"pid\":1,\"tid\":0,\"name\":\"process_name\",\"args\":{\"name\":");
        json_str(&mut b, &self.process_name);
        b.extend_from_slice(b"}}");
        if self.track.is_none() {
            b.extend_from_slice(b",\n{\"ph\":\"M\",\"pid\":1,\"tid\":2,\"name\":\"thread_name\",\"args\":{\"name\":\"log\"}}");
        }
        out.write_all(&b)
    }

    /// No more events will be taken.
    pub fn full(&self) -> bool {
        self.truncated
    }

    /// One row: 0-based `line` with its bytes (without the line break).
    pub fn row(&mut self, out: &mut impl Write, line: u64, bytes: &[u8], is_match: bool) -> std::io::Result<()> {
        if self.truncated {
            return Ok(());
        }
        let text = String::from_utf8_lossy(bytes);
        let fmt = self.format;
        let parsed = fmt.parse(&text);
        let time = parsed.as_ref().and_then(|p| fmt.time_ns(&text, p));
        let (Some(p), Some(t)) = (parsed, time) else {
            // a stack trace or other line without a time: part of the event before it
            if !self.open {
                self.skipped += 1;
            } else if self.more.len() < MORE_MAX {
                if !self.more.is_empty() {
                    self.more.push('\n');
                }
                let room = MORE_MAX - self.more.len();
                self.more.push_str(cut(&text, room));
            }
            return Ok(());
        };
        if self.events >= self.max_events {
            self.truncated = true;
            return self.flush(out);
        }
        self.flush(out)?;
        let tid = match self.track {
            None => 2, // named "log" in the header
            Some(i) => self.tid(out, p.get(&text, i).trim())?,
        };
        let message = match fmt.message_field() {
            Some(i) => p.get(&text, i),
            None => &text,
        };
        let level = fmt.level_field().map(|i| p.get(&text, i).trim()).filter(|l| !l.is_empty());

        let e = &mut self.event;
        e.clear();
        e.extend_from_slice(b",\n{\"ph\":\"i\",\"s\":\"t\",\"pid\":1,\"tid\":");
        e.extend_from_slice(tid.to_string().as_bytes());
        e.extend_from_slice(b",\"ts\":");
        e.extend_from_slice(t.div_euclid(1000).to_string().as_bytes());
        e.extend_from_slice(b",\"name\":");
        let level = level.unwrap_or("log");
        json_str(e, level);
        e.extend_from_slice(b",\"cat\":");
        json_str(e, level);
        e.extend_from_slice(b",\"args\":{\"message\":");
        json_str(e, message);
        e.extend_from_slice(b",\"line\":");
        e.extend_from_slice((line + 1).to_string().as_bytes());
        for &i in &self.args {
            e.push(b',');
            json_str(e, &fmt.fields()[i].name);
            e.push(b':');
            json_str(e, p.get(&text, i).trim());
        }
        if !is_match {
            e.extend_from_slice(b",\"context\":true");
        }
        self.open = true;
        self.events += 1;
        Ok(())
    }

    /// The thread id of a track value; names a new track first. A number keeps its
    /// value as the id (Perfetto shows "Thread 12"); other values get the smallest
    /// free id and a thread name (Perfetto shows the name and the id, "main 3").
    fn tid(&mut self, out: &mut impl Write, value: &str) -> std::io::Result<u32> {
        if let Some(&t) = self.tids.get(value) {
            return Ok(t);
        }
        let numeric = value.parse::<u32>().ok().filter(|&n| n > 0 && !self.used.contains(&n));
        let tid = match numeric {
            Some(n) => n,
            None => {
                while self.used.contains(&self.next_tid) {
                    self.next_tid += 1;
                }
                self.next_tid
            }
        };
        self.used.insert(tid);
        if numeric.is_none() {
            let mut b = Vec::new();
            b.extend_from_slice(b",
{\"ph\":\"M\",\"pid\":1,\"tid\":");
            b.extend_from_slice(tid.to_string().as_bytes());
            b.extend_from_slice(b",\"name\":\"thread_name\",\"args\":{\"name\":");
            json_str(&mut b, if value.is_empty() { "(none)" } else { value });
            b.extend_from_slice(b"}}");
            out.write_all(&b)?;
        }
        self.tids.insert(value.to_string(), tid);
        Ok(tid)
    }

    /// Write the open event.
    fn flush(&mut self, out: &mut impl Write) -> std::io::Result<()> {
        if !self.open {
            return Ok(());
        }
        self.open = false;
        out.write_all(&self.event)?;
        if !self.more.is_empty() {
            let mut b = Vec::with_capacity(self.more.len() + 16);
            b.extend_from_slice(b",\"more\":");
            json_str(&mut b, &self.more);
            out.write_all(&b)?;
            self.more.clear();
        }
        out.write_all(b"}}")
    }

    pub fn finish(&mut self, out: &mut impl Write) -> std::io::Result<()> {
        self.flush(out)?;
        out.write_all(b"\n],\"displayTimeUnit\":\"ms\"}\n")
    }
}

/// At most `max` bytes of `s`, at a character boundary.
fn cut(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// `s` as a JSON string.
fn json_str(out: &mut Vec<u8>, s: &str) {
    out.push(b'"');
    let bytes = s.as_bytes();
    let mut start = 0;
    for (i, &c) in bytes.iter().enumerate() {
        let esc: &[u8] = match c {
            b'"' => b"\\\"",
            b'\\' => b"\\\\",
            b'\n' => b"\\n",
            b'\r' => b"\\r",
            b'\t' => b"\\t",
            0..=0x1f => b"",
            _ => continue,
        };
        out.extend_from_slice(&bytes[start..i]);
        if esc.is_empty() {
            out.extend_from_slice(format!("\\u{c:04x}").as_bytes());
        } else {
            out.extend_from_slice(esc);
        }
        start = i + 1;
    }
    out.extend_from_slice(&bytes[start..]);
    out.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace(text: &str, pattern: &str, track: Option<&str>, max: u64, context_lines: &[u64]) -> (serde_json::Value, PerfettoWriter<'static>) {
        let fmt: &'static LogFormat = Box::leak(Box::new(LogFormat::compile(pattern).unwrap()));
        let track = track_field(fmt, track).unwrap();
        let mut w = PerfettoWriter::new(fmt, "app.log", track, max);
        let mut out = Vec::new();
        w.header(&mut out).unwrap();
        for (i, l) in text.lines().enumerate() {
            w.row(&mut out, i as u64, l.as_bytes(), !context_lines.contains(&(i as u64))).unwrap();
        }
        w.finish(&mut out).unwrap();
        let v = serde_json::from_slice(&out).unwrap_or_else(|e| panic!("{e}\n{}", String::from_utf8_lossy(&out)));
        (v, w)
    }

    const PATTERN: &str = "[%Y-%m-%d %H:%M:%S.%e] [%l] [%n] [%{thread}] %v";

    #[test]
    fn lines_become_instant_events_on_thread_tracks() {
        let text = "\
            [2026-11-20 10:00:00.001] [INFO] [net.http] [12] get \"/a\"\n\
            [2026-11-20 10:00:00.002] [ERROR] [core] [worker-1] boom\twith tab\n\
            \x20   at frame 1\n\
            \x20   at frame 2\n\
            [2026-11-20 10:00:01.000] [WARN] [core] [12] slow\n";
        let (v, w) = trace(text, PATTERN, None, 100, &[4]);
        assert_eq!(v["displayTimeUnit"], "ms");
        let ev = v["traceEvents"].as_array().unwrap();
        let meta: Vec<_> = ev.iter().filter(|e| e["ph"] == "M").collect();
        assert_eq!(meta[0]["args"]["name"], "app.log");
        // thread 12 keeps its number and needs no name; worker-1 gets the first free id
        // (1 is the process)
        assert_eq!(meta.len(), 2);
        assert_eq!((meta[1]["tid"].as_u64(), meta[1]["args"]["name"].as_str()), (Some(2), Some("worker-1")));
        let named = 2;

        let inst: Vec<_> = ev.iter().filter(|e| e["ph"] == "i").collect();
        assert_eq!(inst.len(), 3);
        assert_eq!(w.events, 3);
        let e = inst[0];
        assert_eq!((e["s"].as_str(), e["pid"].as_u64(), e["tid"].as_u64()), (Some("t"), Some(1), Some(12)));
        assert_eq!(e["ts"].as_i64(), Some(1_795_168_800_001_000));
        assert_eq!((e["name"].as_str(), e["cat"].as_str()), (Some("INFO"), Some("INFO")));
        assert_eq!(e["args"]["message"], "get \"/a\"");
        assert_eq!(e["args"]["line"], 1);
        assert_eq!(e["args"]["domain"], "net.http");
        assert_eq!(e["args"]["thread"], "12");
        assert!(e["args"].get("context").is_none());
        // the stack trace lines join the event before them
        assert_eq!(inst[1]["tid"].as_u64(), Some(named));
        assert_eq!(inst[1]["args"]["message"], "boom\twith tab");
        assert_eq!(inst[1]["args"]["more"], "    at frame 1\n    at frame 2");
        assert_eq!(inst[2]["args"]["context"], true);
        assert_eq!(inst[2]["args"]["line"], 5);
    }

    #[test]
    fn stops_at_the_event_limit() {
        let long = "x".repeat(250);
        let mut text = String::from("  orphan line without time\n");
        for i in 0..10 {
            text.push_str(&format!("[2026-11-20 10:00:00.{i:03}] [INFO] [core] [{}] {long}{i}\n", i % 3 + 1));
        }
        let (v, w) = trace(&text, PATTERN, Some("Domain"), 4, &[]);
        assert!(w.truncated && w.full());
        assert_eq!((w.events, w.skipped), (4, 1));
        let ev = v["traceEvents"].as_array().unwrap();
        let inst: Vec<_> = ev.iter().filter(|e| e["ph"] == "i").collect();
        assert_eq!(inst.len(), 4);
        assert_eq!(inst[3]["args"]["message"], format!("{long}3"));
        // tracks by domain: one named track
        assert_eq!(ev.iter().filter(|e| e["name"] == "thread_name").count(), 1);
    }

    #[test]
    fn named_and_numbered_tracks_never_share_an_id() {
        let mut text = String::new();
        for t in ["main", "2", "1", "io", "3"] {
            text.push_str(&format!("[2026-11-20 10:00:00.000] [INFO] [core] [{t}] x\n"));
        }
        let (v, _) = trace(&text, PATTERN, None, 100, &[]);
        let tids: Vec<u64> = v["traceEvents"].as_array().unwrap().iter().filter(|e| e["ph"] == "i").map(|e| e["tid"].as_u64().unwrap()).collect();
        // main 2 (1 is the process), thread "2" (taken) 3, thread "1" (taken) 4, io 5,
        // thread "3" (taken) 6
        assert_eq!(tids, [2, 3, 4, 5, 6]);
    }

    #[test]
    fn without_a_text_field_everything_is_one_track() {
        let (v, _) = trace("2026-11-20 10:00:00 hello \u{1}\n", "%Y-%m-%d %H:%M:%S %v", None, 10, &[]);
        let ev = v["traceEvents"].as_array().unwrap();
        let e = ev.iter().find(|e| e["ph"] == "i").unwrap();
        assert_eq!((e["tid"].as_u64(), e["cat"].as_str(), e["name"].as_str()), (Some(2), Some("log"), Some("log")));
        assert_eq!(e["args"]["message"], "hello \u{1}");
        assert!(track_field(&LogFormat::compile(PATTERN).unwrap(), Some("nope")).is_err());
    }
}
