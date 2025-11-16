// tracing
use tracing::{info};
// once_cell
use once_cell::sync::Lazy;
// std
use std::collections::HashMap;
use std::sync::Mutex;


static LOG_STORAGE: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Save a user's log
pub fn save_user_log(session_id: &str, log_text: String) {
    LOG_STORAGE.lock().unwrap().insert(session_id.to_string(), log_text);
    info!("Saved log for session_id: {}", session_id);
    info!("Currently {} log files stored", LOG_STORAGE.lock().unwrap().len());
}

/// Retrieve a user's log
pub fn get_user_log(session_id: &str) -> Option<String> {
    LOG_STORAGE.lock().unwrap().get(session_id).cloned()
}

/// Remove a user's log
pub fn remove_user_log(session_id: &str) {
    LOG_STORAGE.lock().unwrap().remove(session_id);
    info!("Removed log for session_id: {}", session_id);
    info!("Currently {} log files stored", LOG_STORAGE.lock().unwrap().len());
}