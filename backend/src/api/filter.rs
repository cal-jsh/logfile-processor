// local
use crate::model::filter::FilterRequest;
use crate::model::filter::FilteredLogResponse;
use crate::parsing::parser::parse_log;
// axum
use axum::{extract::Json as AxumJson, routing::post, Json, Router};

pub fn router() -> Router {
    Router::new().route("/filter", post(filter_handler))
}

/// Filter log lines and produce a summary
#[utoipa::path(
    post,
    path = "/filter",
    request_body = FilterRequest,
    responses(
        (status = 200, description = "Filtered log lines with summary", body = FilteredLogResponse)
    )
)]
pub async fn filter_handler(AxumJson(req): AxumJson<FilterRequest>) -> Json<FilteredLogResponse> {
    let summary = parse_log(&req.log_text, req.domains.as_ref(), req.levels.as_ref());

    // Also collect the filtered lines
    let lines: Vec<String> = req
        .log_text
        .lines()
        .filter(|line| {
            if let Some(caps) = crate::parsing::parser::LOG_REGEX.captures(line) {
                let level = &caps["level"];
                let domain = &caps["domain"];
                req.levels
                    .as_ref()
                    .map_or(true, |l| l.contains(&level.to_string()))
                    && req
                        .domains
                        .as_ref()
                        .map_or(true, |d| d.contains(&domain.to_string()))
            } else {
                false
            }
        })
        .map(|s| s.to_string())
        .collect();

    Json(FilteredLogResponse {
        filtered_lines: lines,
        summary,
    })
}
