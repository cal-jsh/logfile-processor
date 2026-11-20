//! Log file processor: memory-mapped, indexed log files behind an HTTP viewport API.
//!
//! Used by the Tauri desktop app (`frontend/src-tauri`), which serves the API on a
//! private localhost port and opens files in place by path.

pub mod api;
pub mod log_storage;
pub mod logfile;
pub mod model;
pub mod parsing;

use crate::log_storage::{save_user_log, Session};
use crate::logfile::index::LogFile;
use crate::logfile::scan::summarize;
use crate::model::upload_response::UploadResponse;
use axum::Router;
use std::path::PathBuf;
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
        .merge(api::version::router())
        .layer(cors)
}

/// Memory-map `path`, build the sparse line index and the summary, and register a
/// session for it. Blocking: call it off the async runtime.
///
/// The file is opened in place and never modified or deleted.
pub fn open_session(path: PathBuf) -> std::io::Result<UploadResponse> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let file = LogFile::open(&path)?;
    let started = Instant::now();
    let summary = summarize(&file);
    let summary_time = started.elapsed();

    let index_ms = file.index_time.as_secs_f64() * 1000.0;
    let summary_ms = summary_time.as_secs_f64() * 1000.0;
    info!(
        "Indexed {} lines ({} bytes) of {} in {:.1} ms, summary in {:.1} ms, session {}",
        file.line_count(),
        file.len(),
        path.display(),
        index_ms,
        summary_ms,
        session_id
    );
    debug!("Summary: {:?}", summary);

    save_user_log(&session_id, Session::new(path, file));
    Ok(UploadResponse { session_id, summary, index_ms, summary_ms })
}
