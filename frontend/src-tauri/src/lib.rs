//! Desktop shell for the log file processor.
//!
//! The window shows the same React UI as the web app. The backend's viewport API runs
//! in-process on a random `127.0.0.1` port, so the UI code is shared; what changes is
//! how a file is opened: a native dialog picks a local path, and the file is
//! memory-mapped in place. Nothing is uploaded or copied, and the file is never
//! deleted when the session closes.

pub mod cli;

use cli::Cli;
use logfile_processor::api::view;
use logfile_processor::model::upload_response::UploadResponse;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
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

/// Open a log file in place by path and return its session and summary. The line
/// format is detected, unless `pattern` (spdlog syntax) is given.
#[tauri::command]
async fn open_log_path(path: String, pattern: Option<String>) -> Result<Opened, String> {
    open(PathBuf::from(path), pattern).await
}

/// Open the file of a session again with another line format (`None`: detect it).
/// The old session is closed.
#[tauri::command]
async fn reformat_log(session_id: String, pattern: Option<String>) -> Result<UploadResponse, String> {
    tauri::async_runtime::spawn_blocking(move || logfile_processor::reformat_session(&session_id, pattern))
        .await
        .map_err(|e| e.to_string())?
}

/// Show the native file-open dialog. Returns the chosen path, `None` if cancelled.
/// The UI then opens it with `open_log_path`, with the pattern remembered for it.
#[tauri::command]
async fn pick_log_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
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
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Which of these paths are files right now, for the recently opened list. Runs off the
/// main thread, since a path on an unreachable network share can take a while to fail.
#[tauri::command]
async fn files_exist(paths: Vec<String>) -> Result<Vec<bool>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths.iter().map(|p| std::path::Path::new(p).is_file()).collect()
    })
    .await
    .map_err(|e| e.to_string())
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
    fields: Option<String>,
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
        fields.as_deref(),
        keywords.as_deref(),
        context,
        csv,
        path.clone(),
    )
    .await?;
    tracing::info!("Exported {} rows to {}", rows, path.display());
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// The file from the command line (or dropped onto the exe icon), already checked:
/// a path to open, or the message saying why it cannot be opened.
struct InitialFile(Mutex<Option<Result<String, String>>>);

/// The file to open on start, if any. Handed out once, so a reload of the page
/// (or React running effects twice in dev) does not open it again.
#[tauri::command]
fn initial_file(initial: tauri::State<'_, InitialFile>) -> Result<Option<String>, String> {
    initial.0.lock().unwrap().take().transpose()
}

async fn open(path: PathBuf, pattern: Option<String>) -> Result<Opened, String> {
    tauri::async_runtime::spawn_blocking(move || {
        logfile_processor::open_session(path.clone(), pattern)
            .map(|log| Opened { path: path.to_string_lossy().into_owned(), log })
            .map_err(|e| format!("Could not open {}: {}", path.display(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Entry point of the exe: handle the command line, then run the window.
/// Returns the process exit code.
pub fn start() -> i32 {
    let mut args = std::env::args_os();
    let exe = args
        .next()
        .map(PathBuf::from)
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "logfile_processor_desktop.exe".into());

    let files = match cli::parse(args) {
        Ok(Cli::Help) => {
            cli::attach_parent_console();
            print!("{}", cli::usage(&exe));
            return 0;
        }
        Ok(Cli::Version) => {
            cli::attach_parent_console();
            println!("Logfile Processor {}", env!("CARGO_PKG_VERSION"));
            return 0;
        }
        Ok(Cli::Open(files)) => files,
        Err(e) => {
            if cli::attach_parent_console() {
                eprintln!("error: {e}");
                return 2;
            }
            run_with(Some(Err(e)));
            return 0;
        }
    };

    let checked: Vec<_> = files.iter().map(|f| cli::check_file(f)).collect();
    // From a terminal, report bad paths there and stop, like any command line tool.
    // From Explorer there is no terminal, so the window shows the error instead.
    if checked.iter().any(|c| c.is_err()) && cli::attach_parent_console() {
        for e in checked.iter().filter_map(|c| c.as_ref().err()) {
            eprintln!("error: {e}");
        }
        return 1;
    }

    // One file per window: this process opens the first, a new one each of the rest.
    let mut checked = checked.into_iter().zip(&files);
    let first = checked.next().map(|(c, _)| c.map(|p| p.to_string_lossy().into_owned()));
    if let Ok(me) = std::env::current_exe() {
        for (c, original) in checked {
            let path = c.unwrap_or_else(|_| original.clone());
            if let Err(e) = std::process::Command::new(&me).arg("--").arg(&path).spawn() {
                tracing::error!("Could not start a window for {}: {}", path.display(), e);
            }
        }
    }
    run_with(first);
    0
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with(None)
}

fn run_with(initial: Option<Result<String, String>>) {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_target(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Bind before the window loads, so the UI can ask for the URL right away.
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            listener.set_nonblocking(true)?;
            let base = format!("http://{}", listener.local_addr()?);
            tracing::info!("Desktop API listening on {}", base);
            app.manage(ApiBase(base));
            app.manage(InitialFile(Mutex::new(initial)));

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
            pick_log_file,
            reformat_log,
            export_view,
            files_exist,
            initial_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running the desktop app");
}
