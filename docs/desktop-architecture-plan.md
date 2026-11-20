# Logfile Processor: Architecture

_Updated 2026-11-20. Describes the app as built, then what is still planned._

## Overview

A Windows desktop app (Tauri 2) for log files of many GB. Rust owns the file; the
React UI only ever asks for what is on screen.

```
┌──────────────── logfile_processor_desktop.exe ────────────────┐
│  WebView2: React UI (frontend/src)                            │
│      │ fetch                       │ Tauri commands            │
│      ▼                             ▼                           │
│  axum viewport API on        Tauri shell (frontend/src-tauri) │
│  127.0.0.1:<random port>     open/save dialogs, CLI, export,  │
│      │                       recent-file checks, updater      │
│      ▼                                                         │
│  backend/ (lib crate): mmap + sparse line index, formats,     │
│  parallel scans, views, minimap / lane aggregates             │
└───────────────────────────────────────────────────────────────┘
logfile_processor_cli.exe: console companion, same core, headless filtering
```

The UI talks to the core over HTTP on a private localhost port (CORS limited to the
webview origins) rather than Tauri IPC. That started as a stepping stone and stayed:
the API is plain `GET`s, easy to test, and IPC would not make the per-screen requests
measurably faster.

## Components

| Path | What it is |
|---|---|
| `backend/src/logfile/index.rs` | `LogFile`: read-only `memmap2` map plus a sparse index (offset of every 1,024th line), built in parallel over 16 MB chunks with `memchr` + `rayon` |
| `backend/src/parsing/format.rs` | `LogFormat`: spdlog-style patterns plus `%{name}` custom fields; auto-detection from the first 500 lines, raw-line fallback |
| `backend/src/parsing/line_filter.rs` | `LineFilter`: levels, any text field (domain, thread, ...), keywords |
| `backend/src/logfile/scan.rs` | Parallel filter scan (byte-level `memmem` pre-checks before a line is decoded), cancellable; summary pass; streaming scan for the CLI |
| `backend/src/logfile/view.rs` | `MatchSet` (matches as sorted line ranges) and `View` (matches ± context, built by range merge, no rescan) |
| `backend/src/logfile/levels.rs`, `categories.rs`, `timeline.rs`, `lanes.rs` | Per-session aggregates for the minimap (level / field group per line, time bins) and thread lanes (level counts per lane × 16,384 time slices) |
| `backend/src/log_storage.rs` | Sessions: file, format, cache of recent filter results and lane windows |
| `backend/src/api/` | `/view`, `/view/rows`, `/view/search`, `/lines`, `/minimap`, `/lanes`, `/lanes/at`, `/format/test`, `/version` |
| `frontend/src-tauri/src/lib.rs` | Starts the API, Tauri commands (`open_log_path`, `reformat_log`, `pick_log_file`, `export_view`, `files_exist`, ...) |
| `frontend/src-tauri/src/cli.rs`, `headless.rs`, `bin/` | Command line parsing, headless filtering to stdout or a file, the console companion exe |
| `frontend/src/` | React 18 + Vite + Tailwind/shadcn. `LogViewer` (custom fixed-row viewport), `Minimap`, `ThreadLanes`, `FormatDialog`, `FloatingPanel` (search / go to line) |

## Data flow

1. **Open.** A path arrives (dialog, drop, command line, recent list). The file is
   mapped in place, never copied or modified. Indexing, format detection and the
   summary (line count, levels, field values, time range) run in one go and return a
   session id.
2. **Filter.** Each filter change is one parallel scan producing line ranges. A newer
   query cancels the older scan; recent results are cached per session, so toggling
   back is instant. Context lines are applied at display time.
3. **Render.** The UI knows only the row count and fetches the visible rows (with
   overscan). Rows carry 1-based file line numbers, parsed fields and timestamps.
   The viewport is custom, so row count is not limited by the browser's maximum
   element height.
4. **Overviews.** The minimap and lanes request one value per device pixel; the
   backend folds its per-session aggregates into those buckets. Zoomed lane windows
   re-read only the lines inside the window.
5. **Export / CLI.** Export streams rows from Rust to a file chosen in a native Save
   dialog. The CLI runs the same scan in waves of chunks and writes through the same
   row writer, so its output equals an export of the same view.

## Performance

Measured on a 5 GiB, 52 M-line file (warm page cache):

| Step | Time |
|---|---|
| Line index | 0.29 s |
| Summary | 0.9 s |
| First rows visible after launch | 3.2 s |
| Keyword filter | ~145 ms |
| Level index (first level filter or minimap) | 1.3 s once |
| Thread-lane index | 0.8 s once; zoomed window 4–55 ms |
| CLI: filter ERROR lines to a file | 1.7 s, 30 MB private memory |

Memory stays small because nothing holds per-line strings: the index is ~8 bytes per
1,024 lines, the level aggregate half a byte per line.

## Release

`.github/workflows/rust.yml`: every push and PR type-checks and builds the UI and runs
the tests of both crates on `windows-latest`. A `v*` tag (must equal the version in
`tauri.conf.json`) builds the NSIS and MSI installers, signs the updater artifacts and
`latest.json`, and puts them with the CLI exe on a draft GitHub release.

**In-app update.** `tauri-plugin-updater` (`frontend/src/lib/updater.ts`,
`UpdateDialog.tsx`) reads `releases/latest/download/latest.json`, so only a published
release is offered. The installer's signature is checked against `plugins.updater.pubkey`
in `tauri.conf.json` before it runs; the private key exists only as a CI secret.

## Planned

| Feature | Design notes |
|---|---|
| Annotations (comments, highlights) | Separate store, never written into the log. Anchor to line ranges of a fingerprinted file (size + hashed head/tail/sample blocks), local SQLite in the app data folder. |
| Shared annotations | Optional small sync service (axum + WebSocket); only annotation records travel, never the log. Server-ordered op log with per-record versions and an offline queue; a CRDT only if live co-editing of one comment is needed. |
| Index cache | Persist the line index keyed by fingerprint + size + mtime, so reopening is instant. |
| Tail mode | Map the size known at open, extend periodically for logs still being written. |
| Search options | Case-insensitive and regex keywords (today keywords are case-sensitive substrings of the message, any one of them matches). |
| Compressed input | gzip cannot be memory-mapped; seekable zstd can. |

Open questions: whether teammates share files on a drive or have their own copies, and
where a sync service could be hosted.
