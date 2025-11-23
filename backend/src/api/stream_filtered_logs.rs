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
// tokio
use tokio::fs::File;
// tokio-util
use tokio_util::codec::{FramedRead, LinesCodec};
// futures
use futures::{stream, StreamExt};
// serde
use serde::Deserialize;
// tracing
use tracing::{debug, info};
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
    pub keywords: Option<String>,
}

/// SSE stream of filtered logs
#[utoipa::path(
    get,
    path = "/stream_logs",
    params(
        ("session_id" = String, Query, description = "Log session ID"),
        ("domains" = Option<String>, Query, description = "Comma-separated log domains to include"),
        ("levels" = Option<String>, Query, description = "Comma-separated log levels to include"),
        ("keywords" = Option<String>, Query, description = "Comma-separated keywords to include")
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
    debug!("Logfile filter request: Keywords {:?}, Domains {:?}, Levels {:?}", &query.keywords, &query.domains, &query.levels);

    let file_path = match get_user_log(&query.session_id) {
        Some(path) => path,
        None => return Sse::new(stream::empty().boxed()),
    };

    let file = match File::open(file_path).await {
        Ok(f) => f,
        Err(_) => return Sse::new(stream::empty().boxed()),
    };

    let boxed_stream = FramedRead::new(file, LinesCodec::new())
        .map(|line_res| line_res.unwrap_or_default()) // handle read errors
        .filter_map(move |line| {
            let filter_levels = query.levels.clone().map(|s| s.split(',').map(|x| x.trim().to_string()).collect::<Vec<_>>());
            let filter_domains = query.domains.clone().map(|s| s.split(',').map(|x| x.trim().to_string()).collect::<Vec<_>>());
            let filter_keywords = query.keywords.clone().map(|s| s.split(',').map(|x| x.trim().to_string()).collect::<Vec<_>>());

            async move {
                if let Some(caps) = LOG_REGEX.captures(&line) {
                    let level = caps["level"].to_string();
                    let domain = caps["domain"].to_string();
                    let message = caps["message"].to_string();

                    let level_ok = filter_levels.as_ref().map_or(true, |v| v.contains(&level));
                    let domain_ok = filter_domains.as_ref().map_or(true, |v| v.contains(&domain));
                    let keyword_ok = filter_keywords.as_ref().map_or(true, |v| {
                        // Match if any of the provided keywords appear within the message
                        v.iter().any(|kw| message.contains(kw))
                    });

                    if level_ok && domain_ok && keyword_ok {
                        return Some(Event::default().data(line));
                    }
                }
                None
            }
        })
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
