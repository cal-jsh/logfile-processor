//! Swimlane API: per thread (or other text field), the log levels over time, aggregated
//! to one value per pixel column, for the "Thread lanes" view.
//!
//! `GET /lanes?session_id=..&field=thread&buckets=N[&from_ms=..&to_ms=..][&filter]`
//! returns the lanes (see [`crate::logfile::lanes`]) and, per lane, strings of `N` digits
//! (see [`Encoded`]): `levels` the level with the most lines in each column (`0` no line,
//! then as the minimap: `1` other, `2` TRACE .. `6` ERROR), `alerts` an ERROR or WARN that
//! is there but does not dominate, and `density` how many lines the column holds, `1..=9`
//! on a log scale relative to the busiest column (`0` none).
//!
//! Unlike the minimap, the colour is the dominant level, not the most severe one: over
//! days almost every thread logs an error every few minutes, and the most severe level
//! turns every lane red. The alerts keep single errors visible as a thin mark on top.
//!
//! `from_ms` / `to_ms` zoom into a time window (log clock, ms since 1970); without them the
//! whole file is shown from the index built once per session. With a filter, `matched`
//! describes the matching lines only (no context lines).
//!
//! `GET /lanes/at?..&lane=L&column=C` (same parameters) returns the first line of lane `L`
//! in column `C`, or in the nearest column within a few pixels that has one, with its time
//! and text, for the hover readout and for jumping.

use crate::api::view::ApiError;
use crate::log_storage::{get_user_log, Session, LANE_WINDOW_CACHE};
use crate::logfile::index::display_text;
use crate::logfile::lanes::{Lane, LaneBins, LaneColumns, LaneIndex, MAX_LANES};
use crate::logfile::levels::LevelIndex;
use crate::logfile::view::MatchSet;
use crate::parsing::format::FieldKind;
use crate::parsing::line_filter::LineFilter;
use axum::{extract::Query, http::StatusCode, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tracing::debug;

/// Most columns one request may ask for.
pub const MAX_BUCKETS: usize = crate::logfile::lanes::SLICES;
/// Columns `/lanes/at` looks to each side for a line.
const NEAR_COLUMNS: usize = 4;
/// Longest line text `/lanes/at` returns.
const MAX_TEXT_BYTES: usize = 2000;

pub fn router() -> Router {
    Router::new().route("/lanes", get(get_lanes)).route("/lanes/at", get(get_lane_at))
}

#[derive(Deserialize, Debug)]
pub struct LanesQuery {
    pub session_id: String,
    /// The text field that makes the lanes (default `thread`)
    pub field: Option<String>,
    /// Columns, usually the view's width in device pixels (default 1000)
    pub buckets: Option<usize>,
    /// Time window, ms since 1970 in the log's own clock; default the whole file
    pub from_ms: Option<f64>,
    pub to_ms: Option<f64>,
    pub levels: Option<String>,
    pub fields: Option<String>,
    pub keywords: Option<String>,
    /// `/lanes/at` only: the lane (index into `lanes`, `other` last) and the column
    pub lane: Option<usize>,
    pub column: Option<usize>,
}

#[derive(Serialize)]
pub struct LanesResponse {
    pub field: String,
    pub line_count: u64,
    /// Lanes with a value of their own, top to bottom
    pub lanes: Vec<Lane>,
    /// Values sharing the "other" lane below them, and their lines (`0`: no such lane)
    pub other_values: u64,
    pub other_lines: u64,
    pub max_lanes: usize,
    /// The whole file's time span and the window shown (ms, log clock); `null` without
    /// timestamps
    pub time_start_ms: Option<f64>,
    pub time_end_ms: Option<f64>,
    pub from_ms: Option<f64>,
    pub to_ms: Option<f64>,
    pub buckets: usize,
    /// All lines in the window
    pub all: Encoded,
    /// With a filter: the same over the matching lines; `null` without a filter
    pub matched: Option<Encoded>,
    pub match_count: Option<u64>,
    /// Lines in the window (with a timestamp and a value)
    pub window_lines: u64,
    /// Time to build the lane index, when this request built it
    pub build_ms: Option<f64>,
    /// Time to read the window or the matches, when this request did
    pub window_ms: Option<f64>,
    pub aggregate_ms: f64,
}

#[derive(Serialize)]
pub struct LaneAtResponse {
    /// 1-based line, `null` if the lane has no line near the column
    pub line: Option<u64>,
    /// The column it was found in
    pub column: Option<usize>,
    /// Level code of that line
    pub level: Option<u8>,
    pub time_ms: Option<f64>,
    pub text: Option<String>,
}

/// The bins a request is about.
struct Resolved {
    session: Arc<Session>,
    field_name: String,
    idx: Arc<LaneIndex>,
    built: bool,
    /// Whole file, or the zoomed window
    all: Arc<LaneBins>,
    matched: Option<Arc<LaneBins>>,
    match_count: Option<u64>,
    has_time: bool,
    window_ms: Option<f64>,
}

fn intersect(ranges: &[(u64, u64)], window: (u64, u64)) -> Vec<(u64, u64)> {
    let i = ranges.partition_point(|r| r.1 <= window.0);
    ranges[i..]
        .iter()
        .take_while(|r| r.0 < window.1)
        .map(|r| (r.0.max(window.0), r.1.min(window.1)))
        .filter(|r| r.0 < r.1)
        .collect()
}

async fn resolve(q: &LanesQuery) -> Result<Resolved, ApiError> {
    let session = get_user_log(&q.session_id).ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Session ID not found".into()))?;
    let field_name = q.field.clone().filter(|f| !f.is_empty()).unwrap_or_else(|| "thread".into());
    let field = session
        .format
        .field_index(&field_name)
        .filter(|&i| session.format.fields()[i].kind == FieldKind::Text)
        .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, format!("No text field '{field_name}' in the log format")))?;
    let (levels, _) = session.levels().await?;
    let (idx, built) = session.lanes(&field_name, field, levels.clone()).await?;
    let has_time = levels.time_span().is_some();

    // the window, inside the file's span; the whole span uses the index itself
    let full = idx.bins.span;
    let to_ns = |ms: f64| (ms * 1e6).round() as i64;
    let mut window = (q.from_ms.map_or(full.0, to_ns).max(full.0), q.to_ms.map_or(full.1, to_ns).min(full.1));
    if window.0 > window.1 {
        window = full;
    }
    let is_full = window == full;
    let line_count = session.file.line_count();
    let lines = if is_full { Some((0, line_count)) } else { idx.window_lines(window, line_count) };
    let key = (field_name.clone(), window.0, window.1);
    let mut window_ms = None;

    let build = {
        let session = session.clone();
        let idx = idx.clone();
        let levels: Arc<LevelIndex> = levels.clone();
        move |ranges: Vec<(u64, u64)>| {
            let session = session.clone();
            let idx = idx.clone();
            let levels = levels.clone();
            async move {
                tokio::task::spawn_blocking(move || {
                    Arc::new(LaneBins::build_window(&session.file, &levels, &session.format, field, &idx.lanes, window, &ranges))
                })
                .await
                .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
            }
        }
    };

    let all = if is_full {
        idx.bins.clone()
    } else if let Some(b) = session.lane_window(&key) {
        b
    } else {
        let b = build(lines.into_iter().collect()).await?;
        window_ms = Some(b.build_time.as_secs_f64() * 1000.0);
        session.put_lane_window(key.clone(), b.clone());
        b
    };

    let filter = LineFilter::from_query(q.levels.as_deref(), q.fields.as_deref(), q.keywords.as_deref())
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?;
    let (matched, match_count) = if filter.is_empty() {
        (None, None)
    } else {
        let m: Arc<MatchSet> = session.matches(filter).await?.0;
        let cached = m.lane_bins.lock().unwrap().iter().find(|e| e.0 == key).map(|e| e.1.clone());
        let b = match cached {
            Some(b) => b,
            None => {
                let ranges = lines.map(|l| intersect(m.ranges(), l)).unwrap_or_default();
                let b = build(ranges).await?;
                window_ms = Some(window_ms.unwrap_or(0.0) + b.build_time.as_secs_f64() * 1000.0);
                let mut c = m.lane_bins.lock().unwrap();
                c.retain(|e| e.0 != key);
                c.push((key.clone(), b.clone()));
                if c.len() > LANE_WINDOW_CACHE {
                    c.remove(0);
                }
                b
            }
        };
        (Some(b), Some(m.match_count()))
    };

    Ok(Resolved { session, field_name, idx, built, all, matched, match_count, has_time, window_ms })
}

/// Digit strings per lane: dominant level, alert level and density.
fn encode(cols: Vec<LaneColumns>) -> Encoded {
    let max = cols.iter().flat_map(|c| c.count.iter().copied()).max().unwrap_or(0);
    let scale = ((max as f64) + 1.0).ln();
    let digits = |v: &[u8]| v.iter().map(|&c| char::from(b'0' + c.min(9))).collect::<String>();
    let mut e = Encoded::default();
    for c in cols {
        e.levels.push(digits(&c.dominant));
        e.alerts.push(digits(&c.alert));
        let d: Vec<u8> = c
            .count
            .iter()
            .map(|&n| if n == 0 { 0 } else { (((n as f64 + 1.0).ln() / scale) * 9.0).ceil().clamp(1.0, 9.0) as u8 })
            .collect();
        e.density.push(digits(&d));
    }
    e
}

/// One digit per column, per lane (the "other" lane last).
#[derive(Default, Serialize)]
pub struct Encoded {
    /// The level with the most lines
    pub levels: Vec<String>,
    /// `6` / `5` when ERROR / WARN lines are there but another level dominates
    pub alerts: Vec<String>,
    /// `1..=9`: how many lines, log scale relative to the busiest column
    pub density: Vec<String>,
}

pub async fn get_lanes(Query(q): Query<LanesQuery>) -> Result<Json<LanesResponse>, ApiError> {
    debug!("Lanes request: {:?}", q);
    let n = q.buckets.unwrap_or(1000).clamp(1, MAX_BUCKETS);
    let r = resolve(&q).await?;
    let ms = |ns: i64| ns as f64 / 1e6;
    let (all, matched) = (r.all.clone(), r.matched.clone());
    let (all_enc, matched_enc, aggregate_ms) = tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let a = encode(all.columns(n));
        let m = matched.map(|m| encode(m.columns(n)));
        (a, m, started.elapsed().as_secs_f64() * 1000.0)
    })
    .await
    .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let full = r.idx.bins.span;
    let window = r.all.span;
    Ok(Json(LanesResponse {
        field: r.field_name,
        line_count: r.session.file.line_count(),
        lanes: r.idx.lanes.lanes.clone(),
        other_values: r.idx.lanes.other_values,
        other_lines: r.idx.lanes.other_lines,
        max_lanes: MAX_LANES,
        time_start_ms: r.has_time.then(|| ms(full.0)),
        time_end_ms: r.has_time.then(|| ms(full.1)),
        from_ms: r.has_time.then(|| ms(window.0)),
        to_ms: r.has_time.then(|| ms(window.1)),
        buckets: n,
        all: all_enc,
        matched: matched_enc,
        match_count: r.match_count,
        window_lines: r.matched.as_ref().unwrap_or(&r.all).timed_lines,
        build_ms: (!r.built).then(|| r.idx.build_time.as_secs_f64() * 1000.0),
        window_ms: r.window_ms,
        aggregate_ms,
    }))
}

pub async fn get_lane_at(Query(q): Query<LanesQuery>) -> Result<Json<LaneAtResponse>, ApiError> {
    let n = q.buckets.unwrap_or(1000).clamp(1, MAX_BUCKETS);
    let (Some(lane), Some(column)) = (q.lane, q.column) else {
        return Err(ApiError(StatusCode::BAD_REQUEST, "lane and column are required".into()));
    };
    let r = resolve(&q).await?;
    let bins = r.matched.as_ref().unwrap_or(&r.all);
    let none = LaneAtResponse { line: None, column: None, level: None, time_ms: None, text: None };
    let Some((col, line)) = bins.first_near(lane, n, column.min(n - 1), NEAR_COLUMNS) else {
        return Ok(Json(none));
    };
    let Some((_, bytes)) = r.session.file.lines_from(line).next() else {
        return Ok(Json(none));
    };
    let (levels, _) = r.session.levels().await?;
    Ok(Json(LaneAtResponse {
        line: Some(line + 1),
        column: Some(col),
        level: Some(levels.code(line)),
        time_ms: r.session.format.time_of(bytes).map(|ns| ns as f64 / 1e6),
        text: Some(display_text(bytes, MAX_TEXT_BYTES).0),
    }))
}
