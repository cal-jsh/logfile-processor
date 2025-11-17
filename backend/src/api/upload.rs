// local
use crate::log_storage::save_user_log;
use crate::model::upload_response::UploadResponse;
use crate::model::log_summary::LogSummary;
use crate::parsing::parser::parse_log;
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
use tracing::info;
// std
use std::path::PathBuf;
use std::collections::HashMap;

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
        eprintln!("Failed to create upload directory: {:?}", e);
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to create upload directory",
        )
            .into_response();
    }

    let file_path = upload_dir.join(format!("{}.log", session_id));
    let mut uploaded = false;

    while let Ok(Some(mut field)) = multipart.next_field().await {
        info!("Processing uploaded field: {:?}", field.name());
        let mut file = match tokio::fs::File::create(&file_path).await {
            Ok(f) => f,
            Err(e) => {
                eprintln!("Failed to create file: {:?}", e);
                return (StatusCode::INTERNAL_SERVER_ERROR, "Failed to create file")
                    .into_response();
            }
        };

        while let Ok(Some(chunk)) = field.chunk().await {
            info!("Writing chunk of size: {}", chunk.len());
            if let Err(e) = file.write_all(&chunk).await {
                eprintln!("Failed writing chunk: {:?}", e);
                return (StatusCode::INTERNAL_SERVER_ERROR, "Failed writing file").into_response();
            }
        }

        info!("Finished writing file to {:?}", file_path);

        uploaded = true;
        break; // only handle first file
    }

    if !uploaded {
        return (StatusCode::BAD_REQUEST, "No file uploaded").into_response();
    }

    // Save session info (store path)
    save_user_log(&session_id, file_path.to_string_lossy().to_string());

    // Spawn background parsing without storing summary
    let file_path_clone = file_path.clone();
    let session_id_clone = session_id.clone();
    tokio::spawn(async move {
        if let Ok(log_text) = tokio::fs::read_to_string(&file_path_clone).await {
            let _summary = parse_log(&log_text, None, None);
            info!("Finished parsing log for session {}", session_id_clone);
        }
    });

    // respond immediately with session ID and placeholder summary
    let placeholder_summary = LogSummary {
        total_lines: 0,
        levels: HashMap::new(),
        unique_domains: vec![],
    };

    Json(UploadResponse {
        session_id,
        summary: placeholder_summary,
    })
    .into_response()
}
