// local
use crate::log_storage::{get_user_log, remove_user_log};
use crate::model::close_session_query::CloseSessionQuery;
use crate::parsing::parser::LOG_REGEX;

// axum
use axum::{
    extract::Query,
    response::sse::{Event, Sse},
    routing::{get, post},
    Json, Router,
};
// futures
use futures::{stream, StreamExt};
use futures::stream::BoxStream;
// serde
use serde::Deserialize;
// tracing
use tracing::info;
// std
use std::convert::Infallible;
use std::pin::Pin;

pub fn router() -> Router {
    Router::new()
        .route("/stream_logs", get(stream_filtered_logs))
        .route("/close_session", post(close_session))
}

#[derive(Deserialize)]
pub struct LogFilterQuery {
    pub session_id: String,
    pub domains: Option<String>,
    pub levels: Option<String>,
}

/// SSE stream of filtered logs
#[utoipa::path(
    get,
    path = "/stream_logs",
    params(
        ("session_id" = String, Query, description = "Log session ID"),
        ("domains" = Option<String>, Query, description = "Comma-separated log domains to include"),
        ("levels" = Option<String>, Query, description = "Comma-separated log levels to include")
    ),
    responses(
        (
            status = 200, 
            description = "Stream of filtered log events",
            content_type = "text/event-stream"
        ),
        (
            status = 404,
            description = "Session ID not found"
        )
    ),
    tag = "Log Streaming"
)]
pub async fn stream_filtered_logs(
    Query(query): Query<LogFilterQuery>,
) -> Sse<Pin<Box<dyn futures::Stream<Item = Result<Event, Infallible>> + Send>>> {
    // get owned log text
    let log_text = match get_user_log(&query.session_id) {
        Some(text) => text,
        None => return Sse::new(stream::empty().boxed()),
    };

    // own filters as Vec<String>
    let filter_levels: Option<Vec<String>> = query
        .levels
        .as_ref()
        .map(|s| s.split(',').map(|x| x.trim().to_string()).collect());

    let filter_domains: Option<Vec<String>> = query
        .domains
        .as_ref()
        .map(|s| s.split(',').map(|x| x.trim().to_string()).collect());

    // own lines so nothing borrows the handler stack
    let lines: Vec<String> = log_text.lines().map(|l| l.to_string()).collect();

    // stream: produce Option<Event> from each line, then map to Result<Event, Infallible>
    let boxed_stream: BoxStream<'static, Result<Event, Infallible>> = stream::iter(lines)
        .filter_map(move |line| {
            let filter_levels = filter_levels.clone();
            let filter_domains = filter_domains.clone();

            async move {
                if let Some(caps) = LOG_REGEX.captures(&line) {
                    let level = caps["level"].to_string();
                    let domain = caps["domain"].to_string();

                    let level_ok = filter_levels.as_ref().map_or(true, |v| v.contains(&level));
                    let domain_ok = filter_domains.as_ref().map_or(true, |v| v.contains(&domain));

                    if level_ok && domain_ok {
                        // return Event (not wrapped)
                        return Some(Event::default().data(line));
                    }
                }
                None
            }
        })
        // convert Option<Event> -> Result<Event, Infallible>
        .map(|ev| Ok(ev))
        .boxed();

    Sse::new(boxed_stream)
}

#[utoipa::path(
    post,
    path = "/close_session",
    request_body = CloseSessionQuery,
    responses(
        (status = 200, description = "Session log cleaned up successfully")
    )
)]
pub async fn close_session(Query(query): Query<CloseSessionQuery>) -> Json<&'static str> {
    remove_user_log(&query.session_id);
    info!("Removed log for session_id: {}", &query.session_id);
    Json("ok")
}
