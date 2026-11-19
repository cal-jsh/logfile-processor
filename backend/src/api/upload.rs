// local
use crate::model::upload_response::UploadResponse;
use crate::open_session;
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
use tracing::{debug, error, trace};
// std
use std::path::PathBuf;

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
    // Name of the private copy
    let upload_id = Uuid::new_v4().to_string();

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

    let file_path = upload_dir.join(format!("{}.log", upload_id));
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
    // off the async runtime. The file is never read into a String. The upload is a
    // private copy, so the session owns it and deletes it on close.
    let opened = tokio::task::spawn_blocking(move || open_session(file_path, true)).await;
    match opened {
        Ok(Ok(resp)) => Json(resp).into_response(),
        Ok(Err(e)) => {
            error!("Failed to open log file for indexing: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to open log file").into_response()
        }
        Err(e) => {
            error!("Indexing task failed: {:?}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, "Failed to index log file").into_response()
        }
    }
}
