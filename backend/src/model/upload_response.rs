use crate::model::log_summary::LogSummary;
// serde
use serde::Serialize;
// utoipa
use utoipa::ToSchema;

#[derive(Serialize, ToSchema)]
pub struct UploadResponse {
    // Unique session identifier for the uploaded log
    pub session_id: String,
    // Summary of the uploaded log
    pub summary: LogSummary,
    /// Time to build the line index, in milliseconds
    pub index_ms: f64,
    /// Time to compute the summary, in milliseconds
    pub summary_ms: f64,
}
