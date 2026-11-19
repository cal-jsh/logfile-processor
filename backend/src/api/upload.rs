// local
use crate::log_storage::{save_user_log, Session};
use crate::logfile::index::LogFile;
use crate::logfile::scan::summarize;
use crate::model::upload_response::UploadResponse;
// axum
use axum::{
    extract::Multipart, http::StatusCode, response::IntoResponse, routing::post, Json, Router,
};
// use axum_extra::extract::Multipart;
// tokio
use tokio::io::AsyncWriteExt;
// uuid
use uuid::Uuid;
// utoipa
use utoipa::ToSchema;
// tracing
use tracing::{debug, error, info, trace};
// std
use std::path::PathBuf;
use std::time::Instant;

/// Build the router
pub fn router() -> Router {
    Router::new().route("/upload", post(upload_handler))
}

/// Dummy type to document multipart request body
#[derive(ToSchema)]
pub struct UploadFileBody {
    /// The log file to upload
    #[allow(dead_code)]
    #[schema(format = "binary")]
    pub file: Vec<u8>,
}

/// Upload and parse a log file
#[utoipa::path(
    post,
    path = "/upload",
    request_body(
        content = UploadFileBody,
        description = "Log file to upload. Only the first file in the multipart request is processed. Maximum size: 1 GB",
    ),
    responses(
        (status = 200, description = "Upload successful, returns session ID and log summary", body = UploadResponse),
        (status = 400, description = "No file uploaded or invalid multipart request"),
        (status = 500, description = "Internal server error while creating directories, writing, or reading the file")
    ),
    tag = "Log Upload"
)]
pub async fn upload_handler(mut multipart: Multipart) -> impl IntoResponse {
    // Generate session ID
    let session_id = Uuid::new_v4().to_string();

    // Ensure upload directory exists
    let upload_dir = PathBuf::from("./uploads");
    if let Err(e) = tokio::fs::create_dir_all(&upload_dir).await {
        error!("Failed to create upload directory: {:?}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create upload directory",
        )
            .into_response();
    }

    let file_path = upload_dir.join(format!("{}.log", session_id));
    let mut uploaded = false;

    while let Ok(Some(mut field)) = multipart.next_field().await {
        debug!("Processing uploaded field: {:?}", field.name());
        let mut file = match tokio::fs::File::create(&file_path).await {
            Ok(f) => f,
            Err(e) => {
                error!("Failed to create file: {:?}", e);
                return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create file")
                    .into_response();
            }
        };

        while let Ok(Some(chunk)) = field.chunk().await {
            trace!("Writing chunk of size: {}", chunk.len());
            if let Err(e) = file.write_all(&chunk).await {
                error!("Failed writing chunk: {:?}", e);
                return (StatusCode::INTERNAL_SERVER_ERROR, "Failed writing file").into_response();
            }
        }

        // tokio::fs::File finishes writes in the background; flush so the whole file is
        // on disk before it is memory-mapped below.
        if let Err(e) = file.flush().await {
            error!("Failed flushing file: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed writing file").into_response();
        }

        debug!("Finished writing file to {:?}", file_path);

        uploaded = true;
        break; // only handle first file
    }

    if !uploaded {
        return (StatusCode::BAD_REQUEST, "No file uploaded").into_response();
    }

    // Memory-map the file, build the sparse line index and the summary, in parallel,
    // off the async runtime. The file is never read into a String.
    let path = file_path.clone();
    let opened = tokio::task::spawn_blocking(move || {
        let file = LogFile::open(&path)?;
        let started = Instant::now();
        let summary = summarize(&file);
        Ok::<_, std::io::Error>((file, summary, started.elapsed()))
    })
    .await;
    let (file, summary, summary_time) = match opened {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            error!("Failed to open log file for indexing: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to open log file").into_response();
        }
        Err(e) => {
            error!("Indexing task failed: {:?}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to index log file").into_response();
        }
    };
    let index_ms = file.index_time.as_secs_f64() * 1000.0;
    let summary_ms = summary_time.as_secs_f64() * 1000.0;
    info!(
        "Indexed {} lines ({} bytes) in {:.1} ms, summary in {:.1} ms, session {}",
        file.line_count(),
        file.len(),
        index_ms,
        summary_ms,
        session_id
    );
    debug!("Summary: {:?}", summary);

    // Save the session (indexed file + result cache)
    save_user_log(&session_id, Session::new(file_path, file));

    // Respond with session ID and the actual summary
    Json(UploadResponse {
        session_id,
        summary,
        index_ms,
        summary_ms,
    })
    .into_response()
}
