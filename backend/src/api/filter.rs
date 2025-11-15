use axum::{routing::post, Json, Router, extract::Json as AxumJson};
use crate::model::filter::FilterRequest;
use crate::parsing::parser::parse_log;
use crate::model::log_summary::LogSummary;

pub fn router() -> Router {
    Router::new().route("/filter", post(filter_handler))
}

#[derive(serde::Serialize)]
struct FilteredLogResponse {
    filtered_lines: Vec<String>,
    summary: LogSummary,
}

async fn filter_handler(AxumJson(req): AxumJson<FilterRequest>) -> Json<FilteredLogResponse> {
    let summary = parse_log(&req.log_text, req.domains.as_ref(), req.levels.as_ref());

    // Also collect the filtered lines
    let lines: Vec<String> = req.log_text
        .lines()
        .filter(|line| {
            if let Some(caps) = crate::parsing::parser::LOG_REGEX.captures(line) {
                let level = &caps["level"];
                let domain = &caps["domain"];
                req.levels.as_ref().map_or(true, |l| l.contains(&level.to_string())) &&
                req.domains.as_ref().map_or(true, |d| d.contains(&domain.to_string()))
            } else { false }
        })
        .map(|s| s.to_string())
        .collect();

    Json(FilteredLogResponse {
        filtered_lines: lines,
        summary,
    })
}
