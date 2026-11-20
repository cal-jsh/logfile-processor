//! The original line format of this app, `[ts] [LEVEL] [domain] message`, as a regex.
//!
//! Lines are now split by [`LogFormat`](crate::parsing::format::LogFormat); this regex is
//! kept as the reference that its `[%{time}] [%l] [%n] %v` pattern is tested against.

use once_cell::sync::Lazy;
use regex::Regex;

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

/// Split a line with the original regex.
pub fn split_regex(line: &str) -> Option<LogFields<'_>> {
    let caps = LOG_REGEX.captures(line)?;
    Some(LogFields {
        ts: caps.name("ts").map_or("", |m| m.as_str()),
        level: caps.name("level").map_or("", |m| m.as_str()),
        domain: caps.name("domain").map_or("", |m| m.as_str()),
        message: caps.name("message").map_or("", |m| m.as_str()),
    })
}
