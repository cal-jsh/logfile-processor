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
}
