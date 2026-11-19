//! Viewport API: the viewer asks for the rows it shows instead of receiving every
//! result line.
//!
//! * `GET /lines` reads a range of file lines by line number (sparse line index).
//! * `GET /view` runs (or reuses) a filter scan, which stores only the matching line
//!   numbers, and expands them by `context` lines. It returns the row count.
//! * `GET /view/rows` returns the text of a range of rows of that view.
//! * `GET /view/matches` returns the match line numbers themselves.
//! * `GET /view/row_of_line`, `/view/search` and `/view/export` support jumping,
//!   searching inside the results and downloading them.
//!
//! Filter results are cached per session, so scrolling or changing `context` never
//! rescans the file. All line numbers in this API are 1-based; rows are 0-based.

use crate::log_storage::{get_user_log, remove_user_log, QueryError, Session};
use crate::logfile::index::{display_text, LogFile};
use crate::logfile::view::{MatchSet, View, ViewLines};
use rayon::prelude::*;
use crate::model::close_session_query::CloseSessionQuery;
use crate::parsing::line_filter::LineFilter;
use crate::parsing::parser::split_log_line;

use axum::{
    body::{Body, Bytes},
    extract::Query,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{debug, info};

/// Longer lines are cut for display (the export always writes whole lines).
pub const MAX_DISPLAY_BYTES: usize = 16 * 1024;
/// Most rows or lines returned by one request.
pub const MAX_ROWS_PER_REQUEST: u64 = 5000;
const MAX_SEARCH_HITS: usize = 1000;
const SEARCH_TIME_BUDGET: Duration = Duration::from_secs(3);

pub fn router() -> Router {
    Router::new()
        .route("/lines", get(get_lines))
        .route("/view", get(get_view))
        .route("/view/rows", get(get_view_rows))
        .route("/view/matches", get(get_view_matches))
        .route("/view/row_of_line", get(get_row_of_line))
        .route("/view/search", get(search_view))
        .route("/view/export", get(export_view))
        .route("/close_session", post(close_session))
}

/// Query parameters shared by the view endpoints. Unused ones are ignored.
#[derive(Deserialize, Debug)]
pub struct ViewQuery {
    pub session_id: String,
    /// Comma-separated log domains to include
    pub domains: Option<String>,
    /// Comma-separated log levels to include
    pub levels: Option<String>,
    /// Comma-separated keywords; a line matches if its message contains any of them
    pub keywords: Option<String>,
    /// Lines of context around each match (default 0)
    pub context: Option<u64>,
    pub first_row: Option<u64>,
    pub count: Option<u64>,
    pub offset: Option<u64>,
    pub limit: Option<u64>,
    /// 1-based line number
    pub line: Option<u64>,
    /// Search text (case-insensitive)
    pub q: Option<String>,
    pub from_row: Option<u64>,
    /// `txt` (default) or `csv`
    pub format: Option<String>,
}

impl ViewQuery {
    fn filter(&self) -> LineFilter {
        LineFilter::from_csv(self.levels.as_deref(), self.domains.as_deref(), self.keywords.as_deref())
    }
}

pub struct ApiError(pub StatusCode, pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

impl From<QueryError> for ApiError {
    fn from(e: QueryError) -> Self {
        match e {
            QueryError::Cancelled => {
                ApiError(StatusCode::CONFLICT, "Cancelled by a newer filter".into())
            }
            QueryError::Internal(m) => ApiError(StatusCode::INTERNAL_SERVER_ERROR, m),
        }
    }
}

fn session(id: &str) -> Result<Arc<Session>, ApiError> {
    get_user_log(id).ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Session ID not found".into()))
}

/// Run `f` on the blocking pool (page faults on a cold memory map block the thread).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

struct Resolved {
    session: Arc<Session>,
    matches: Arc<MatchSet>,
    view: Arc<View>,
    cached: bool,
}

async fn resolve(q: &ViewQuery) -> Result<Resolved, ApiError> {
    let session = session(&q.session_id)?;
    let (matches, cached) = session.matches(q.filter()).await?;
    let view = matches.view(q.context.unwrap_or(0));
    Ok(Resolved { session, matches, view, cached })
}

// ---------------------------------------------------------------- /lines

#[derive(Deserialize)]
pub struct LinesQuery {
    pub session_id: String,
    /// 1-based first line (default 1)
    pub start: Option<u64>,
    /// Number of lines (default 100, at most 5000)
    pub count: Option<u64>,
}

#[derive(Serialize)]
pub struct Line {
    pub line_number: u64,
    pub text: String,
    /// The line was longer than the display limit and was cut
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct LinesResponse {
    pub line_count: u64,
    pub lines: Vec<Line>,
}

/// Read file lines `start..start+count` (1-based) through the sparse line index.
pub async fn get_lines(Query(q): Query<LinesQuery>) -> Result<Json<LinesResponse>, ApiError> {
    let session = session(&q.session_id)?;
    let start = q.start.unwrap_or(1).max(1) - 1;
    let count = q.count.unwrap_or(100).min(MAX_ROWS_PER_REQUEST) as usize;
    let file = session.file.clone();
    let lines = blocking(move || {
        file.lines_from(start)
            .take(count)
            .map(|(l, b)| {
                let (text, truncated) = display_text(b, MAX_DISPLAY_BYTES);
                Line { line_number: l + 1, text, truncated }
            })
            .collect()
    })
    .await?;
    Ok(Json(LinesResponse { line_count: session.file.line_count(), lines }))
}

// ---------------------------------------------------------------- /view

#[derive(Serialize)]
pub struct ViewInfo {
    /// Rows in the view: matches plus context lines
    pub row_count: u64,
    pub match_count: u64,
    pub context: u64,
    /// Lines in the file (all of them are scanned)
    pub line_count: u64,
    /// Time the filter scan took (when it ran; see `cached`)
    pub scan_ms: f64,
    /// The scan result came from the cache (no rescan)
    pub cached: bool,
}

/// Filter the file (or reuse a cached result) and return the size of the view.
pub async fn get_view(Query(q): Query<ViewQuery>) -> Result<Json<ViewInfo>, ApiError> {
    debug!("View request: {:?}", q);
    let started = Instant::now();
    let r = resolve(&q).await?;
    info!(
        "View: {} matches, {} rows (context {}), {} in {:.1} ms",
        r.matches.match_count(),
        r.view.row_count(),
        r.view.context,
        if r.cached { "cached" } else { "scanned" },
        started.elapsed().as_secs_f64() * 1000.0
    );
    Ok(Json(ViewInfo {
        row_count: r.view.row_count(),
        match_count: r.matches.match_count(),
        context: r.view.context,
        line_count: r.matches.line_count(),
        scan_ms: r.matches.scan_time.as_secs_f64() * 1000.0,
        cached: r.cached,
    }))
}

// ---------------------------------------------------------------- /view/rows

#[derive(Serialize)]
pub struct Row {
    pub row: u64,
    pub line_number: u64,
    pub text: String,
    /// Shown only as context around a match
    pub context: bool,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct RowsResponse {
    pub row_count: u64,
    pub rows: Vec<Row>,
}

fn read_rows(file: &LogFile, matches: &MatchSet, view: &View, first: u64, count: u64) -> Vec<Row> {
    ViewLines::new(file, view, first, count)
        .map(|(row, l, bytes)| {
            let (text, truncated) = display_text(bytes, MAX_DISPLAY_BYTES);
            Row { row, line_number: l + 1, text, context: !matches.is_match(l), truncated }
        })
        .collect()
}

/// Text of rows `first_row..first_row+count` of the view.
pub async fn get_view_rows(Query(q): Query<ViewQuery>) -> Result<Json<RowsResponse>, ApiError> {
    let r = resolve(&q).await?;
    let first = q.first_row.unwrap_or(0);
    let count = q.count.unwrap_or(100).min(MAX_ROWS_PER_REQUEST);
    let row_count = r.view.row_count();
    let rows = blocking(move || read_rows(&r.session.file, &r.matches, &r.view, first, count)).await?;
    Ok(Json(RowsResponse { row_count, rows }))
}

// ---------------------------------------------------------------- /view/matches

#[derive(Serialize)]
pub struct MatchesResponse {
    pub match_count: u64,
    /// 1-based line numbers of matching lines (no context), in file order
    pub line_numbers: Vec<u64>,
}

/// The matching line numbers of a filter, paged with `offset` and `limit`.
pub async fn get_view_matches(Query(q): Query<ViewQuery>) -> Result<Json<MatchesResponse>, ApiError> {
    let r = resolve(&q).await?;
    let limit = q.limit.unwrap_or(10_000).min(1_000_000) as usize;
    let line_numbers = r
        .matches
        .line_numbers(q.offset.unwrap_or(0), limit)
        .into_iter()
        .map(|l| l + 1)
        .collect();
    Ok(Json(MatchesResponse { match_count: r.matches.match_count(), line_numbers }))
}

// ---------------------------------------------------------------- /view/row_of_line

#[derive(Serialize)]
pub struct RowOfLineResponse {
    /// First row showing this line or a later one (`row_count` if none)
    pub row: u64,
    pub row_count: u64,
}

/// Map a 1-based file line to a row of the view, e.g. to keep the scroll position
/// when the context changes, or to jump to a line.
pub async fn get_row_of_line(Query(q): Query<ViewQuery>) -> Result<Json<RowOfLineResponse>, ApiError> {
    let r = resolve(&q).await?;
    let line = q.line.unwrap_or(1).max(1) - 1;
    Ok(Json(RowOfLineResponse { row: r.view.row_of_line(line), row_count: r.view.row_count() }))
}

// ---------------------------------------------------------------- /view/search

#[derive(Serialize)]
pub struct SearchHit {
    pub row: u64,
    pub line_number: u64,
    pub text: String,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    /// The search reached the end of the view
    pub complete: bool,
    /// Where to continue when not complete
    pub next_row: u64,
}

/// Case-insensitive text search inside the rows of the view (first 1000 hits, or what
/// is found within the time budget).
pub async fn search_view(Query(q): Query<ViewQuery>) -> Result<Json<SearchResponse>, ApiError> {
    let needle = q.q.clone().unwrap_or_default();
    if needle.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Missing q".into()));
    }
    let re = regex::bytes::RegexBuilder::new(&regex::escape(&needle))
        .case_insensitive(true)
        .build()
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    let r = resolve(&q).await?;
    let from = q.from_row.unwrap_or(0);
    let limit = (q.limit.unwrap_or(MAX_SEARCH_HITS as u64) as usize).min(MAX_SEARCH_HITS);
    let resp = blocking(move || {
        const BLOCK: u64 = 256 * 1024;
        let started = Instant::now();
        let mut hits = Vec::new();
        let total = r.view.row_count();
        let wave = BLOCK * rayon::current_num_threads() as u64;
        let mut row = from;
        // search blocks of rows in parallel, one wave at a time, so the hit limit and
        // the time budget are checked regularly
        while row < total {
            let wave_end = row.saturating_add(wave).min(total);
            let blocks: Vec<u64> = (row..wave_end).step_by(BLOCK as usize).collect();
            let found: Vec<Vec<SearchHit>> = blocks
                .par_iter()
                .map(|&b| {
                    let n = BLOCK.min(wave_end - b);
                    let mut out = Vec::new();
                    for (rw, l, bytes) in ViewLines::new(&r.session.file, &r.view, b, n) {
                        if re.is_match(bytes) {
                            let (text, _) = display_text(bytes, MAX_DISPLAY_BYTES);
                            out.push(SearchHit { row: rw, line_number: l + 1, text });
                            if out.len() >= limit {
                                break;
                            }
                        }
                    }
                    out
                })
                .collect();
            for h in found.into_iter().flatten() {
                hits.push(h);
                if hits.len() >= limit {
                    let next_row = hits.last().map_or(row, |h| h.row + 1);
                    return SearchResponse { hits, complete: next_row >= total, next_row };
                }
            }
            row = wave_end;
            if started.elapsed() > SEARCH_TIME_BUDGET {
                break;
            }
        }
        SearchResponse { hits, complete: row >= total, next_row: row }
    })
    .await?;
    Ok(Json(resp))
}

// ---------------------------------------------------------------- /view/export

fn csv_field(out: &mut Vec<u8>, s: &str) {
    if s.contains([',', '"', '\n', '\r']) {
        out.push(b'"');
        out.extend_from_slice(s.replace('"', "\"\"").as_bytes());
        out.push(b'"');
    } else {
        out.extend_from_slice(s.as_bytes());
    }
}

/// UTC date as YYYY-MM-DD, for the download file name.
fn today() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Write every row of the view as text (original lines) or CSV to `out`.
pub fn write_view(
    file: &LogFile,
    matches: &MatchSet,
    view: &View,
    csv: bool,
    out: &mut impl std::io::Write,
) -> std::io::Result<()> {
    let mut buf: Vec<u8> = Vec::with_capacity(MAX_DISPLAY_BYTES);
    if csv {
        out.write_all(b"Line,Timestamp,Level,Domain,Matched,Context,Message
")?;
    }
    for (_, l, bytes) in ViewLines::new(file, view, 0, view.row_count()) {
        let is_match = matches.is_match(l);
        if csv {
            buf.clear();
            let text = String::from_utf8_lossy(bytes);
            let f = split_log_line(&text);
            buf.extend_from_slice((l + 1).to_string().as_bytes());
            for field in [f.map(|f| f.ts), f.map(|f| f.level), f.map(|f| f.domain)] {
                buf.push(b',');
                csv_field(&mut buf, field.unwrap_or(""));
            }
            buf.extend_from_slice(if is_match { b",true,false," } else { b",false,true," });
            csv_field(&mut buf, &text);
            out.write_all(&buf)?;
        } else {
            out.write_all(bytes)?;
        }
        out.write_all(b"
")?;
    }
    out.flush()
}

/// Export the view of an open session (filter + context) to a local file.
/// Used by the desktop app, whose webview cannot download from the API.
pub async fn export_view_to_file(
    session_id: &str,
    levels: Option<&str>,
    domains: Option<&str>,
    keywords: Option<&str>,
    context: u64,
    csv: bool,
    path: std::path::PathBuf,
) -> Result<u64, String> {
    let session = get_user_log(session_id).ok_or("Session ID not found")?;
    let (matches, _) = session
        .matches(LineFilter::from_csv(levels, domains, keywords))
        .await
        .map_err(|e| match e {
            QueryError::Cancelled => "Cancelled by a newer filter".to_string(),
            QueryError::Internal(m) => m,
        })?;
    let view = matches.view(context);
    let rows = view.row_count();
    tokio::task::spawn_blocking(move || {
        let f = std::fs::File::create(&path)?;
        let mut out = std::io::BufWriter::with_capacity(1024 * 1024, f);
        write_view(&session.file, &matches, &view, csv, &mut out)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Buffers writes and sends them as body chunks; fails once the client is gone.
struct ChannelWriter {
    tx: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
    buf: Vec<u8>,
}

impl ChannelWriter {
    const FLUSH_AT: usize = 256 * 1024;
    fn send(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::take(&mut self.buf));
        self.tx
            .blocking_send(Ok(chunk))
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "client went away"))
    }
}

impl std::io::Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        if self.buf.len() >= Self::FLUSH_AT {
            self.send()?;
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.send()
    }
}

/// Download every row of the view as text (original lines) or CSV, streamed straight
/// from the memory-mapped file.
pub async fn export_view(Query(q): Query<ViewQuery>) -> Result<Response, ApiError> {
    let csv = q.format.as_deref() == Some("csv");
    let r = resolve(&q).await?;
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(8);

    tokio::task::spawn_blocking(move || {
        let mut out = ChannelWriter { tx, buf: Vec::with_capacity(ChannelWriter::FLUSH_AT) };
        // an error only means the client went away
        let _ = write_view(&r.session.file, &r.matches, &r.view, csv, &mut out);
    });

    let stream = futures::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    let mime = if csv { "text/csv" } else { "text/plain" };
    Ok((
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", export_file_name(csv)),
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

/// Default export file name, e.g. `logs_2026-11-19.csv`.
pub fn export_file_name(csv: bool) -> String {
    format!("logs_{}.{}", today(), if csv { "csv" } else { "txt" })
}

// ---------------------------------------------------------------- /close_session

pub async fn close_session(Query(query): Query<CloseSessionQuery>) -> Json<&'static str> {
    remove_user_log(&query.session_id);
    info!("Removed log for session_id: {}", &query.session_id);
    Json("ok")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_quoting() {
        let mut b = Vec::new();
        csv_field(&mut b, "a,\"b\"");
        assert_eq!(b, b"\"a,\"\"b\"\"\"");
        let mut b = Vec::new();
        csv_field(&mut b, "plain");
        assert_eq!(b, b"plain");
    }

    #[test]
    fn today_is_a_date() {
        let t = today();
        assert_eq!(t.len(), 10);
        assert!(t.starts_with("20"));
    }
}
