//! Open log sessions: the memory-mapped, indexed file plus a small cache of filter
//! results, so scrolling, changing the context and exporting never rescan the file.

use crate::logfile::categories::{CategoryIndex, CategoryTimeBins};
use crate::logfile::index::LogFile;
use crate::logfile::lanes::{LaneBins, LaneIndex};
use crate::logfile::view::LaneKey;
use crate::logfile::levels::LevelIndex;
use crate::logfile::timeline::TimeBins;
use crate::logfile::scan::{pending_summary, scan_head, scan_matches, Cancelled, CompiledFilter};
use crate::model::log_summary::LogSummary;
use crate::logfile::view::MatchSet;
use crate::parsing::format::LogFormat;
use crate::parsing::line_filter::LineFilter;
// tracing
use tracing::info;
// once_cell
use once_cell::sync::Lazy;
// std
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Filter results kept per session (each is a list of line ranges, usually small).
const QUERY_CACHE_SIZE: usize = 8;

type MatchCell = Arc<tokio::sync::OnceCell<Arc<MatchSet>>>;

pub struct Session {
    pub path: PathBuf,
    pub file: Arc<LogFile>,
    /// How lines are split into fields
    pub format: Arc<LogFormat>,
    queries: Mutex<QueryCache>,
    /// Per-line log levels for the minimap, built in the background when the file is
    /// opened (see [`Session::start_indexing`]) or on first use.
    levels: tokio::sync::OnceCell<Arc<LevelIndex>>,
    /// The file's summary, counted in the same pass as `levels`.
    summary: std::sync::OnceLock<Arc<LogSummary>>,
    /// How the format was chosen, copied into the summary.
    format_choice: FormatChoice,
    /// The unfiltered matches of the first index chunk, to show the first rows before
    /// the whole file is indexed. Computed on first use.
    head: std::sync::OnceLock<Arc<(MatchSet, u64)>>,
    /// All log lines binned by time (minimap "by time"), built on first use.
    time_bins: tokio::sync::OnceCell<Arc<TimeBins>>,
    /// Per-line categories of a field (minimap colouring), per field name, built on first use.
    categories: Mutex<HashMap<String, CategoryCell>>,
    /// Those categories binned by time, per field name, built on first use.
    category_time_bins: Mutex<HashMap<String, Arc<tokio::sync::OnceCell<Arc<CategoryTimeBins>>>>>,
    /// Swimlanes of a field (thread lanes), per field name, built on first use.
    lanes: Mutex<HashMap<String, Arc<tokio::sync::OnceCell<Arc<LaneIndex>>>>>,
    /// Zoomed-in lane windows, most recently used last.
    lane_windows: Mutex<VecDeque<(LaneKey, Arc<LaneBins>)>>,
}

/// Zoomed lane windows kept per session (and per filter result).
pub const LANE_WINDOW_CACHE: usize = 6;

type CategoryCell = Arc<tokio::sync::OnceCell<Arc<CategoryIndex>>>;

#[derive(Default)]
struct QueryCache {
    /// Most recently used last.
    entries: VecDeque<(String, MatchCell)>,
    /// The scan currently running, so a newer query can cancel it.
    running: Option<(String, Arc<AtomicBool>)>,
}

pub enum QueryError {
    /// A newer query for this session replaced this one before it finished.
    Cancelled,
    Internal(String),
}

/// How the line format of a session was chosen (shown with the summary).
#[derive(Clone, Copy, Default)]
pub struct FormatChoice {
    pub detected: bool,
    pub sample_lines: usize,
    pub sample_matched: usize,
}

/// Index chunks (16 MB each) scanned for the first rows of the unfiltered view.
const HEAD_CHUNKS: usize = 1;

impl Session {
    pub fn new(path: PathBuf, file: Arc<LogFile>, format: Arc<LogFormat>, format_choice: FormatChoice) -> Self {
        Self {
            path,
            file,
            format,
            queries: Mutex::new(QueryCache::default()),
            levels: Default::default(),
            summary: Default::default(),
            format_choice,
            head: Default::default(),
            time_bins: Default::default(),
            categories: Default::default(),
            category_time_bins: Default::default(),
            lanes: Default::default(),
            lane_windows: Default::default(),
        }
    }

    /// Build the level index (and with it the summary and the unfiltered view) in the
    /// background now, instead of when the first request needs it. Requests that need
    /// it meanwhile wait for this build rather than starting their own. Does nothing
    /// outside a Tokio runtime (the index is then built on first use).
    pub fn start_indexing(self: &Arc<Self>) {
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let s = self.clone();
            rt.spawn(async move {
                let _ = s.levels().await;
            });
        }
    }

    /// The summary while it is not counted yet: line count and format only.
    pub fn pending_summary(&self) -> LogSummary {
        self.fill_choice(pending_summary(&self.file, &self.format))
    }

    /// The file's summary, counted (once) together with the level index.
    pub async fn summary(&self) -> Result<Arc<LogSummary>, QueryError> {
        self.levels().await?;
        self.summary.get().cloned().ok_or_else(|| QueryError::Internal("summary missing".into()))
    }

    fn fill_choice(&self, mut s: LogSummary) -> LogSummary {
        s.format.detected = self.format_choice.detected;
        s.format.sample_lines = self.format_choice.sample_lines;
        s.format.sample_matched = self.format_choice.sample_matched;
        s
    }

    /// The cached result of `filter` if it is complete, without waiting or scanning.
    pub fn cached_matches(&self, filter: &LineFilter) -> Option<Arc<MatchSet>> {
        let key = cache_key(filter);
        let q = self.queries.lock().unwrap();
        q.entries.iter().find(|(k, _)| *k == key).and_then(|(_, c)| c.get().cloned())
    }

    /// The unfiltered matches of the start of the file and the line they are exact up
    /// to (see [`scan_head`]). Cheap: one index chunk.
    pub fn head(&self) -> Arc<(MatchSet, u64)> {
        self.head
            .get_or_init(|| {
                let filter = CompiledFilter::new(LineFilter::default(), self.format.clone());
                Arc::new(scan_head(&self.file, &filter, HEAD_CHUNKS))
            })
            .clone()
    }

    /// The lines matching `filter`, from the cache or by scanning the file.
    /// Returns the match set and whether it came from the cache.
    pub async fn matches(&self, filter: LineFilter) -> Result<(Arc<MatchSet>, bool), QueryError> {
        let key = cache_key(&filter);
        let cell = {
            let mut q = self.queries.lock().unwrap();
            let cell = match q.entries.iter().position(|(k, _)| *k == key) {
                Some(i) => {
                    let e = q.entries.remove(i).unwrap();
                    let cell = e.1.clone();
                    q.entries.push_back(e);
                    cell
                }
                None => {
                    let cell: MatchCell = Default::default();
                    q.entries.push_back((key.clone(), cell.clone()));
                    while q.entries.len() > QUERY_CACHE_SIZE {
                        q.entries.pop_front();
                    }
                    cell
                }
            };
            if let Some(m) = cell.get() {
                return Ok((m.clone(), true));
            }
            cell
        };

        // A time range skips the index chunks outside it, known from the level index
        // (usually built already for the minimap). The unfiltered view is read from the
        // level index (the lines in the format), so it needs no scan of its own.
        let unfiltered = filter.is_empty();
        let levels = if filter.time.is_some() || unfiltered { Some(self.levels().await?.0) } else { None };

        // Run the scan in a detached task, so the result is cached even if the client
        // that asked for it disconnects; later requests wait on the same cell.
        let file = self.file.clone();
        let format = self.format.clone();
        let cancel = self.start_scan(&key);
        let task = tokio::spawn(async move {
            cell.get_or_try_init(|| async move {
                if let (true, Some(l)) = (unfiltered, &levels) {
                    let l = l.clone();
                    let started = std::time::Instant::now();
                    let ranges = tokio::task::spawn_blocking(move || l.format_ranges())
                        .await
                        .map_err(|e| QueryError::Internal(e.to_string()))?;
                    return Ok(Arc::new(MatchSet::new(ranges, file.line_count(), started.elapsed())));
                }
                let mut compiled = CompiledFilter::new(filter, format);
                if let Some(l) = levels {
                    compiled = compiled.with_chunk_spans(l);
                }
                let res = tokio::task::spawn_blocking(move || {
                    scan_matches(&file, &compiled, &cancel)
                })
                .await
                .map_err(|e| QueryError::Internal(e.to_string()))?;
                match res {
                    Ok(m) => Ok(Arc::new(m)),
                    Err(Cancelled) => Err(QueryError::Cancelled),
                }
            })
            .await
            .cloned()
        });
        let m = task.await.map_err(|e| QueryError::Internal(e.to_string()))??;
        info!(
            "Scan of {} lines: {} matches in {} ms",
            m.line_count(),
            m.match_count(),
            m.scan_time.as_millis()
        );
        Ok((m, false))
    }

    /// The per-line level index, built (once, in parallel) on first use.
    /// Returns the index and whether it was already built.
    pub async fn levels(&self) -> Result<(Arc<LevelIndex>, bool), QueryError> {
        if let Some(l) = self.levels.get() {
            return Ok((l.clone(), true));
        }
        let file = self.file.clone();
        let format = self.format.clone();
        let l = self
            .levels
            .get_or_try_init(|| async move {
                let (idx, summary) = tokio::task::spawn_blocking(move || INDEX_POOL.install(|| LevelIndex::build_with_summary(&file, &format)))
                    .await
                    .map_err(|e| QueryError::Internal(e.to_string()))?;
                info!(
                    "Level index and summary of {} lines built in {} ms",
                    idx.line_count(),
                    idx.build_time.as_millis()
                );
                let _ = self.summary.set(Arc::new(self.fill_choice(summary)));
                Ok::<_, QueryError>(Arc::new(idx))
            })
            .await?;
        Ok((l.clone(), false))
    }

    /// All log lines binned by time, built (once, in parallel) on first use.
    pub async fn time_bins(&self, levels: Arc<LevelIndex>) -> Result<Arc<TimeBins>, QueryError> {
        let file = self.file.clone();
        let format = self.format.clone();
        let bins = self
            .time_bins
            .get_or_try_init(|| async move {
                let bins = tokio::task::spawn_blocking(move || TimeBins::build_all(&file, &levels, &format))
                    .await
                    .map_err(|e| QueryError::Internal(e.to_string()))?;
                info!("Time bins of {} lines built in {} ms", bins.timed_lines, bins.build_time.as_millis());
                Ok::<_, QueryError>(Arc::new(bins))
            })
            .await?;
        Ok(bins.clone())
    }

    /// The categories of field `name` (format field number `field`) per line, built (once,
    /// in parallel) on first use. Returns the index and whether it was already built.
    pub async fn categories(&self, name: &str, field: usize) -> Result<(Arc<CategoryIndex>, bool), QueryError> {
        let cell = self.categories.lock().unwrap().entry(name.to_string()).or_default().clone();
        if let Some(c) = cell.get() {
            return Ok((c.clone(), true));
        }
        let file = self.file.clone();
        let format = self.format.clone();
        let c = cell
            .get_or_try_init(|| async move {
                let idx = tokio::task::spawn_blocking(move || CategoryIndex::build(&file, &format, field))
                    .await
                    .map_err(|e| QueryError::Internal(e.to_string()))?;
                info!(
                    "Category index of {} lines ({} top groups, {} others) built in {} ms",
                    idx.line_count(),
                    idx.top.len(),
                    idx.other_groups,
                    idx.build_time.as_millis()
                );
                Ok::<_, QueryError>(Arc::new(idx))
            })
            .await?;
        Ok((c.clone(), false))
    }

    /// The categories of field `name` binned by time, built (once, in parallel) on first use.
    pub async fn category_time_bins(
        &self,
        name: &str,
        levels: Arc<LevelIndex>,
        cats: Arc<CategoryIndex>,
    ) -> Result<Arc<CategoryTimeBins>, QueryError> {
        let cell = self.category_time_bins.lock().unwrap().entry(name.to_string()).or_default().clone();
        let file = self.file.clone();
        let format = self.format.clone();
        let bins = cell
            .get_or_try_init(|| async move {
                let bins = tokio::task::spawn_blocking(move || CategoryTimeBins::build_all(&file, &levels, &cats, &format))
                    .await
                    .map_err(|e| QueryError::Internal(e.to_string()))?;
                info!("Category time bins built in {} ms", bins.build_time.as_millis());
                Ok::<_, QueryError>(Arc::new(bins))
            })
            .await?;
        Ok(bins.clone())
    }

    /// The swimlanes of field `name` (format field number `field`), built (once, in
    /// parallel) on first use. Returns the index and whether it was already built.
    pub async fn lanes(&self, name: &str, field: usize, levels: Arc<LevelIndex>) -> Result<(Arc<LaneIndex>, bool), QueryError> {
        let cell = self.lanes.lock().unwrap().entry(name.to_string()).or_default().clone();
        if let Some(c) = cell.get() {
            return Ok((c.clone(), true));
        }
        let file = self.file.clone();
        let format = self.format.clone();
        let idx = cell
            .get_or_try_init(|| async move {
                let idx = tokio::task::spawn_blocking(move || LaneIndex::build(&file, &levels, &format, field))
                    .await
                    .map_err(|e| QueryError::Internal(e.to_string()))?;
                info!(
                    "Lane index ({} lanes, {} values in 'other') built in {} ms",
                    idx.lanes.lanes.len(),
                    idx.lanes.other_values,
                    idx.build_time.as_millis()
                );
                Ok::<_, QueryError>(Arc::new(idx))
            })
            .await?;
        Ok((idx.clone(), false))
    }

    /// A cached zoomed-in lane window.
    pub fn lane_window(&self, key: &LaneKey) -> Option<Arc<LaneBins>> {
        let mut w = self.lane_windows.lock().unwrap();
        let i = w.iter().position(|e| &e.0 == key)?;
        let e = w.remove(i).unwrap();
        let bins = e.1.clone();
        w.push_back(e);
        Some(bins)
    }

    pub fn put_lane_window(&self, key: LaneKey, bins: Arc<LaneBins>) {
        let mut w = self.lane_windows.lock().unwrap();
        w.retain(|e| e.0 != key);
        w.push_back((key, bins));
        while w.len() > LANE_WINDOW_CACHE {
            w.pop_front();
        }
    }

    /// Register a scan for `key` and cancel a running scan for any other query.
    fn start_scan(&self, key: &str) -> Arc<AtomicBool> {
        let mut q = self.queries.lock().unwrap();
        if let Some((k, flag)) = &q.running {
            if k == key {
                return flag.clone();
            }
            flag.store(true, Ordering::Relaxed);
        }
        let flag = Arc::new(AtomicBool::new(false));
        q.running = Some((key.to_string(), flag.clone()));
        flag
    }
}

fn cache_key(f: &LineFilter) -> String {
    format!("{:?}|{:?}|{:?}|{:?}|{:?}", f.levels, f.fields, f.keywords, f.patterns, f.time)
}

/// Threads of the pass that indexes a file after it is opened: all cores but two. On
/// every core it left the window too little CPU to draw the first rows (on 16 cores,
/// 5 GB: rows on screen after 1.7 s instead of 0.9 s), for a pass only ~5% faster.
static INDEX_POOL: Lazy<rayon::ThreadPool> = Lazy::new(|| {
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    rayon::ThreadPoolBuilder::new()
        .num_threads(cores.saturating_sub(2).max(1))
        .thread_name(|i| format!("index-{i}"))
        .build()
        .expect("index thread pool")
});

static LOG_STORAGE: Lazy<Mutex<HashMap<String, Arc<Session>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Save a user's opened log
pub fn save_user_log(session_id: &str, session: Session) -> Arc<Session> {
    let session = Arc::new(session);
    let count = {
        let mut map = LOG_STORAGE.lock().unwrap();
        map.insert(session_id.to_string(), session.clone());
        map.len()
    };
    info!("Saved log for session_id: {}", session_id);
    info!("Currently {} log files stored", count);
    session
}

/// Retrieve a user's opened log
pub fn get_user_log(session_id: &str) -> Option<Arc<Session>> {
    LOG_STORAGE.lock().unwrap().get(session_id).cloned()
}

/// Remove a user's log
pub fn remove_user_log(session_id: &str) {
    let (removed, count) = {
        let mut map = LOG_STORAGE.lock().unwrap();
        let removed = map.remove(session_id);
        (removed, map.len())
    };
    if let Some(session) = removed {
        // A request that is still running holds its own reference; the file is
        // unmapped when the last one is dropped.
        info!("Closed {}", session.path.display());
    }
    info!("Removed log for session_id: {}", session_id);
    info!("Currently {} log files stored", count);
}
