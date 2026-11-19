//! Log file processor: memory-mapped, indexed log files behind an HTTP viewport API.
//!
//! Used by the `logfile_processor` web server binary and by the Tauri desktop app,
//! which serves the same API on a private localhost port and opens files by path.

pub mod api;
pub mod api_doc;
pub mod log_storage;
pub mod logfile;
pub mod model;
pub mod parsing;

use crate::api_doc::ApiDoc;
use crate::log_storage::{save_user_log, Session};
use crate::logfile::index::LogFile;
use crate::logfile::scan::summarize;
use crate::model::upload_response::UploadResponse;
use axum::{extract::DefaultBodyLimit, Router};
use std::path::PathBuf;
use std::time::Instant;
use tower_http::cors::{Any, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tracing::{debug, info};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

/// All HTTP routes (upload, viewport API, Swagger UI), with open CORS.
pub fn router() -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .merge(api::upload::router())
        .layer(DefaultBodyLimit::disable())
        .layer(RequestBodyLimitLayer::new(1024 * 1024 * 1024))
        .merge(api::filter::router())
        .merge(api::view::router())
        .merge(api::minimap::router())
        .merge(api::version::router())
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .layer(cors)
}

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
/// `owned` means the file is a private copy (an upload) that is deleted when the
/// session closes. A file opened in place by the desktop app is never deleted.
pub fn open_session(path: PathBuf, owned: bool) -> std::io::Result<UploadResponse> {
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

    save_user_log(&session_id, Session::new(path, file, owned));
    Ok(UploadResponse { session_id, summary, index_ms, summary_ms })
}
