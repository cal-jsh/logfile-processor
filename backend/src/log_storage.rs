//! Open log sessions: the memory-mapped, indexed file plus a small cache of filter
//! results, so scrolling, changing the context and exporting never rescan the file.

use crate::logfile::index::LogFile;
use crate::logfile::scan::{scan_matches, Cancelled, CompiledFilter};
use crate::logfile::view::MatchSet;
use crate::parsing::line_filter::LineFilter;
// tracing
use tracing::{info, warn};
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
    queries: Mutex<QueryCache>,
}

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
    pub fn new(path: PathBuf, file: LogFile) -> Self {
        Self { path, file: Arc::new(file), queries: Mutex::new(QueryCache::default()) }
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
        let cancel = self.start_scan(&key);
        let task = tokio::spawn(async move {
            cell.get_or_try_init(|| async move {
                let compiled = CompiledFilter::new(filter);
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
    format!("{:?}|{:?}|{:?}", f.levels, f.domains, f.keywords)
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
        let path = session.path.clone();
        // The file must be unmapped before it can be deleted on Windows. A request that
        // is still running holds its own reference; the delete then fails and is logged.
        drop(session);
        if let Err(e) = std::fs::remove_file(&path) {
            warn!("Could not delete {}: {}", path.display(), e);
        }
    }
    info!("Removed log for session_id: {}", session_id);
    info!("Currently {} log files stored", count);
}
