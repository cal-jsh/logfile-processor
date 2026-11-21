//! Minimap API: the log levels of the whole file, aggregated to one value per pixel
//! column, so the browser never receives per-line data.
//!
//! `GET /minimap?session_id=..&buckets=N[&levels=..&fields=..&keywords=..]` splits the
//! file's lines into `N` equal buckets and returns the most severe level code in each
//! (see [`crate::logfile::levels::code`]): `0` no log line, `1` other level, `2` TRACE,
//! `3` DEBUG, `4` INFO, `5` WARN, `6` ERROR, `7` CRITICAL. Taking the most severe level
//! keeps a single ERROR visible in a bucket of a million INFO lines.
//!
//! With a filter, `matched` holds the same aggregation over the matching lines only
//! (context lines are not counted), while `all` still describes the whole file. The
//! level index is built once per session; the filter result comes from the session's
//! scan cache, so this costs one pass over the bucket range, not over the file.
//!
//! With `axis=time`, the buckets are equal slices of the file's time span instead of
//! equal runs of lines, so quiet periods show as empty columns and bursts as dense ones
//! (see [`crate::logfile::timeline`]). `first_lines` then gives the first line of each
//! column, for jumping, and `time_start_ms` / `time_end_ms` the span, for an axis.
//!
//! With `color=<field>` (e.g. `color=domain`), the buckets hold the field's group with the
//! most lines instead of the most severe level (see [`crate::logfile::categories`]):
//! `0` no value, `1..=categories.len()` the groups in `categories`, `other_code` all
//! other groups. Values are grouped by their first `.`-separated segment.

use crate::api::view::ApiError;
use crate::log_storage::get_user_log;
use crate::logfile::categories::{self, CategoryTimeBins, Group};
use crate::logfile::timeline::TimeBins;
use crate::parsing::format::FieldKind;
use std::sync::Arc;
use crate::parsing::line_filter::LineFilter;
use axum::{extract::Query, http::StatusCode, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tracing::debug;

/// Most buckets one request may ask for (wider than any screen at 2x scale).
pub const MAX_BUCKETS: u64 = 16_384;

pub fn router() -> Router {
    Router::new().route("/minimap", get(get_minimap))
}

#[derive(Deserialize, Debug)]
pub struct MinimapQuery {
    pub session_id: String,
    /// Number of buckets, usually the minimap's width in device pixels (default 1000)
    pub buckets: Option<u64>,
    /// Comma-separated log levels to include
    pub levels: Option<String>,
    /// Other fields to filter on, as JSON (see `ViewQuery::fields`)
    pub fields: Option<String>,
    /// Comma-separated keywords; a line matches if its message contains any of them
    pub keywords: Option<String>,
    /// `line` (default): equal numbers of lines per bucket; `time`: equal time slices
    pub axis: Option<String>,
    /// `level` (default), or the name of a text field (e.g. `domain`) to colour by
    pub color: Option<String>,
}

#[derive(Serialize)]
pub struct MinimapResponse {
    /// Lines in the file
    pub line_count: u64,
    /// Buckets returned: the requested number, or one per line for short files.
    /// Bucket `i` covers 1-based lines `floor(i * line_count / buckets) + 1` up to and
    /// including `floor((i + 1) * line_count / buckets)`.
    pub buckets: u64,
    /// Most severe level code of all lines in each bucket
    pub all: Vec<u8>,
    /// Most severe level code of the matching lines in each bucket; `null` without a filter
    pub matched: Option<Vec<u8>>,
    /// Matching lines; `null` without a filter
    pub match_count: Option<u64>,
    /// `line` or `time`
    pub axis: &'static str,
    /// Time axis only: 1-based first line of each bucket, `0` for an empty bucket
    pub first_lines: Option<Vec<u64>>,
    /// Time axis only: earliest and latest timestamp, as milliseconds since 1970-01-01
    /// in the log's own clock (no time zone is applied)
    pub time_start_ms: Option<f64>,
    pub time_end_ms: Option<f64>,
    /// Time axis only: log lines with a parseable timestamp (the others are left out)
    pub timed_lines: Option<u64>,
    /// `level`, or the field the buckets are coloured by
    pub color: String,
    /// Colour by field only: the groups with a code of their own (code `i + 1`), most
    /// lines first
    pub categories: Option<Vec<Group>>,
    /// Colour by field only: code of the other groups, their lines and their number
    pub other_code: Option<u8>,
    pub other_lines: Option<u64>,
    pub other_groups: Option<u64>,
    /// Time to build the level (and category) index, when this request built it
    pub build_ms: Option<f64>,
    /// Time to aggregate the buckets
    pub aggregate_ms: f64,
}

pub async fn get_minimap(Query(q): Query<MinimapQuery>) -> Result<Json<MinimapResponse>, ApiError> {
    debug!("Minimap request: {:?}", q);
    let session = get_user_log(&q.session_id)
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Session ID not found".into()))?;
    let n = q.buckets.unwrap_or(1000).clamp(1, MAX_BUCKETS);
    let (levels, was_built) = session.levels().await?;

    let color = q.color.as_deref().filter(|c| !c.is_empty() && *c != "level");
    let cats = match color {
        None => None,
        Some(name) => {
            let field = session
                .format
                .field_index(name)
                .filter(|&i| session.format.fields()[i].kind == FieldKind::Text)
                .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, format!("No text field '{name}' in the log format")))?;
            Some(session.categories(name, field).await?)
        }
    };

    let filter = LineFilter::from_query(q.levels.as_deref(), q.fields.as_deref(), q.keywords.as_deref())
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?;
    let matches = if !filter.is_empty() {
        Some(session.matches(filter).await?.0)
    } else {
        None
    };

    let mut build_ms = (!was_built).then(|| levels.build_time.as_secs_f64() * 1000.0);
    if let Some((c, false)) = &cats {
        build_ms = Some(build_ms.unwrap_or(0.0) + c.build_time.as_secs_f64() * 1000.0);
    }
    let legend = cats.as_ref().map(|(c, _)| (c.top.clone(), c.other_lines, c.other_groups));
    let color_name = color.unwrap_or("level").to_string();
    let cats = cats.map(|(c, _)| c);
    let line_count = levels.line_count();
    let match_count = matches.as_ref().map(|m| m.match_count());

    if q.axis.as_deref() == Some("time") {
        let all_bins = session.time_bins(levels.clone()).await?;
        let cat_bins = match (&cats, color) {
            (Some(c), Some(name)) => Some(session.category_time_bins(name, levels.clone(), c.clone()).await?),
            _ => None,
        };
        let span = levels.time_span();
        let timed_lines = all_bins.timed_lines;
        let file = session.file.clone();
        let format = session.format.clone();
        let field = color_name.clone();
        let (all, first, matched, aggregate_ms) = tokio::task::spawn_blocking(move || {
            let started = Instant::now();
            let n = n as usize;
            let (level_all, first) = all_bins.columns(n);
            let (all, matched) = match (&cats, &cat_bins) {
                (Some(c), Some(cb)) => {
                    let matched = matches.as_ref().map(|m| {
                        let cached = m.category_time_bins.lock().unwrap().iter().find(|e| e.0 == field).map(|e| e.1.clone());
                        let bins = cached.unwrap_or_else(|| {
                            let b = Arc::new(CategoryTimeBins::build_ranges(&file, &levels, c, &format, m.ranges()));
                            m.category_time_bins.lock().unwrap().push((field.clone(), b.clone()));
                            b
                        });
                        bins.columns(n)
                    });
                    (cb.columns(n), matched)
                }
                _ => {
                    let matched = matches.as_ref().map(|m| {
                        let bins = m.time_bins.get_or_init(|| {
                            Arc::new(TimeBins::build_ranges(&file, &levels, &format, m.ranges()))
                        });
                        bins.columns(n).0
                    });
                    (level_all, matched)
                }
            };
            (all, first, matched, started.elapsed().as_secs_f64() * 1000.0)
        })
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let first_lines = first.into_iter().map(|l| if l == u64::MAX { 0 } else { l + 1 }).collect();
        let ms = |ns: i64| ns as f64 / 1e6;
        return Ok(Json(MinimapResponse {
            line_count,
            buckets: all.len() as u64,
            all,
            matched,
            match_count,
            axis: "time",
            first_lines: Some(first_lines),
            time_start_ms: span.map(|s| ms(s.0)),
            time_end_ms: span.map(|s| ms(s.1)),
            timed_lines: Some(timed_lines),
            color: color_name,
            categories: legend.as_ref().map(|l| l.0.clone()),
            other_code: legend.as_ref().map(|_| categories::OTHER),
            other_lines: legend.as_ref().map(|l| l.1),
            other_groups: legend.as_ref().map(|l| l.2),
            build_ms,
            aggregate_ms,
        }));
    }

    let buckets = levels.bucket_count(n);
    let (all, matched, aggregate_ms) = tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let (all, matched) = match &cats {
            Some(c) => (c.buckets(n), matches.as_ref().map(|m| c.buckets_in(n, m.ranges()))),
            None => (levels.buckets(n), matches.as_ref().map(|m| levels.buckets_in(n, m.ranges()))),
        };
        (all, matched, started.elapsed().as_secs_f64() * 1000.0)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(MinimapResponse {
        line_count,
        buckets,
        all,
        matched,
        match_count,
        axis: "line",
        first_lines: None,
        time_start_ms: None,
        time_end_ms: None,
        timed_lines: None,
        color: color_name,
        categories: legend.as_ref().map(|l| l.0.clone()),
        other_code: legend.as_ref().map(|_| categories::OTHER),
        other_lines: legend.as_ref().map(|l| l.1),
        other_groups: legend.as_ref().map(|l| l.2),
        build_ms,
        aggregate_ms,
    }))
}
