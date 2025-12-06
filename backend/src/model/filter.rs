// local
use crate::model::log_summary::LogSummary;
// serde
use serde::{Deserialize, Serialize};
// utoipa
use utoipa::ToSchema;

/// Request payload for filtering logs
#[derive(Deserialize, ToSchema)]
pub struct FilterRequest {
    /// Full log text
    pub log_text: String,

    /// Optional list of domains to filter by
    pub domains: Option<Vec<String>>,

    /// Optional list of log levels to filter by
    pub levels: Option<Vec<String>>,
}

/// Response after filtering logs
#[derive(Serialize, ToSchema)]
pub struct FilteredLogResponse {
    /// Lines of the log that match the filter
    pub filtered_lines: Vec<String>,

    /// Summary of the filtered log
    pub summary: LogSummary,
}
