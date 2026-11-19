# Logfile Processor: Desktop Architecture Plan

_Status: proposal, no code changed. Written 2026-11-19 from a read of the code in `C:\Projects\rust\logfile-processor`._

## TL;DR

- **Use Tauri 2.** Your backend is already Rust and your UI is already React + Vite, so Tauri keeps both and drops the HTTP server, the upload step and the browser's limits. Electron would add ~150 MB and a Node layer for no gain; egui/iced would be the fastest UI but means rewriting the whole frontend.
- **The big change isn't the shell, it's the data flow.** Today the server *pushes every matching line* to the browser over SSE and the browser keeps them in an array. That cannot work at tens of GB. The desktop app must flip to a **pull/viewport model**: Rust owns the file (memory-mapped) plus a line index, and the UI only ever asks for "rows N..N+60 of the current view".
- **Annotations (comments, highlights) live in a separate store, never in the log.** Anchor them to line ranges of a fingerprinted file.
- **Multi-user means a server, and that's fine.** Recommended shape: a desktop app that works fully offline, plus an *optional* small annotation-sync service (your existing axum backend is a good starting point). The multi-GB log never travels; only small annotation records do.
- **Several current bugs** (dropped lines with context, wrong line numbers, 100k-line cap) are listed in section 5. They are worth fixing even if you never ship the desktop app.

---

## 1. What exists today

| Part | What it does | Files |
|---|---|---|
| Backend | axum 0.8 server on `0.0.0.0:8080`, CORS open to any origin, Swagger UI | `backend/src/main.rs` |
| Upload | Multipart upload (1 GB limit) copied to `./uploads/<uuid>.log`, then **`read_to_string` of the whole file** to compute a summary | `backend/src/api/upload.rs` |
| Summary | One regex (`LOG_REGEX`) per line, collects level counts, domains, first/last timestamp | `backend/src/parsing/parser.rs` |
| Filter/stream | `GET /stream_logs` reads the file line by line (`FramedRead` + `LinesCodec`), applies level/domain/keyword filters and ±context, sends **one SSE event (JSON) per line** | `backend/src/api/stream_filtered_logs.rs` |
| `/filter` | Takes the **whole log text in the JSON body**. Unused by the UI | `backend/src/api/filter.rs` |
| Sessions | Global `Mutex<HashMap<session_id, path>>`; file deleted on `close_session` (sent via `sendBeacon` on unload) | `backend/src/log_storage.rs` |
| Frontend | React 18 + Vite + Tailwind/shadcn. Upload page then Dashboard with filters, `LogViewer` using `react-virtuoso`, client-side search over loaded lines, CSV/TXT export | `frontend/src/**` |
| Build | `build.py` builds release exe + frontend `dist` into `deploy/` | `build.py` |

The good news: the parsing/filter logic is small and already in Rust, so it moves into a desktop core with little loss.

---

## 2. Desktop shell options

| Option | Reuse of current code | Bundle size | Perf ceiling | Effort | Verdict |
|---|---|---|---|---|---|
| **Tauri 2** (Rust core + system WebView, WebView2 on Windows) | Keeps React UI and Rust logic; HTTP replaced by IPC commands/channels | ~5-15 MB | High, as long as the UI only renders the viewport | Medium | **Recommended** |
| Electron | Keeps React; Rust would run as a sidecar process (basically today's server on localhost) or a native Node addon | ~150+ MB | Same webview limits plus an extra process hop | Low to start, worse long-term | Not recommended |
| egui (eframe) | Rust logic kept; **UI fully rewritten** | ~5 MB | Highest: immediate-mode rendering of huge virtual lists is trivial | High | Good fallback if the webview ever becomes the bottleneck |
| iced / Slint | Same as egui, more "app-like" widgets | small | High | High | Same trade-off as egui |

**Why Tauri:** one language for all heavy work, the UI you already have, tiny installer, first-class Windows support, and IPC "channels" for streaming search progress. The things a webview is bad at (millions of DOM rows, huge JS arrays) are avoided by design in section 4, not by the shell choice.

**A quick stepping stone (optional):** Tauri can launch your current axum server in-process on `127.0.0.1:<random port>` and point the webview at it. That gives you a desktop app in a day, but it keeps the upload-copy and SSE design, so treat it only as a demo.

### Target layout (Cargo workspace)

```
logfile-processor/
  crates/
    logcore/        # file open, mmap, line index, parsing, search/filter engine (no UI, no HTTP)
    annotations/    # annotation model, SQLite store, sync protocol types
  apps/
    desktop/        # Tauri app: src-tauri (commands) + the existing React frontend
    server/         # optional axum service: annotation sync (+ today's web mode if you want to keep it)
```

`logcore` is used by both the desktop app and the server, so the web version can survive if you want it.

---

## 3. Long-term features

### 3.1 Keyword filtering with context lines

Model the result of a filter as **a list of line numbers (or merged line ranges)**, not as a stream of strings.

1. Search produces sorted match line numbers (`Vec<u64>`, or a compressed bitmap such as `roaring` for very dense results).
2. Context ±N is applied as a cheap range merge: `[m-N, m+N]` for each match, overlapping ranges merged. Each row knows if it is a match or context.
3. The UI shows "view row i" → backend maps it to a file line through the range list and returns the text.
4. Changing N does **not** re-scan the file; only the range merge is recomputed.

Use multi-pattern search: `aho-corasick` for plain keywords (with optional case-insensitivity), `regex` only when the user asks for a regex. For level/domain filters, the bracketed prefix can be matched on bytes without capturing groups. The `grep-searcher`/`grep-regex` crates (from ripgrep) are an alternative if you want ripgrep-grade search out of the box.

Return match spans with each row so the UI can highlight hits without its own regex.

### 3.2 Comments and highlighting

Treat the log file as **immutable**. Everything the user adds goes into an annotation store:

```
annotation
  id            uuid
  file_id       fingerprint of the log (see below)
  start_line    u64      end_line u64
  start_offset  u64      # byte offset, for fast seek and sanity checks
  anchor_hash   u64      # hash of the first anchored line, to re-check the anchor
  kind          highlight | comment
  color         nullable
  body          text (comments; markdown ok)
  thread_id     nullable (replies)
  author, created_at, updated_at, version, deleted
```

- **File fingerprint:** size + hash of the first/last few MB + a few sampled blocks. Two users with copies of the same log get the same `file_id`, which is what makes sharing work without sending the file. If the file grows (appended logs), existing anchors stay valid; the fingerprint should use the head and record the size at annotation time.
- **Local storage:** SQLite (`rusqlite`) in the app data folder, keyed by `file_id`. Optional "export annotations" to a JSON sidecar file.
- **UI:** gutter markers for comments, row background for highlights, a side panel listing all annotations (click to jump), and a minimap strip showing where matches and annotations are.

### 3.3 Multi-user editing (the server question)

There is a real tension here. "Desktop app" suggests everything local; "several people on the same file at the same time" needs a meeting point. The options:

| Option | How | Problem |
|---|---|---|
| Shared SQLite / JSON on a network drive | Everyone opens the same sidecar on SMB | SQLite over SMB corrupts under concurrent writers; no live updates. **Avoid.** |
| Peer-to-peer (e.g. iroh + Automerge) | Clients sync directly | NAT/firewall pain, discovery, hard to debug. Overkill now. |
| **Optional sync service** | Desktop clients connect to a small server over WebSocket; server stores annotations and broadcasts changes | Needs one hosted process. **Recommended.** |

**Recommended design:**

- The desktop app is complete on its own (local annotations, works offline).
- A "Share / Connect to workspace" action links a file's annotations to a sync server. The server only stores annotation records keyed by `file_id`; it never needs the log itself.
- Concurrency model: annotations are mostly independent records, so you don't need a CRDT for everything. Use a server-ordered operation log (`create/update/delete` with a per-annotation `version`), optimistic concurrency (reject stale updates, client merges), and broadcast to subscribers of that `file_id`. Clients queue operations while offline and replay them.
- Only if you want Google-Docs-style **simultaneous typing in the same comment** do you need a CRDT for that text field; `yrs` (the Rust port of Yjs) fits that narrowly.
- Presence ("Anna is looking at line 1,203,442") is a cheap addition on the same socket.
- Auth: start with a shared workspace token; add proper accounts later if this leaves your team.
- The existing axum backend (routing, tracing, OpenAPI) is a natural home for this service.

**Assumption to confirm:** I read "multi user edits of the same file" as shared *annotations* (comments, highlights) on an unchanged log. If you mean editing the log text itself, that is a different design (piece-table editing plus a CRDT over the text) and much harder at tens of GB. I'd strongly advise against it for logs.

**How users get the log:** each user opens their own copy (or the same network path). The fingerprint matches them up. A later extension could be a server-side "remote file" mode for logs that live on a server, using the same `logcore` engine over the network for viewport fetches only.

---

## 4. Performance for files of tens of GB

Rough sizes for a 50 GB file with ~100-byte lines: **~500 million lines**. Everything below follows from that number.

### 4.1 Opening: memory map, don't read

- Open the file **in place by path** (desktop: no upload, no copy). Today a 50 GB upload means 50 GB copied plus 50 GB read into a `String`, which fails outright on most machines.
- Map it with `memmap2`. The OS page cache does the work; Rust code sees `&[u8]`.
- Work on **bytes**, not `String`. Decode to UTF-8 (lossy) only for the ~60 rows on screen. Today `LinesCodec`/`read_to_string` fail or blank out lines on invalid UTF-8.
- Caveats: if another process truncates the file while it is mapped, Linux delivers SIGBUS (Windows forbids the truncate instead). For "live" logs that are still being written, map the size known at open and periodically extend (tail mode). Keep a `pread`-based fallback for network drives where mmap is unreliable.

### 4.2 Line index

- A full index (one `u64` offset per line) costs 8 bytes/line, i.e. ~4 GB for 500 M lines. Too much to hold casually.
- Use a **sparse index**: store the offset of every 1,024th (or 4,096th) line. 500 M lines → ~500 K entries → ~4 MB. To reach line N, jump to checkpoint N/1024 and scan forward with `memchr` (a few KB, microseconds).
- **Build in parallel**: split the file into chunks (e.g. 64 MB), count newlines per chunk with `memchr` across `rayon` threads, then prefix-sum. From page cache this runs at memory bandwidth; cold, it is bounded by the disk (NVMe ~3-7 GB/s, SATA SSD ~0.5 GB/s, HDD/network much less). Estimate, not measured: roughly 10-20 s cold for 50 GB on a fast NVMe.
- **Show content immediately**: the first screen needs only the first chunk. Index the rest in the background with a progress bar; scrolling to the unindexed part estimates the line from the byte position until indexing reaches it.
- Compute the summary (levels, domains, time range) **in the same pass**, so the file is read once.
- **Cache** the index on disk (app cache dir) keyed by `file_id` + size + mtime; reopening the same file is then instant.

### 4.3 Search and filter

- Parallel chunked search over the mmap with `rayon`; each chunk returns match offsets, mapped to line numbers via the index; chunks are merged in order.
- Plain keywords with `memchr::memmem`/`aho-corasick` (SIMD, GB/s); regex only on request. Avoid running the full capture regex on every line just to filter.
- **Incremental and cancellable**: stream progress ("12,345 matches, 38%") and the first pages of results through a Tauri `Channel` while the scan continues. Every new query gets a cancellation token; changing a filter aborts the old scan immediately (today each change opens a new SSE stream and the old file scan only stops when the connection closes).
- **Narrowing**: if the new query is a refinement (an extra keyword ANDed, a level removed), search within the previous result set instead of the whole file.
- **Cache** recent query results (LRU keyed by normalized query). Toggling back to a previous filter becomes instant.
- Results are just line numbers. Export (TXT/CSV) streams from Rust straight to a file chosen with a save dialog, never through the UI.

### 4.4 Rendering

- The UI holds **no line arrays**. It knows `row_count` and asks `get_rows(view_id, first_row, count)` for what is visible plus a small overscan, returning text plus pre-computed spans (level, domain, keyword hits, annotations).
- Browsers cap element height (~33 M px in Chromium-based WebView2). At 20 px per row that's ~1.6 M rows, so `react-virtuoso` (or any DOM-height-based virtual list) **cannot** scroll 500 M lines. Use a **custom viewport**: fixed row height, a fixed pool of row elements (or a `<canvas>`), and your own scrollbar that maps thumb position → row number.
- Cap rendered line length (e.g. first 4 KB, "show more" on demand); a single 1 MB line otherwise freezes the DOM.
- Time delta between rows: compute in Rust per fetched page (it needs the previous line, which the backend has), not inside the render function.
- A minimap/heatmap (match and annotation density per bucket) is computed by the backend as a small histogram.

### 4.5 Rough targets

| Action | Target |
|---|---|
| Open any size file, first screen visible | < 1 s |
| Full index + summary, 50 GB | disk-bound; progress shown; instant on reopen (cached) |
| Jump to any line / scroll | < 16 ms per frame |
| New keyword filter, first results | < 200 ms; full scan at disk/memory speed in the background |
| Change context lines | instant (no re-scan) |

---

## 5. Bottlenecks and bugs in the current code

Bottlenecks (all block the tens-of-GB goal):

1. **`upload.rs`: whole-file upload copy plus `tokio::fs::read_to_string`** of the entire log into RAM for the summary, with a 1 GB request limit. Fails above the limit and on invalid UTF-8.
2. **`parser.rs`: full capture regex per line** plus several `String` allocations per line (`level.to_string()` just to call `contains`), single-threaded.
3. **`stream_filtered_logs.rs`: per-line async overhead.** Each line goes through `LinesCodec` (allocates a `String`), up to three `tokio::Mutex` lock/awaits, six `Arc`/`Vec` clones in the closure, `serde_json` serialization and an SSE frame. Every filter change re-scans the whole file from the start.
4. **Frontend parses every event again:** `JSON.parse`, three regexes in `normalizeIncoming`, another in `extractMessage` at render time.
5. **`LogViewer.tsx`: `[...linesRef.current, ...bufferRef.current].slice(-maxLines)` every 50 ms** copies the whole array on each flush (quadratic over a long stream).
6. **Client-side search** scans only the lines already in the browser, in JS.
7. **`filter.rs`** expects the entire log text in the JSON request body (unused, but unusable at scale; can be removed).

Correctness bugs (worth fixing regardless):

8. **Lines are silently dropped when context > 0.** In `stream_filtered_logs.rs`, when `out_queue` has pending events, the closure returns the queued event and **discards the current input line**. After a match with N previous context lines, the next N lines from the file are consumed without being checked as matches or emitted as forward context.
9. **Line numbers shown are not file line numbers.** The backend never sends `idx`, so `LogViewer` numbers results 1, 2, 3… in arrival order. Comments and highlights need real line numbers, so this must change.
10. **Results are silently truncated** to the last 100,000 lines (`maxLines={100000}` + `slice(-maxLines)`), with no indication in the UI.
11. **Lines that don't match `LOG_REGEX`** (stack traces, wrapped messages) are always filtered out and not counted, so `total_lines` in the summary is "parsed lines", not the file's line count, and multi-line entries lose their continuation lines.
12. **Keyword filter is case-sensitive and only checks the message part**, not the whole line.
13. **Time delta is wrong under virtualization:** `prevTs` is a variable in the render function, so the delta is relative to the previously *rendered* row, not the previous log line.
14. **No end-of-results signal:** after the file ends, the stream switches to heartbeats forever, so the UI can't show "done" and the spinner logic can't tell an empty result from a slow one.
15. **Security (web mode only):** binds `0.0.0.0` with CORS `Any`, so anyone on the network can upload files and read others' sessions by ID. Uploaded files are only deleted if the unload beacon arrives (one is still sitting in `backend/uploads/`). Moot for the desktop app, relevant if you keep the server.

---

## 6. Suggested roadmap

| Phase | Scope | Outcome |
|---|---|---|
| 0 | Cargo workspace; move parsing/filter into `logcore`; fix bugs 8-13 | Same app, correct results, testable core |
| 1 | Tauri 2 shell with open-by-path dialog, mmap, sparse line index + summary in one parallel pass, `get_rows` viewport API, custom virtual viewer | Desktop app that opens any size file instantly and scrolls smoothly |
| 2 | Search engine: aho-corasick/regex, parallel, cancellable, streaming progress, context as range merge, result cache, export to file | Fast filtering on tens of GB |
| 3 | Local annotations: SQLite store, highlights, comments, annotation panel, minimap | Single-user feature-complete |
| 4 | Sync service (axum + WebSocket): op log, versions, offline queue, presence, workspace token | Multi-user annotations |
| 5 | Polish: on-disk index cache, tail/follow mode for growing logs, multiple tabs, configurable log formats (your `logs_2025-11-25.csv` hints at other formats), compressed input (gzip can't be mmapped; seekable zstd can) | Production quality |

Phase 1 is the riskiest and most valuable; I'd prototype the index + viewport on one of your large sample files first and measure before building the rest.

## 7. Open questions

1. Does "multi-user edits" mean shared comments/highlights (assumed), or editing the log text?
2. Do teammates have their own copy of each log, or open it from a shared drive or server?
3. Is there somewhere to host a small sync service (internal server, VM, container)?
4. Only this one log format (`[ts] [LEVEL] [domain] message`), or should formats be configurable?
5. Do you need to keep the browser version, or can desktop replace it?
6. Are the logs static once you open them, or still being written (needs tail mode)?
