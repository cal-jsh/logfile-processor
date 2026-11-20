//! Viewport API: the viewer asks for the rows it shows instead of receiving every
//! result line.
//!
//! * `GET /lines` reads a range of file lines by line number (sparse line index).
//! * `GET /view` runs (or reuses) a filter scan, which stores only the matching line
//!   numbers, and expands them by `context` lines. It returns the row count.
//! * `GET /view/rows` returns the text of a range of rows of that view.
//! * `GET /view/matches` returns the match line numbers themselves.
//! * `GET /view/row_of_line` and `/view/search` support jumping and searching inside
//!   the results. Exporting them to a file is `export_view_to_file`, called by the
//!   desktop app.
//!
//! Filter results are cached per session, so scrolling or changing `context` never
//! rescans the file. All line numbers in this API are 1-based; rows are 0-based.

use crate::log_storage::{get_user_log, remove_user_log, QueryError, Session};
use crate::logfile::index::{display_text, LogFile};
use crate::logfile::view::{MatchSet, View, ViewLines};
use rayon::prelude::*;
use crate::model::close_session_query::CloseSessionQuery;
use crate::parsing::format::LogFormat;
use crate::parsing::line_filter::LineFilter;

use axum::{
    extract::Query,
    http::StatusCode,
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
        .route("/close_session", post(close_session))
}

/// Query parameters shared by the view endpoints. Unused ones are ignored.
#[derive(Deserialize, Debug)]
pub struct ViewQuery {
    pub session_id: String,
    /// Other fields to filter on, as JSON: `{"domain":["core"],"thread":["12"]}`
    pub fields: Option<String>,
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
    fn filter(&self) -> Result<LineFilter, ApiError> {
        LineFilter::from_query(self.levels.as_deref(), self.fields.as_deref(), self.keywords.as_deref())
            .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))
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
    let (matches, cached) = session.matches(q.filter()?).await?;
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
    /// The line's fields, in the order of the format's columns; `null` when the line
    /// does not have the format (stack traces, banners, ...)
    pub fields: Option<Vec<String>>,
    /// Timestamp in ms since 1970 in the log's own clock, if the line has one
    pub t: Option<f64>,
    /// Shown only as context around a match
    pub context: bool,
    pub truncated: bool,
}

/// Fields and time of a line, for display.
pub fn split_for_display(format: &LogFormat, text: &str) -> (Option<Vec<String>>, Option<f64>) {
    match format.parse(text) {
        None => (None, None),
        Some(p) => {
            let fields = (0..format.fields().len()).map(|i| p.get(text, i).to_string()).collect();
            let t = format.time_ns(text, &p).map(|ns| ns as f64 / 1e6);
            (Some(fields), t)
        }
    }
}

#[derive(Serialize)]
pub struct RowsResponse {
    pub row_count: u64,
    pub rows: Vec<Row>,
}

fn read_rows(file: &LogFile, format: &LogFormat, matches: &MatchSet, view: &View, first: u64, count: u64) -> Vec<Row> {
    ViewLines::new(file, view, first, count)
        .map(|(row, l, bytes)| {
            let (text, truncated) = display_text(bytes, MAX_DISPLAY_BYTES);
            let (fields, t) = split_for_display(format, &text);
            Row { row, line_number: l + 1, text, fields, t, context: !matches.is_match(l), truncated }
        })
        .collect()
}

/// Text of rows `first_row..first_row+count` of the view.
pub async fn get_view_rows(Query(q): Query<ViewQuery>) -> Result<Json<RowsResponse>, ApiError> {
    let r = resolve(&q).await?;
    let first = q.first_row.unwrap_or(0);
    let count = q.count.unwrap_or(100).min(MAX_ROWS_PER_REQUEST);
    let row_count = r.view.row_count();
    let rows = blocking(move || read_rows(&r.session.file, &r.session.format, &r.matches, &r.view, first, count)).await?;
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
    /// As in [`Row::fields`]
    pub fields: Option<Vec<String>>,
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
                            let fields = split_for_display(&r.session.format, &text).0;
                            out.push(SearchHit { row: rw, line_number: l + 1, text, fields });
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

// ---------------------------------------------------------------- export

fn csv_field(out: &mut Vec<u8>, s: &str) {
    if s.contains([',', '"', '\n', '\r']) {
        out.push(b'"');
        out.extend_from_slice(s.replace('"', "\"\"").as_bytes());
        out.push(b'"');
    } else {
        out.extend_from_slice(s.as_bytes());
    }
}

/// UTC date as YYYY-MM-DD, for the export file name.
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

/// Writes lines of a log file as the export does: the original lines as text, or CSV
/// with `Line`, one column per field of the format except the message, `Matched`,
/// `Context`, then `Message`: the whole line, as before (stack traces and other lines
/// without the format have empty field columns).
struct RowWriter<'a> {
    file: &'a LogFile,
    format: &'a LogFormat,
    /// The field columns (all but the message)
    columns: Vec<usize>,
    csv: bool,
    buf: Vec<u8>,
    /// Where the last read ended, so reading on from there needs no seek
    known: Option<(u64, usize)>,
}

impl<'a> RowWriter<'a> {
    fn new(file: &'a LogFile, format: &'a LogFormat, csv: bool) -> Self {
        let columns = (0..format.fields().len()).filter(|&i| Some(i) != format.message_field()).collect();
        Self { file, format, columns, csv, buf: Vec::with_capacity(MAX_DISPLAY_BYTES), known: None }
    }

    fn header(&mut self, out: &mut impl std::io::Write) -> std::io::Result<()> {
        if !self.csv {
            return Ok(());
        }
        self.buf.clear();
        self.buf.extend_from_slice(b"Line");
        for &i in &self.columns {
            self.buf.push(b',');
            csv_field(&mut self.buf, &self.format.fields()[i].label);
        }
        self.buf.extend_from_slice(b",Matched,Context,Message\n");
        out.write_all(&self.buf)
    }

    /// One row: 0-based `line` with its bytes (without the line break).
    fn row(&mut self, out: &mut impl std::io::Write, line: u64, bytes: &[u8], is_match: bool) -> std::io::Result<()> {
        if self.csv {
            let buf = &mut self.buf;
            buf.clear();
            let text = String::from_utf8_lossy(bytes);
            let parsed = self.format.parse(&text);
            buf.extend_from_slice((line + 1).to_string().as_bytes());
            for &i in &self.columns {
                buf.push(b',');
                csv_field(buf, parsed.as_ref().map_or("", |p| p.get(&text, i)));
            }
            buf.extend_from_slice(if is_match { b",true,false," } else { b",false,true," });
            csv_field(buf, &text);
            buf.push(b'\n');
            out.write_all(buf)
        } else {
            out.write_all(bytes)?;
            out.write_all(b"\n")
        }
    }

    /// Rows for the lines `first..end`, all matches or all context.
    fn lines(&mut self, out: &mut impl std::io::Write, first: u64, end: u64, is_match: bool) -> std::io::Result<()> {
        if first >= end {
            return Ok(());
        }
        let file = self.file;
        let mut it = file.lines_from_hint(first, self.known);
        for (line, bytes) in it.by_ref().take((end - first) as usize) {
            self.row(out, line, bytes, is_match)?;
        }
        self.known = Some(it.cursor());
        Ok(())
    }
}

/// Write every row of the view as text (original lines) or CSV to `out`
/// (columns: see [`RowWriter`]).
pub fn write_view(
    file: &LogFile,
    format: &LogFormat,
    matches: &MatchSet,
    view: &View,
    csv: bool,
    out: &mut impl std::io::Write,
) -> std::io::Result<()> {
    let mut w = RowWriter::new(file, format, csv);
    w.header(out)?;
    for (_, l, bytes) in ViewLines::new(file, view, 0, view.row_count()) {
        w.row(out, l, bytes, matches.is_match(l))?;
    }
    out.flush()
}

/// Export the view of an open session (filter + context) to a local file.
pub async fn export_view_to_file(
    session_id: &str,
    levels: Option<&str>,
    fields: Option<&str>,
    keywords: Option<&str>,
    context: u64,
    csv: bool,
    path: std::path::PathBuf,
) -> Result<u64, String> {
    let session = get_user_log(session_id).ok_or("Session ID not found")?;
    let (matches, _) = session
        .matches(LineFilter::from_query(levels, fields, keywords)?)
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
        write_view(&session.file, &session.format, &matches, &view, csv, &mut out)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// What [`filter_file`] wrote.
pub struct FilterStats {
    pub line_count: u64,
    pub match_count: u64,
    /// Rows written: matches plus context lines
    pub row_count: u64,
}

/// Filter a file without a session (the command line) and write the rows as text or
/// CSV to `out`, as they are found. Same filter and row writer as the viewer's export,
/// and the same rows as its [`View`] with `context` lines (a test checks this), but
/// nothing is collected: memory stays small however many lines match.
pub fn filter_file(
    file: &LogFile,
    format: Arc<LogFormat>,
    filter: LineFilter,
    context: u64,
    csv: bool,
    out: &mut impl std::io::Write,
) -> std::io::Result<FilterStats> {
    let compiled = crate::logfile::scan::CompiledFilter::new(filter, format.clone());
    let line_count = file.line_count();
    let mut w = RowWriter::new(file, &format, csv);
    w.header(out)?;
    let (mut match_count, mut row_count) = (0u64, 0u64);
    // `written`: first line not written yet; `tail`: end of the last match's context
    let (mut written, mut tail) = (0u64, 0u64);
    crate::logfile::scan::scan_streaming(file, &compiled, |ranges| {
        for &(s, e) in ranges {
            // the rest of the previous match's trailing context
            let after = tail.min(s).max(written);
            w.lines(out, written, after, false)?;
            // leading context, not before what is written already
            let before = s.saturating_sub(context).max(after);
            w.lines(out, before, s, false)?;
            w.lines(out, s, e, true)?;
            row_count += (after - written) + (s - before) + (e - s);
            match_count += e - s;
            written = e;
            tail = e.saturating_add(context).min(line_count);
        }
        Ok::<(), std::io::Error>(())
    })?;
    if tail > written {
        w.lines(out, written, tail, false)?;
        row_count += tail - written;
    }
    out.flush()?;
    Ok(FilterStats { line_count, match_count, row_count })
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
    fn csv_export_has_a_column_per_field() {
        use crate::logfile::scan::{scan_matches, CompiledFilter};
        use crate::parsing::format::LogFormat;
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        let text = "[2026-11-20 10:00:00.001] [7] [info] a, b\n    at frame\n[2026-11-20 10:00:00.002] [8] [error] boom\n";
        let file = LogFile::from_test_bytes(text.as_bytes(), 64);
        let fmt = Arc::new(LogFormat::compile("[%Y-%m-%d %H:%M:%S.%e] [%t] [%l] %v").unwrap());
        let filter = LineFilter::from_query(None, Some(r#"{"thread":["8"]}"#), None).unwrap();
        let m = scan_matches(&file, &CompiledFilter::new(filter, fmt.clone()), &AtomicBool::new(false))
            .unwrap_or_else(|_| panic!("cancelled"));
        let v = m.view(1);
        let mut out = Vec::new();
        write_view(&file, &fmt, &m, &v, true, &mut out).unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "Line,Time,Thread,Level,Matched,Context,Message\n\
             2,,,,false,true,    at frame\n\
             3,2026-11-20 10:00:00.002,8,error,true,false,[2026-11-20 10:00:00.002] [8] [error] boom\n"
        );
    }

    #[test]
    fn streaming_filter_writes_the_same_rows_as_the_view_export() {
        use crate::logfile::scan::{scan_matches, CompiledFilter};
        use std::sync::atomic::AtomicBool;
        // matches in runs, alone, at both ends and close together, with odd lines between
        let mut text = String::new();
        for i in 0..400u32 {
            let level = if i % 7 == 0 || i % 31 < 3 || i == 399 { "error" } else { "info" };
            if i % 11 == 5 {
                text.push_str("    at frame\n");
            } else {
                text.push_str(&format!("[2026-11-20 10:00:00.{:03}] [{}] [{level}] line {i}\n", i % 1000, i % 4));
            }
        }
        // small chunks, so the streaming scan hands over many waves
        let file = LogFile::from_test_bytes(text.as_bytes(), 256);
        let fmt = Arc::new(LogFormat::compile("[%Y-%m-%d %H:%M:%S.%e] [%t] [%l] %v").unwrap());
        let cases = [(Some("error"), None), (None, Some(r#"{"thread":["2"]}"#)), (Some("nope"), None), (None, None)];
        for (levels, fields) in cases {
            for context in [0, 1, 2, 5, 1000] {
                for csv in [false, true] {
                    let filter = LineFilter::from_query(levels, fields, None).unwrap();
                    let m = scan_matches(&file, &CompiledFilter::new(filter.clone(), fmt.clone()), &AtomicBool::new(false))
                        .unwrap_or_else(|_| panic!("cancelled"));
                    let v = m.view(context);
                    let mut expected = Vec::new();
                    write_view(&file, &fmt, &m, &v, csv, &mut expected).unwrap();
                    let mut got = Vec::new();
                    let stats = filter_file(&file, fmt.clone(), filter, context, csv, &mut got).unwrap();
                    assert!(expected == got, "{levels:?} {fields:?} context {context} csv {csv}");
                    assert_eq!((stats.match_count, stats.row_count), (m.match_count(), v.row_count()));
                }
            }
        }
    }

    #[test]
    fn today_is_a_date() {
        let t = today();
        assert_eq!(t.len(), 10);
        assert!(t.starts_with("20"));
    }
}
