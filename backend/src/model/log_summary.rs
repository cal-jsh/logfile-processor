// serde
use serde::Serialize;
// utoipa
use utoipa::ToSchema;
// std
use std::collections::HashMap;

#[derive(Serialize, ToSchema, Debug)]
pub struct LogSummary {
    /// Number of lines in the `[ts] [LEVEL] [domain] message` format
    pub total_lines: usize,
    /// Number of lines in the file, including lines not in the log format
    pub line_count: u64,
    /// Count of log entries per level, e.g., {"INFO": 123, "WARN": 5}
    pub levels: HashMap<String, usize>,
    /// List of unique domains found in the log
    pub unique_domains: Vec<String>,
    /// Timestamp of the first log entry
    pub start_timestamp: Option<String>,
    /// Timestamp of the last log entry
    pub stop_timestamp: Option<String>,
}
