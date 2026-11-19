//! Desktop shell for the log file processor.
//!
//! The window shows the same React UI as the web app. The backend's viewport API runs
//! in-process on a random `127.0.0.1` port, so the UI code is shared; what changes is
//! how a file is opened: a native dialog picks a local path, and the file is
//! memory-mapped in place. Nothing is uploaded or copied, and the file is never
//! deleted when the session closes.

use logfile_processor::api::view;
use logfile_processor::model::upload_response::UploadResponse;
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// An opened file: its path plus what the web upload returns.
#[derive(Serialize)]
struct Opened {
    path: String,
    #[serde(flatten)]
    log: UploadResponse,
}

/// Base URL of the in-process API, e.g. `http://127.0.0.1:53412`.
struct ApiBase(String);

#[tauri::command]
fn api_base_url(base: tauri::State<'_, ApiBase>) -> String {
    base.0.clone()
}

/// Open a log file in place by path and return its session and summary.
#[tauri::command]
async fn open_log_path(path: String) -> Result<Opened, String> {
    open(PathBuf::from(path)).await
}

/// Show the native file-open dialog and open the chosen file. `None` if cancelled.
#[tauri::command]
async fn open_log_dialog(app: tauri::AppHandle) -> Result<Option<Opened>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Open log file")
            .add_filter("Log files", &["log", "txt", "csv"])
            .add_filter("All files", &["*"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    open(path).await.map(Some)
}

/// Export the current view (filter + context) through a native Save dialog. The
/// webview cannot download from the API, so Rust writes the file directly.
/// Returns the saved path, or `None` if cancelled.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn export_view(
    app: tauri::AppHandle,
    session_id: String,
    levels: Option<String>,
    domains: Option<String>,
    keywords: Option<String>,
    context: u64,
    format: String,
) -> Result<Option<String>, String> {
    let csv = format == "csv";
    let name = view::export_file_name(csv);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let d = app.dialog().file().set_title("Export rows").set_file_name(name);
        let d = if csv {
            d.add_filter("CSV", &["csv"])
        } else {
            d.add_filter("Text", &["txt", "log"])
        };
        d.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let rows = view::export_view_to_file(
        &session_id,
        levels.as_deref(),
        domains.as_deref(),
        keywords.as_deref(),
        context,
        csv,
        path.clone(),
    )
    .await?;
    tracing::info!("Exported {} rows to {}", rows, path.display());
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// A file passed on the command line (e.g. "Open with"), opened on start.
#[tauri::command]
fn initial_file() -> Option<String> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

async fn open(path: PathBuf) -> Result<Opened, String> {
    tauri::async_runtime::spawn_blocking(move || {
        logfile_processor::open_session(path.clone(), false)
            .map(|log| Opened { path: path.to_string_lossy().into_owned(), log })
            .map_err(|e| format!("Could not open {}: {}", path.display(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Bind before the window loads, so the UI can ask for the URL right away.
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            listener.set_nonblocking(true)?;
            let base = format!("http://{}", listener.local_addr()?);
            tracing::info!("Desktop API listening on {}", base);
            app.manage(ApiBase(base));

            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener)
                    .expect("convert API listener");
                if let Err(e) = axum::serve(listener, logfile_processor::desktop_router()).await {
                    tracing::error!("Desktop API stopped: {}", e);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api_base_url,
            open_log_path,
            open_log_dialog,
            export_view,
            initial_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running the desktop app");
}
