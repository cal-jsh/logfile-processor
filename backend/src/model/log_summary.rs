// local
use crate::parsing::format::FieldDef;
// serde
use serde::Serialize;
// utoipa
use utoipa::ToSchema;
// std
use std::collections::HashMap;

#[derive(Serialize, ToSchema, Debug)]
pub struct LogSummary {
    /// Number of lines in the log format
    pub total_lines: usize,
    /// Number of lines in the file, including lines not in the log format
    pub line_count: u64,
    /// Count of log entries per level, e.g., {"INFO": 123, "WARN": 5}
    pub levels: HashMap<String, usize>,
    /// The filterable fields of the format (domain, thread, ...) with their values
    #[schema(value_type = Vec<Object>)]
    pub fields: Vec<FieldValues>,
    /// Timestamp of the first log entry
    pub start_timestamp: Option<String>,
    /// Timestamp of the last log entry
    pub stop_timestamp: Option<String>,
    /// The same two as ms since 1970 in the log's own clock, if they can be read
    pub start_ms: Option<f64>,
    pub stop_ms: Option<f64>,
    /// The line format used for this file
    #[schema(value_type = Object)]
    pub format: FormatInfo,
}

/// The distinct values of one field.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct FieldValues {
    pub name: String,
    pub label: String,
    /// Sorted; at most [`MAX_FIELD_VALUES`](crate::logfile::scan::MAX_FIELD_VALUES)
    pub values: Vec<String>,
    /// There are more values than listed
    pub more: bool,
}

/// The line format of an open file.
#[derive(Serialize, Debug, Clone)]
pub struct FormatInfo {
    /// spdlog-style pattern, e.g. `[%Y-%m-%d %H:%M:%S.%e] [%t] [%l] %v`
    pub pattern: String,
    /// Chosen automatically (`false`: set by the user)
    pub detected: bool,
    /// Every line is shown as it is (no known format fits the file)
    pub raw: bool,
    /// Non-empty lines at the start of the file used to detect or check the format
    pub sample_lines: usize,
    /// Of those, the lines in the format
    pub sample_matched: usize,
    /// The fields of the format, in line order
    pub columns: Vec<FieldDef>,
}
