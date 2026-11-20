//! Line format preview, for the "Log format" dialog.
//!
//! `GET /format/test?session_id=..[&pattern=..]` splits the first lines of the open file
//! with `pattern` (spdlog syntax; without it, with the format detected for the file) and
//! returns how many of them it matches and the fields of the first few. Nothing about
//! the session changes; applying a pattern reopens the file (`reformat_session`).

use crate::api::view::{split_for_display, ApiError};
use crate::log_storage::get_user_log;
use crate::logfile::index::sample_lines;
use crate::parsing::format::{detect, sample_fit, FieldDef, LogFormat};
use axum::{extract::Query, http::StatusCode, routing::get, Json, Router};
use serde::{Deserialize, Serialize};

/// Lines returned as a preview.
const PREVIEW_LINES: usize = 12;

pub fn router() -> Router {
    Router::new().route("/format/test", get(test_format))
}

#[derive(Deserialize)]
pub struct FormatQuery {
    pub session_id: String,
    pub pattern: Option<String>,
}

#[derive(Serialize)]
pub struct PreviewLine {
    pub line_number: u64,
    pub text: String,
    /// `null` if the line does not have the format
    pub fields: Option<Vec<String>>,
}

#[derive(Serialize)]
pub struct FormatTest {
    /// The pattern tested
    pub pattern: String,
    /// Why the pattern is invalid; the other fields are then empty
    pub error: Option<String>,
    pub columns: Vec<FieldDef>,
    /// Non-empty lines at the start of the file
    pub sample_lines: usize,
    /// Of those, the lines in the format
    pub matched: usize,
    pub lines: Vec<PreviewLine>,
    /// What auto-detection picks for this file
    pub detected_pattern: String,
}

pub async fn test_format(Query(q): Query<FormatQuery>) -> Result<Json<FormatTest>, ApiError> {
    let session = get_user_log(&q.session_id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Session ID not found".into()))?;
    let file = session.file.clone();
    tokio::task::spawn_blocking(move || {
        let sample = sample_lines(&file);
        let refs: Vec<&str> = sample.iter().map(String::as_str).collect();
        let detected = detect(&refs).format;
        let pattern = q.pattern.as_deref().map(str::trim).filter(|p| !p.is_empty());
        let format = match pattern.map(LogFormat::compile) {
            None => detected.clone(),
            Some(Ok(f)) => f,
            Some(Err(e)) => {
                return FormatTest {
                    pattern: pattern.unwrap_or_default().to_string(),
                    error: Some(e),
                    columns: vec![],
                    sample_lines: 0,
                    matched: 0,
                    lines: vec![],
                    detected_pattern: detected.pattern().to_string(),
                }
            }
        };
        let (sample_lines, matched) = sample_fit(&format, &refs);
        let lines = sample
            .iter()
            .enumerate()
            .filter(|(_, t)| !t.trim().is_empty())
            .take(PREVIEW_LINES)
            .map(|(i, text)| PreviewLine {
                line_number: i as u64 + 1,
                text: text.clone(),
                fields: split_for_display(&format, text).0,
            })
            .collect();
        FormatTest {
            pattern: format.pattern().to_string(),
            error: None,
            columns: format.fields().to_vec(),
            sample_lines,
            matched,
            lines,
            detected_pattern: detected.pattern().to_string(),
        }
    })
    .await
    .map(Json)
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}
