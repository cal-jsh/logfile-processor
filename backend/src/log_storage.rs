//! Open log sessions: the memory-mapped, indexed file plus a small cache of filter
//! results, so scrolling, changing the context and exporting never rescan the file.

use crate::logfile::categories::{CategoryIndex, CategoryTimeBins};
use crate::logfile::index::LogFile;
use crate::logfile::levels::LevelIndex;
use crate::logfile::timeline::TimeBins;
use crate::logfile::scan::{scan_matches, Cancelled, CompiledFilter};
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
    /// Per-line log levels for the minimap, built on first use.
    levels: tokio::sync::OnceCell<Arc<LevelIndex>>,
    /// All log lines binned by time (minimap "by time"), built on first use.
    time_bins: tokio::sync::OnceCell<Arc<TimeBins>>,
    /// Per-line categories of a field (minimap colouring), per field name, built on first use.
    categories: Mutex<HashMap<String, CategoryCell>>,
    /// Those categories binned by time, per field name, built on first use.
    category_time_bins: Mutex<HashMap<String, Arc<tokio::sync::OnceCell<Arc<CategoryTimeBins>>>>>,
}

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

impl Session {
    pub fn new(path: PathBuf, file: Arc<LogFile>, format: Arc<LogFormat>) -> Self {
        Self { path, file, format, queries: Mutex::new(QueryCache::default()), levels: Default::default(), time_bins: Default::default(), categories: Default::default(), category_time_bins: Default::default() }
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

        // Run the scan in a detached task, so the result is cached even if the client
        // that asked for it disconnects; later requests wait on the same cell.
        let file = self.file.clone();
        let format = self.format.clone();
        let cancel = self.start_scan(&key);
        let task = tokio::spawn(async move {
            cell.get_or_try_init(|| async move {
                let compiled = CompiledFilter::new(filter, format);
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
                let idx = tokio::task::spawn_blocking(move || LevelIndex::build(&file, &format))
                    .await
                    .map_err(|e| QueryError::Internal(e.to_string()))?;
                info!(
                    "Level index of {} lines built in {} ms",
                    idx.line_count(),
                    idx.build_time.as_millis()
                );
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
    format!("{:?}|{:?}|{:?}", f.levels, f.fields, f.keywords)
}

static LOG_STORAGE: Lazy<Mutex<HashMap<String, Arc<Session>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Save a user's opened log
pub fn save_user_log(session_id: &str, session: Session) {
    let count = {
        let mut map = LOG_STORAGE.lock().unwrap();
        map.insert(session_id.to_string(), Arc::new(session));
        map.len()
    };
    info!("Saved log for session_id: {}", session_id);
    info!("Currently {} log files stored", count);
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
