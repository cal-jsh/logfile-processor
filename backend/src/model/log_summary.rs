// serde
use serde::Serialize;
// utoipa
use utoipa::ToSchema;
// std
use std::collections::HashMap;

#[derive(Serialize, ToSchema, Debug)]
pub struct LogSummary {
    /// Total number of lines in the log
    pub total_lines: usize,
    /// Count of log entries per level, e.g., {"INFO": 123, "WARN": 5}
    pub levels: HashMap<String, usize>,
    /// List of unique domains found in the log
    pub unique_domains: Vec<String>,
    /// Timestamp of the first log entry
    pub start_timestamp: Option<String>,
    /// Timestamp of the last log entry
    pub stop_timestamp: Option<String>,
}