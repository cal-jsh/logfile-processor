/* Bookmarks: lines of a log marked to come back to, each with an optional short note.

   Kept per file in the webview's localStorage (like the recent list and the line format
   set for a file), keyed by path, with the file's size and modification time when they
   were last saved. When the file has changed since (it grew, or was rewritten), each
   bookmark is checked against its line: the start of the line's text is kept with it, so
   a log that only grew keeps its bookmarks and one rewritten in place flags the bookmarks
   whose line is now different ("stale") instead of pointing at the wrong line.

   The shape is meant to be extended by a sync service for annotations later (plan steps
   5 and 6): every bookmark has an id and created/updated times, and a file is identified
   by its stamp and the text of the marked lines, never by the log's content as a whole.

   They can be exported to and imported from a small text file (see `formatExport`). */
import { invoke } from "@tauri-apps/api/core";
import { formatFull } from "../components/Minimap";

export interface Bookmark {
  /** Stable id, for edits and a later sync */
  id: string;
  /** 1-based line in the file */
  line: number;
  /** Time of the line, ms since 1970 in the log's own clock; null without a timestamp */
  t: number | null;
  /** The line's level as written in it, if the format has one */
  level: string | null;
  /** The line's other text fields (thread, domain, ...), by field name */
  fields: Record<string, string>;
  /** Start of the line's text (at most TEXT_KEEP characters): shown in the panel, and
      compared with the line when the file has changed */
  text: string;
  /** Short note, "" for none */
  note: string;
  /** ms since 1970 (UTC) */
  created: number;
  updated: number;
  /** The line at `line` is not the one marked any more (the file was rewritten) */
  stale?: boolean;
}

/** Size and modification time of a file, from Rust */
export interface FileStamp {
  size: number;
  modified_ms: number | null;
}

/** The bookmarks of one file, as stored */
export interface FileBookmarks {
  path: string;
  size: number;
  modified: number | null;
  /** When this entry was last written, ms since 1970 */
  updated: number;
  bookmarks: Bookmark[];
}

type Store = { version: 1; files: FileBookmarks[] };

const KEY = "logviewer.bookmarks";
/** Files with bookmarks kept; the least recently changed are dropped beyond this */
const MAX_FILES = 200;
/** Characters of the line kept with a bookmark */
export const TEXT_KEEP = 400;
/** Characters compared to tell whether a line is still the one marked */
const TEXT_COMPARE = 200;

/** Windows paths are case-insensitive (as in the recent list) */
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function loadStore(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (s && s.version === 1 && Array.isArray(s.files)) return s as Store;
  } catch {
    // unreadable: start empty
  }
  return { version: 1, files: [] };
}

const validBookmark = (b: any): b is Bookmark =>
  b && typeof b.id === "string" && Number.isInteger(b.line) && b.line >= 1 && typeof b.text === "string";

/** The stored bookmarks of a file, or null if it has none */
export function loadFileBookmarks(path: string): FileBookmarks | null {
  const e = loadStore().files.find((f) => typeof f?.path === "string" && samePath(f.path, path));
  if (!e || !Array.isArray(e.bookmarks)) return null;
  return {
    ...e,
    bookmarks: e.bookmarks.filter(validBookmark).map((b) => ({
      ...b,
      note: typeof b.note === "string" ? b.note : "",
      fields: b.fields && typeof b.fields === "object" ? b.fields : {},
    })),
  };
}

/** Store the bookmarks of a file (an empty list forgets the file) */
export function saveFileBookmarks(path: string, stamp: FileStamp | null, bookmarks: Bookmark[]) {
  const store = loadStore();
  const rest = store.files.filter((f) => !samePath(f.path, path));
  const files = bookmarks.length
    ? [{ path, size: stamp?.size ?? 0, modified: stamp?.modified_ms ?? null, updated: Date.now(), bookmarks }, ...rest]
    : rest;
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, files: files.slice(0, MAX_FILES) }));
  } catch {
    // storage unavailable (or full): the bookmarks last for this session only
  }
}

/** Size and modification time of a file right now */
export function fileStamp(path: string): Promise<FileStamp> {
  return invoke<FileStamp>("file_stamp", { path });
}

export const sameStamp = (e: FileBookmarks, s: FileStamp) => e.size === s.size && e.modified === s.modified_ms;

/** Whether the line's text now is the one a bookmark was set on */
export function sameLine(kept: string, now: string): boolean {
  const n = Math.min(TEXT_COMPARE, kept.length);
  return now.slice(0, n) === kept.slice(0, n) && (kept.length > n || now.length >= kept.length);
}

export const newId = (): string =>
  typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Bookmarks in file order */
export const byLine = (a: Bookmark, b: Bookmark) => a.line - b.line;

/* ---------------- Export file ----------------

   # Logfile Processor bookmarks, format 1
   # File: realistic_5G.log
   # Size: 5368709120 bytes, modified 2026-11-20 10:11:12 UTC
   # Exported: 2026-11-22 15:04 UTC
   #
   # One bookmark per block: "line <number> | <log time> | <note>", then the line itself
   # after "> ". Only the line number is needed to import; lines starting with # are notes.

   line 48213 | 2026-11-18 14:05:30.123 | Pool exhausted here, retries start
   > [2026-11-18 14:05:30.123] [ERROR] [db.pool] [worker-3] Connection pool exhausted

   The note is one line; its " | " separators and line breaks are kept as they are, since
   everything after the second " | " is the note. A bookmark without a time has "-". */

export const EXPORT_HEADER = "# Logfile Processor bookmarks, format 1";

const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

export function formatExport(fileName: string, stamp: FileStamp | null, bookmarks: Bookmark[], now = Date.now()): string {
  const out = [EXPORT_HEADER, `# File: ${fileName}`];
  if (stamp) out.push(`# Size: ${stamp.size} bytes${stamp.modified_ms != null ? `, modified ${utc(stamp.modified_ms)}` : ""}`);
  out.push(
    `# Exported: ${utc(now)}`,
    "#",
    '# One bookmark per block: "line <number> | <log time> | <note>", then the line itself',
    '# after "> ". Only the line number is needed to import; lines starting with # are notes.',
    ""
  );
  for (const b of [...bookmarks].sort(byLine)) {
    const note = b.note.replace(/\s*[\r\n]+\s*/g, " ").trim();
    out.push(`line ${b.line} | ${b.t != null ? formatFull(b.t) : "-"}${note ? ` | ${note}` : ""}`);
    if (b.text) out.push(`> ${b.text.replace(/[\r\n]+/g, " ")}`);
    out.push("");
  }
  return out.join("\n");
}

/** A bookmark read from an export file: the line, and what it said about it */
export interface ImportedBookmark {
  line: number;
  note: string;
  /** The line as exported, if it was there (to check it against this file) */
  text: string | null;
}

export interface ParsedExport {
  /** The "# File:" name it was exported from, if given */
  fileName: string | null;
  bookmarks: ImportedBookmark[];
  /** Lines that were neither comments nor bookmarks, 1-based, for the message */
  skipped: number[];
}

/** Read an export file. Throws if it has no bookmarks and does not look like one. */
export function parseExport(text: string): ParsedExport {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let fileName: string | null = null;
  const bookmarks: ImportedBookmark[] = [];
  const skipped: number[] = [];
  lines.forEach((raw, i) => {
    const s = raw.trimEnd();
    if (!s.trim()) return;
    if (s.startsWith("#")) {
      const m = /^#\s*File:\s*(.+)$/i.exec(s);
      if (m && fileName == null) fileName = m[1].trim();
      return;
    }
    if (s.startsWith(">")) {
      const last = bookmarks[bookmarks.length - 1];
      if (last && last.text == null) last.text = s.replace(/^> ?/, "");
      return;
    }
    const m = /^\s*line\s+(\d+)\s*(?:\|(.*))?$/i.exec(s);
    const line = m ? Number(m[1]) : NaN;
    if (!m || !Number.isSafeInteger(line) || line < 1) {
      skipped.push(i + 1);
      return;
    }
    // " | time | note": the time is for people, the note is everything after it
    const rest = m[2] ?? "";
    const bar = rest.indexOf("|");
    const note = bar >= 0 ? rest.slice(bar + 1).trim() : "";
    bookmarks.push({ line, note, text: null });
  });
  if (!bookmarks.length && !text.includes(EXPORT_HEADER)) throw new Error("This is not a bookmarks file: no \"line <number>\" entries in it.");
  return { fileName, bookmarks, skipped };
}

/** Default name of an export: next to the log, "<log name>.bookmarks.txt" */
export function exportFileName(logPath: string): { dir: string | null; name: string } {
  const i = Math.max(logPath.lastIndexOf("\\"), logPath.lastIndexOf("/"));
  const base = i < 0 ? logPath : logPath.slice(i + 1);
  const stem = base.replace(/\.[^.]*$/, "") || base;
  return { dir: i < 0 ? null : logPath.slice(0, i), name: `${stem}.bookmarks.txt` };
}

/** Save an export through a native Save dialog; the path written, or null if cancelled */
export function saveTextFile(title: string, dir: string | null, fileName: string, contents: string): Promise<string | null> {
  return invoke<string | null>("save_text_file", { title, dir, fileName, contents });
}

/** Pick and read a text file through a native Open dialog; null if cancelled */
export function openTextFile(title: string, dir: string | null): Promise<{ path: string; contents: string } | null> {
  return invoke<{ path: string; contents: string } | null>("open_text_file", { title, dir });
}
