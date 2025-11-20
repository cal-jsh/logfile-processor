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
        r"^\[(?P<ts>[^\]]+)\]\s\[(?P<level>[^\]]+)\]\s\[(?P<domain>[^\]]+)\]\s*(?P<message>.*)$"
    ).unwrap()
});

/// Parse log text and optionally filter by domains or levels
pub fn parse_log(
    log_text: &str,
    filter_domains: Option<&Vec<String>>,
    filter_levels: Option<&Vec<String>>,
) -> LogSummary {
    let mut total_lines = 0;
    let mut levels = HashMap::new();
    let mut domains = HashSet::new();

    for line in log_text.lines() {
        if let Some(caps) = LOG_REGEX.captures(line) {
            let level = &caps["level"];
            let domain = &caps["domain"];

            if filter_levels.as_ref().map_or(true, |l| l.contains(&level.to_string())) &&
               filter_domains.as_ref().map_or(true, |d| d.contains(&domain.to_string()))
            {
                total_lines += 1;
                *levels.entry(level.to_string()).or_insert(0) += 1;
                domains.insert(domain.to_string());
            }
        }
    }

    LogSummary {
        total_lines,
        levels,
        unique_domains: domains.into_iter().collect(),
    }
}
