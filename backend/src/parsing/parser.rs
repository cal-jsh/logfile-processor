// local
use crate::model::log_summary::LogSummary;
// once_cell
use once_cell::sync::Lazy;
// regex
use regex::Regex;
// std
use std::collections::{HashMap, HashSet};

pub static LOG_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^\[(?P<ts>[^\]]+)\]\s\[(?P<level>[^\]]+)\]\s\[(?P<domain>[^\]]+)\]\s*(?P<message>.*)$",
    )
    .unwrap()
});

/// The fields of a `[ts] [LEVEL] [domain] message` line.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct LogFields<'a> {
    pub ts: &'a str,
    pub level: &'a str,
    pub domain: &'a str,
    pub message: &'a str,
}

/// Split a line into its fields, with exactly the semantics of [`LOG_REGEX`], but
/// without running the regex and without allocating.
/// `split_regex` is the reference implementation; the tests check they agree.
pub fn split_log_line(line: &str) -> Option<LogFields<'_>> {
    let b = line.as_bytes();
    // `.` in the message does not match '\n', so such lines never match.
    if memchr::memchr(b'\n', b).is_some() {
        return None;
    }
    let mut pos = 0usize;
    let mut fields = [""; 3];
    for (i, field) in fields.iter_mut().enumerate() {
        // `[` + at least one non-`]` + `]`
        if b.get(pos) != Some(&b'[') {
            return None;
        }
        let close = memchr::memchr(b']', &b[pos + 1..])?;
        if close == 0 {
            return None;
        }
        *field = &line[pos + 1..pos + 1 + close];
        pos += close + 2;
        if i < 2 {
            // exactly one whitespace character (`\s` is Unicode White_Space, the same
            // property as `char::is_whitespace`)
            let c = line[pos..].chars().next().filter(|c| c.is_whitespace())?;
            pos += c.len_utf8();
        }
    }
    // `\s*` then the message
    let message = line[pos..].trim_start_matches(char::is_whitespace);
    Some(LogFields { ts: fields[0], level: fields[1], domain: fields[2], message })
}

/// Reference implementation of [`split_log_line`], using the regex.
#[cfg_attr(not(test), allow(dead_code))]
pub fn split_regex(line: &str) -> Option<LogFields<'_>> {
    let caps = LOG_REGEX.captures(line)?;
    Some(LogFields {
        ts: caps.name("ts").map_or("", |m| m.as_str()),
        level: caps.name("level").map_or("", |m| m.as_str()),
        domain: caps.name("domain").map_or("", |m| m.as_str()),
        message: caps.name("message").map_or("", |m| m.as_str()),
    })
}

/// Parse log text and optionally filter by domains or levels
pub fn parse_log(
    log_text: &str,
    filter_domains: Option<&Vec<String>>,
    filter_levels: Option<&Vec<String>>,
) -> LogSummary {
    let mut total_lines = 0;
    let mut levels = HashMap::new();
    let mut domains = HashSet::new();
    let mut start_timestamp: Option<String> = None;
    let mut stop_timestamp: Option<String> = None;

    for line in log_text.lines() {
        if let Some(caps) = LOG_REGEX.captures(line) {
            let ts = &caps["ts"];
            let level = &caps["level"];
            let domain = &caps["domain"];

            if filter_levels
                .as_ref()
                .map_or(true, |l| l.contains(&level.to_string()))
                && filter_domains
                    .as_ref()
                    .map_or(true, |d| d.contains(&domain.to_string()))
            {
                total_lines += 1;
                *levels.entry(level.to_string()).or_insert(0) += 1;
                domains.insert(domain.to_string());

                // Track first and last timestamp
                if start_timestamp.is_none() {
                    start_timestamp = Some(ts.to_string());
                }
                stop_timestamp = Some(ts.to_string());
            }
        }
    }

    LogSummary {
        total_lines,
        line_count: log_text.lines().count() as u64,
        levels,
        unique_domains: domains.into_iter().collect(),
        start_timestamp,
        stop_timestamp,
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod split_tests {
    use super::*;

    #[test]
    fn fast_split_agrees_with_regex() {
        let cases = [
            "[2025-01-01 10:00:00] [INFO] [core] Starting process",
            "[t] [ERROR] [Net] x",
            "[t] [ERROR] [Net]x",
            "[t] [ERROR] [Net]    lots of space",
            "[t] [ERROR] [Net]\t\ttabbed",
            "[t] [ERROR] [Net]",
            "[t] [ERROR] [Net] ",
            "[t]  [ERROR] [Net] two spaces before level",
            "[t][ERROR] [Net] no space",
            "[t]\t[ERROR]\u{a0}[Net]\u{2003}unicode spaces",
            "[t] [ERROR] [Net]\u{a0}\u{a0}nbsp before message",
            "[t] [ERROR] [Net] é first char non-ascii",
            "[] [ERROR] [Net] empty ts",
            "[t] [] [Net] empty level",
            "[t] [ERROR] [] empty domain",
            "[t] [ERROR] [Net] msg with ] and [ brackets",
            "[t] [ERROR] [Net] carriage\rreturn inside",
            "[t] [ERROR] [Net] new\nline inside",
            "[[t]] [ERROR] [Net] nested",
            "[t [ERROR] [Net] unclosed",
            "  [t] [ERROR] [Net] leading space",
            "not a log line",
            "",
            "[",
            "[t]",
            "[t] ",
            "[t] [L]",
            "[t] [L] ",
            "[t] [L] [",
            "[t] [L] [d",
            "[t] [L] [d]",
            "[t]\u{85}[L]\u{85}[d]\u{85}next-line char",
            "[t]\u{b}[L]\u{c}[d]\u{b}vertical tab",
            "[ts with spaces] [WARN] [dom ain] m",
        ];
        for c in cases {
            assert_eq!(split_log_line(c), split_regex(c), "{c:?}");
        }
    }
}
