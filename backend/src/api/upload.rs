// local
use crate::parsing::parser::parse_log;
use crate::model::upload_response::UploadResponse;
use crate::log_storage::save_user_log;
// axum
use axum::{routing::post, extract::Multipart, extract::Json, Router};

use uuid::Uuid;

pub fn router() -> Router {
    Router::new().route("/upload", post(upload_handler))
}

/// Upload and parse a log file
#[utoipa::path(
    post,
    path = "/upload",
    responses(
        (status = 200, description = "Upload response with session id and log summary", body = UploadResponse)
    )
)]
pub async fn upload_handler(mut multipart: Multipart) -> Json<UploadResponse> {
    let mut log_text = String::new();

    while let Some(field) = multipart.next_field().await.unwrap() {
        if let Ok(text) = field.text().await {
            log_text = text;
            break;
        }
    }

    let session_id = Uuid::new_v4().to_string();
    save_user_log(&session_id, log_text.clone());
    let summary = parse_log(&log_text, None, None); // no filters initially

    Json(UploadResponse { session_id, summary })
}