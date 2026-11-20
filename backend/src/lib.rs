//! Log file processor: memory-mapped, indexed log files behind an HTTP viewport API.
//!
//! Used by the Tauri desktop app (`frontend/src-tauri`), which serves the API on a
//! private localhost port and opens files in place by path.

pub mod api;
pub mod log_storage;
pub mod logfile;
pub mod model;
pub mod parsing;

use crate::log_storage::{get_user_log, remove_user_log, save_user_log, Session};
use crate::logfile::index::{sample_lines, LogFile};
use crate::logfile::scan::summarize;
use crate::model::upload_response::UploadResponse;
use crate::parsing::format::{detect, sample_fit, LogFormat};
use axum::Router;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tower_http::cors::{Any, CorsLayer};
use tracing::{debug, info};

/// Routes for the desktop app: the viewport API only. No upload (files are opened in
/// place by path), and CORS limited to the app's own webview origins.
pub fn desktop_router() -> Router {
    let origins = [
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
        // `tauri dev` loads the UI from the Vite dev server
        "http://localhost:3000",
    ]
    .map(|o| o.parse::<axum::http::HeaderValue>().expect("valid origin"));
    let cors = CorsLayer::new()
        .allow_origin(origins)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .merge(api::view::router())
        .merge(api::minimap::router())
        .merge(api::lanes::router())
        .merge(api::version::router())
        .merge(api::format::router())
        .layer(cors)
}

/// Memory-map `path`, build the sparse line index and the summary, and register a
/// session for it. Blocking: call it off the async runtime.
///
/// The line format is detected from the first lines, unless `pattern` (spdlog syntax)
/// is given. The file is opened in place and never modified or deleted.
pub fn open_session(path: PathBuf, pattern: Option<String>) -> std::io::Result<UploadResponse> {
    let file = Arc::new(LogFile::open(&path)?);
    start_session(path, file, pattern.as_deref())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))
}

/// Open the file of an existing session again with another line format (`None`:
/// detect it), reusing its line index. The old session is closed. Blocking.
pub fn reformat_session(session_id: &str, pattern: Option<String>) -> Result<UploadResponse, String> {
    let old = get_user_log(session_id).ok_or("Session ID not found")?;
    let resp = start_session(old.path.clone(), old.file.clone(), pattern.as_deref())?;
    remove_user_log(session_id);
    Ok(resp)
}

/// The line format of a file, and how well it fits the first lines.
pub struct ChosenFormat {
    pub format: LogFormat,
    /// Detected (not given as a pattern)
    pub detected: bool,
    pub sample_lines: usize,
    pub sample_matched: usize,
}

/// Compile `pattern` (spdlog syntax), or detect the format from the first lines when
/// there is none. The viewer and the command line both choose the format this way.
pub fn choose_format(file: &LogFile, pattern: Option<&str>) -> Result<ChosenFormat, String> {
    let sample = sample_lines(file);
    let sample: Vec<&str> = sample.iter().map(String::as_str).collect();
    Ok(match pattern.map(str::trim) {
        Some(p) if !p.is_empty() => {
            let format = LogFormat::compile(p).map_err(|e| format!("Invalid pattern: {e}"))?;
            let (sample_lines, sample_matched) = sample_fit(&format, &sample);
            ChosenFormat { format, detected: false, sample_lines, sample_matched }
        }
        _ => {
            let d = detect(&sample);
            ChosenFormat { format: d.format, detected: true, sample_lines: d.sample_lines, sample_matched: d.matched_lines }
        }
    })
}

fn start_session(path: PathBuf, file: Arc<LogFile>, pattern: Option<&str>) -> Result<UploadResponse, String> {
    let session_id = uuid::Uuid::new_v4().to_string();

    let started = Instant::now();
    let ChosenFormat { format, detected, sample_lines, sample_matched } = choose_format(&file, pattern)?;
    let format_ms = started.elapsed().as_secs_f64() * 1000.0;

    let started = Instant::now();
    let mut summary = summarize(&file, &format);
    let summary_ms = started.elapsed().as_secs_f64() * 1000.0;
    summary.format.detected = detected;
    summary.format.sample_lines = sample_lines;
    summary.format.sample_matched = sample_matched;

    let index_ms = file.index_time.as_secs_f64() * 1000.0;
    info!(
        "Indexed {} lines ({} bytes) of {} in {:.1} ms, format {} `{}` ({}/{} sample lines) in {:.1} ms, summary in {:.1} ms, session {}",
        file.line_count(),
        file.len(),
        path.display(),
        index_ms,
        if detected { "detected" } else { "set" },
        format.pattern(),
        sample_matched,
        sample_lines,
        format_ms,
        summary_ms,
        session_id
    );
    debug!("Summary: {:?}", summary);

    save_user_log(&session_id, Session::new(path, file, Arc::new(format)));
    Ok(UploadResponse { session_id, summary, index_ms, summary_ms, format_ms })
}
