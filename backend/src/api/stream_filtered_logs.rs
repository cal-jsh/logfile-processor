// local
use crate::model::filter::FilterRequest;
use crate::parsing::parser::LOG_REGEX;

// axum
use axum::{
    extract::Json,
    response::sse::{Event, Sse},
    routing::post,
    Router,
};
use futures::stream::{BoxStream, StreamExt};
use std::convert::Infallible;

pub fn router() -> Router {
    Router::new().route("/stream_logs", post(stream_filtered_logs))
}

/// Stream filtered logs as SSE
#[utoipa::path(
    post,
    path = "/stream_logs",
    request_body = FilterRequest,
    responses(
        (
            status = 200,
            description = "Stream of filtered log lines as Server-Sent Events (SSE). \
                           Each SSE event contains a single log line as plain text.",
            content_type = "text/event-stream"
        )
    )
)]
pub async fn stream_filtered_logs(
    Json(req): Json<FilterRequest>,
) -> Sse<BoxStream<'static, Result<Event, Infallible>>> {
    // Move the log text into a Vec<String> once — necessary for 'static lifetime
    let log_lines: Vec<String> = req.log_text.lines().map(|l| l.to_string()).collect();

    // Clone filter parameters
    let filter_levels = req.levels.clone();
    let filter_domains = req.domains.clone();

    let stream = futures::stream::iter(log_lines.into_iter())
        .filter_map(move |line| {
            let filter_levels = filter_levels.clone();
            let filter_domains = filter_domains.clone();

            async move {
                if let Some(caps) = LOG_REGEX.captures(&line) {
                    let level = &caps["level"];
                    let domain = &caps["domain"];
                    if filter_levels
                        .as_ref()
                        .map_or(true, |l| l.contains(&level.to_string()))
                        && filter_domains
                            .as_ref()
                            .map_or(true, |d| d.contains(&domain.to_string()))
                    {
                        return Some(Ok(Event::default().data(line)));
                    }
                }
                None
            }
        })
        .boxed();

    Sse::new(stream)
}
