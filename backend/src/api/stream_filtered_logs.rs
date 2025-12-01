// src/your_module.rs
// Adjust module path / file name to match your project structure.

use crate::log_storage::{get_user_log, remove_user_log};
use crate::model::close_session_query::CloseSessionQuery;
use crate::parsing::parser::LOG_REGEX;

use axum::{
    extract::Query,
    response::sse::{Event, Sse},
    routing::{get, post},
    Json, Router,
};
use futures::{stream, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::convert::Infallible;
use std::pin::Pin;
use tokio::fs::File;
use tokio::time::{interval, Duration};
use tokio_util::codec::{FramedRead, LinesCodec};
use tracing::{debug, info};

use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Mutex;

pub fn router() -> Router {
    Router::new()
        .route("/stream_logs", get(stream_filtered_logs))
        .route("/close_session", post(close_session))
}

fn json_event(value: &serde_json::Value) -> Event {
    Event::default().data(serde_json::to_string(value).unwrap())
}

#[derive(Deserialize)]
pub struct LogFilterQuery {
    pub session_id: String,
    pub domains: Option<String>,
    pub levels: Option<String>,
    pub keywords: Option<String>,
    /// Optional context window size. If absent or zero -> no context expansion.
    pub context: Option<usize>,
}

#[utoipa::path(
    get,
    path = "/stream_logs",
    params(
        ("session_id" = String, Query, description = "Log session ID"),
        ("domains" = Option<String>, Query, description = "Comma-separated log domains to include"),
        ("levels" = Option<String>, Query, description = "Comma-separated log levels to include"),
        ("keywords" = Option<String>, Query, description = "Comma-separated keywords to include"),
        ("context" = Option<usize>, Query, description = "Optional number of surrounding lines to include (±context)")
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
    debug!(
        "Logfile filter request: Keywords {:?}, Domains {:?}, Levels {:?}, Context {:?}",
        &query.keywords, &query.domains, &query.levels, &query.context
    );

    let file_path = match get_user_log(&query.session_id) {
        Some(path) => path,
        None => return Sse::new(stream::empty().boxed()),
    };

    let file = match File::open(file_path).await {
        Ok(f) => f,
        Err(err) => {
            debug!(
                "Failed to open log file for session {}: {}",
                &query.session_id, err
            );
            return Sse::new(stream::empty().boxed());
        }
    };

    // Parse filters once and reuse
    let filter_levels = query.levels.clone().map(|s| {
        s.split(',')
            .map(|x| x.trim().to_string())
            .collect::<Vec<_>>()
    });
    let filter_domains = query.domains.clone().map(|s| {
        s.split(',')
            .map(|x| x.trim().to_string())
            .collect::<Vec<_>>()
    });
    let filter_keywords = query.keywords.clone().map(|s| {
        s.split(',')
            .map(|x| x.trim().to_string())
            .collect::<Vec<_>>()
    });

    // Context window size (Option A: disabled unless specified)
    let context = query.context.unwrap_or(0usize);

    // Prev buffer holds up to `context` previous lines (most recent at back)
    let prev_buffer: Arc<Mutex<VecDeque<String>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(if context == 0 {
            1
        } else {
            context
        })));
    // future_remaining indicates how many upcoming lines to treat as forward context
    let future_remaining = Arc::new(Mutex::new(0usize));
    // outgoing queue for events produced by processing a single incoming line (keeps order)
    let out_queue: Arc<Mutex<VecDeque<Event>>> = Arc::new(Mutex::new(VecDeque::new()));

    // Stream of raw lines (String)
    let raw_lines = FramedRead::new(file, LinesCodec::new()).map(|res| res.unwrap_or_default());

    // Main processing stream: we use filter_map that first consumes any events in out_queue,
    // otherwise processes the next incoming line and possibly enqueues events.
    let pb = prev_buffer.clone();
    let fr = future_remaining.clone();
    let oq = out_queue.clone();
    let filter_levels_clone = filter_levels.clone();
    let filter_domains_clone = filter_domains.clone();
    let filter_keywords_clone = filter_keywords.clone();

    let fl = raw_lines.filter_map(move |line| {
        // clones for closure
        let prev_buffer = pb.clone();
        let future_remaining = fr.clone();
        let out_queue = oq.clone();
        let filter_levels = filter_levels_clone.clone();
        let filter_domains = filter_domains_clone.clone();
        let filter_keywords = filter_keywords_clone.clone();
        async move {
            // If there are already pending outgoing events, return the next one first.
            if let Some(ev) = {
                let mut q = out_queue.lock().await;
                q.pop_front()
            } {
                return Some(ev);
            }

            // Determine whether this line matches the user-provided filters
            let mut matched = false;
            if let Some(caps) = LOG_REGEX.captures(&line) {
                let level = caps.name("level").map(|m| m.as_str()).unwrap_or("");
                let domain = caps.name("domain").map(|m| m.as_str()).unwrap_or("");
                let message = caps.name("message").map(|m| m.as_str()).unwrap_or("");

                let level_ok = filter_levels
                    .as_ref()
                    .map_or(true, |v| v.iter().any(|s| s == level));
                let domain_ok = filter_domains
                    .as_ref()
                    .map_or(true, |v| v.iter().any(|s| s == domain));
                let keyword_ok = filter_keywords
                    .as_ref()
                    .map_or(true, |v| v.iter().any(|kw| message.contains(kw)));
                matched = level_ok && domain_ok && keyword_ok;
            }

            // If context == 0: old behavior (emit only immediate matches)
            if context == 0 {
                if matched {
                    let ev = json_event(&json!({ "line": line.clone(), "context": false }));
                    return Some(ev);
                } else {
                    return None;
                }
            }

            // context > 0: use prev_buffer + future_remaining + out_queue mechanism
            // Acquire locks where necessary and perform logic
            let mut events_to_return: Vec<Event> = Vec::new();

            if matched {
                // 1) Emit previous buffer lines (in order oldest -> newest) as context=true
                {
                    let mut pb_lock = prev_buffer.lock().await;
                    while let Some(prev_line) = pb_lock.pop_front() {
                        let ev = json_event(&json!({ "line": prev_line, "context": true }));
                        events_to_return.push(ev);
                    }
                }

                // 2) Emit the matching line itself (context = false)
                events_to_return.push(json_event(
                    &json!({ "line": line.clone(), "context": false }),
                ));

                // 3) Set future_remaining = context (so next `context` input lines will be emitted as context)
                {
                    let mut fr_lock = future_remaining.lock().await;
                    *fr_lock = context;
                }
            } else {
                // Not matched
                // If we have future_remaining > 0 => this line is forward context
                let mut fr_lock = future_remaining.lock().await;
                if *fr_lock > 0 {
                    events_to_return.push(json_event(
                        &json!({ "line": line.clone(), "context": true }),
                    ));
                    *fr_lock -= 1;
                } else {
                    // Otherwise push into prev_buffer (maintain its max size = context)
                    let mut pb_lock = prev_buffer.lock().await;
                    pb_lock.push_back(line.clone());
                    while pb_lock.len() > context {
                        pb_lock.pop_front();
                    }
                }
            }

            // If we produced more than one event, store the rest in out_queue (so next poll returns them)
            if events_to_return.len() > 1 {
                let mut q = out_queue.lock().await;
                // push all except first into queue
                for ev in events_to_return.iter().skip(1) {
                    q.push_back(ev.clone());
                }
            }

            // Return first event if any
            if let Some(first) = events_to_return.into_iter().next() {
                Some(first)
            } else {
                None
            }
        }
    });

    // Map Event to Result<Event, Infallible>
    let file_emits = fl.map(|ev| Ok(ev) as Result<Event, Infallible>);

    // Final flush: when the file stream ends, we must decide for remaining items in prev_buffer whether to emit them
    let flush_buffer = {
        let prev_buffer = prev_buffer.clone();
        let future_remaining = future_remaining.clone();
        stream::once(async move {
            let mut out: Vec<Result<Event, Infallible>> = Vec::new();

            // First, any pending future_remaining does not make sense at EOF for lines beyond EOF.
            // Emit any prev_buffer lines that are within +/-context of any matched line that
            // could still be in the previous processing (we don't have matched flags here anymore),
            // but we can conservatively emit prev_buffer only if future_remaining > 0 (i.e., last match wanted forward context)
            // or if prev_buffer contains any matches (shouldn't in our logic).
            // Simpler and safe: emit remaining prev_buffer if future_remaining > 0 (they were requested as forward context),
            // otherwise drop them.

            let fr = { *future_remaining.lock().await };
            let mut pb = prev_buffer.lock().await;

            if fr > 0 {
                // emit the remaining prev buffer lines as context=true
                while let Some(item) = pb.pop_front() {
                    let ev = json_event(&json!({ "line": item, "context": true }));
                    out.push(Ok(ev));
                }
            } else {
                // nothing to emit at EOF in most cases; but (optional) we could emit trailing matches if needed.
            }

            out.into_iter()
        })
        .flat_map(|iter| stream::iter(iter))
    };

    // Heartbeat stream to keep connections alive
    let heartbeat = stream::unfold(interval(Duration::from_secs(15)), |mut intv| async move {
        intv.tick().await;
        Some((Ok(Event::default().comment("hb")), intv))
    });

    // Compose final stream
    let final_stream = file_emits.chain(flush_buffer).chain(heartbeat).boxed();

    Sse::new(final_stream)
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
