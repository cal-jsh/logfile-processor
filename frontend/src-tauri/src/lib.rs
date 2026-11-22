//! Desktop shell for the log file processor.
//!
//! The window shows the same React UI as the web app. The backend's viewport API runs
//! in-process on a random `127.0.0.1` port, so the UI code is shared; what changes is
//! how a file is opened: a native dialog picks a local path, and the file is
//! memory-mapped in place. Nothing is uploaded or copied, and the file is never
//! deleted when the session closes.

pub mod cli;
pub mod headless;

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
    regex: Option<String>,
    time_from: Option<f64>,
    time_to: Option<f64>,
    context: u64,
    format: String,
    track_field: Option<String>,
) -> Result<Option<view::ExportResult>, String> {
    let kind = view::ExportFormat::parse(&format).ok_or_else(|| format!("Unknown export format {format}"))?;
    let name = view::export_file_name(kind);
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let d = app.dialog().file().set_title("Export rows").set_file_name(name);
        let d = match kind {
            view::ExportFormat::Csv => d.add_filter("CSV", &["csv"]),
            view::ExportFormat::Perfetto => d.add_filter("Perfetto trace (JSON)", &["json"]),
            view::ExportFormat::Text => d.add_filter("Text", &["txt", "log"]),
        };
        d.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let mut opts = view::ExportOptions::new(kind);
    opts.track_field = track_field;
    let result = view::export_view_to_file(
        &session_id,
        levels.as_deref(),
        fields.as_deref(),
        keywords.as_deref(),
        regex.as_deref(),
        (time_from, time_to),
        context,
        opts,
        path.clone(),
    )
    .await?;
    tracing::info!("Exported {} rows to {} ({})", result.rows, path.display(), kind.label());
    Ok(Some(result))
}

/// Cut the time range `[time_from, time_to)` (ms, log clock) out of the session's log
/// into a new file next to it, named after the log and the range. Only the lines in the
/// range are read; the copy is streamed, so a cut of several GB needs no memory.
#[tauri::command]
async fn cut_time_range(
    session_id: String,
    time_from: f64,
    time_to: f64,
) -> Result<logfile_processor::api::cut::CutResult, String> {
    logfile_processor::api::cut::cut_time_range(&session_id, time_from, time_to).await
}

/// Show a file selected in the system file manager (Explorer).
#[tauri::command]
async fn reveal_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || tauri_plugin_opener::reveal_item_in_dir(path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
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
    args.next(); // the program

    let files = match cli::parse(args) {
        Ok(Cli::Help) => {
            cli::attach_parent_console();
            print!("{}", cli::usage());
            return 0;
        }
        Ok(Cli::Filter(f)) => {
            // Works when the output is piped or redirected (the shell then waits);
            // `logfile_processor_cli` is the version a terminal waits for.
            cli::attach_parent_console();
            return headless::run(&f);
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

/// Entry point of `logfile_processor_cli`, the console companion: filters without a
/// window, or starts the viewer exe next to it with the files to open. A terminal
/// waits for it, so exit codes and output arrive in order. Returns the exit code.
pub fn cli_main() -> i32 {
    let files = match cli::parse(std::env::args_os().skip(1)) {
        Ok(Cli::Help) => {
            print!("{}", cli::usage());
            return 0;
        }
        Ok(Cli::Version) => {
            println!("Logfile Processor {}", env!("CARGO_PKG_VERSION"));
            return 0;
        }
        Ok(Cli::Filter(f)) => return headless::run(&f),
        Ok(Cli::Open(files)) => files,
        Err(e) => {
            eprintln!("error: {e}");
            return 2;
        }
    };
    let mut paths = Vec::new();
    for f in &files {
        match cli::check_file(f) {
            Ok(p) => paths.push(p),
            Err(e) => {
                eprintln!("error: {e}");
                return 1;
            }
        }
    }
    let Some(viewer) = viewer_exe() else {
        eprintln!("error: the viewer ({}) is not next to this program", cli::GUI_EXES[0]);
        return 1;
    };
    // The viewer would otherwise log into this terminal, or hold its pipe, after we return.
    cli::keep_std_handles_private();
    let spawned = std::process::Command::new(&viewer)
        .arg("--")
        .args(&paths)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match spawned {
        Ok(_) => 0,
        Err(e) => {
            eprintln!("error: could not start {}: {e}", viewer.display());
            1
        }
    }
}

/// The viewer exe in the folder of the running program.
fn viewer_exe() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    cli::GUI_EXES.iter().map(|n| dir.join(n)).find(|p| p.is_file())
}

/// For the "Command line" dialog: the help text and where the command line program is.
#[derive(Serialize)]
struct CliHelp {
    usage: String,
    /// Full path of `logfile_processor_cli.exe`, if it is next to the viewer
    cli_path: Option<String>,
}

#[tauri::command]
fn cli_help() -> CliHelp {
    let exe = format!("{}{}", cli::CLI_EXE, std::env::consts::EXE_SUFFIX);
    let cli_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(&exe)))
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned());
    CliHelp { usage: cli::usage(), cli_path }
}

/// Moves a restored window back onto a screen when its saved place is no longer usable:
/// the monitor it was on is gone, or only a corner of it is still visible (the window
/// state plugin accepts any corner on any monitor), or it is larger than the screen it
/// is on now (moved from a big monitor to a laptop). The title bar has to be on a
/// monitor's work area so the window can be grabbed; otherwise it is centred on the
/// primary monitor, shrunk to fit if needed. A maximized window is left to Windows.
fn keep_on_screen(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    if window.is_maximized()? || window.is_minimized()? {
        return Ok(());
    }
    let pos = window.outer_position()?;
    let size = window.outer_size()?;
    let monitors = window.available_monitors()?;
    // A point in the title bar, a little in from the left edge and the top
    let (gx, gy) = (pos.x + (size.width as i32).min(200) / 2, pos.y + 12);
    let holder = monitors.iter().find(|m| {
        let a = m.work_area();
        gx >= a.position.x
            && gx < a.position.x + a.size.width as i32
            && gy >= a.position.y
            && gy < a.position.y + a.size.height as i32
    });
    let target = match holder {
        Some(m) => m.clone(),
        None => match window.primary_monitor()?.or_else(|| monitors.first().cloned()) {
            Some(m) => m,
            None => return Ok(()),
        },
    };
    let area = *target.work_area();
    let fits = size.width <= area.size.width && size.height <= area.size.height;
    if holder.is_some() && fits {
        return Ok(());
    }
    let width = size.width.min(area.size.width);
    let height = size.height.min(area.size.height);
    if !fits {
        let inner = window.inner_size()?;
        window.set_size(tauri::PhysicalSize::new(
            inner.width.saturating_sub(size.width - width),
            inner.height.saturating_sub(size.height - height),
        ))?;
    }
    let (mut x, mut y) = (pos.x, pos.y);
    if holder.is_none() {
        x = area.position.x + (area.size.width - width) as i32 / 2;
        y = area.position.y + (area.size.height - height) as i32 / 2;
    }
    // Keep the whole window inside the work area it ends up on
    x = x.clamp(area.position.x, area.position.x + (area.size.width - width) as i32);
    y = y.clamp(area.position.y, area.position.y + (area.size.height - height) as i32);
    window.set_position(tauri::PhysicalPosition::new(x, y))?;
    tracing::info!("Window moved back onto the screen ({}, {}) {}x{}", x, y, width, height);
    Ok(())
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
        // "Update" in the sidebar: checks latest.json of the newest published GitHub
        // release, verifies the installer's signature against plugins.updater.pubkey
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Remembers size, position and maximized state of the window between runs
        // (`.window-state.json` in the app config folder). It restores while the window
        // is created; `keep_on_screen` then fixes a place that no longer fits the screens.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = keep_on_screen(&window) {
                    tracing::warn!("Could not check the window position: {}", e);
                }
            }
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
            cut_time_range,
            reveal_path,
            files_exist,
            initial_file,
            cli_help
        ])
        .run(tauri::generate_context!())
        .expect("error while running the desktop app");
}
