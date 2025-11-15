// local
use crate::parsing::parser::parse_log;
use crate::model::log_summary::LogSummary;
// axum
use axum::{routing::post, extract::Multipart, Router};

pub fn router() -> Router {
    Router::new().route("/upload", post(upload_handler))
}

/// Upload and parse a log file
#[utoipa::path(
    post,
    path = "/upload",
    responses(
        (status = 200, description = "Parsed log summary", body = LogSummary)
    )
)]
pub async fn upload_handler(mut multipart: Multipart) -> axum::Json<LogSummary> {
    let mut contents = String::new();

    while let Some(field) = multipart.next_field().await.unwrap() {
        if field.name() == Some("file") {
            contents = field.text().await.unwrap();
        }
    }

    let summary = parse_log(&contents, None, None);

    axum::Json(summary)
}
