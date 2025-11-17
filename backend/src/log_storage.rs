// tracing
use tracing::info;
// once_cell
use once_cell::sync::Lazy;
// std
use std::collections::HashMap;
use std::sync::Mutex;

static LOG_STORAGE: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Save a user's log path
pub fn save_user_log(session_id: &str, file_path: String) {
    LOG_STORAGE.lock().unwrap().insert(session_id.to_string(), file_path.clone());
    info!("Saved log for session_id: {}", session_id);
    info!("Currently {} log files stored", LOG_STORAGE.lock().unwrap().len());
}

/// Retrieve a user's log path
pub fn get_user_log(session_id: &str) -> Option<String> {
    LOG_STORAGE.lock().unwrap().get(session_id).cloned()
}

/// Remove a user's log
pub fn remove_user_log(session_id: &str) {
    if let Some(path) = LOG_STORAGE.lock().unwrap().remove(session_id) {
        // optionally remove the file from disk
        let _ = std::fs::remove_file(path);
    }
    info!("Removed log for session_id: {}", session_id);
    info!("Currently {} log files stored", LOG_STORAGE.lock().unwrap().len());
}
