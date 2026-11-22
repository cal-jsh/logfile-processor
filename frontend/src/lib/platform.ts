/* Calls into the Tauri desktop shell (frontend/src-tauri). */
import { invoke } from "@tauri-apps/api/core";
import type { LogSummary } from "./logSummary";
import { getFilePattern } from "./recentFiles";

/** Base URL of the HTTP viewport API, which runs in-process on a random localhost port. */
export async function getApiBase(): Promise<string> {
  return invoke<string>("api_base_url");
}

export interface OpenedLog {
  /** Local path of the file, opened in place */
  path: string;
  session_id: string;
  summary: LogSummary;
  index_ms: number;
  summary_ms: number;
  format_ms: number;
}

/** Native file-open dialog; the file is opened in place. Null if cancelled. */
export async function openLogDialog(): Promise<OpenedLog | null> {
  const path = await invoke<string | null>("pick_log_file");
  return path ? openLogPath(path) : null;
}

/** Open a local file by path (dialog, drag and drop, command line, recent list), with the
    line format the user set for it, or else detected. */
export function openLogPath(path: string): Promise<OpenedLog> {
  return invoke<OpenedLog>("open_log_path", { path, pattern: getFilePattern(path) });
}

/** Open the file of a session again with another line format (null: detect it).
    The old session is closed. */
export async function reformatLog(sessionId: string, path: string, pattern: string | null): Promise<OpenedLog> {
  const r = await invoke<Omit<OpenedLog, "path">>("reformat_log", { sessionId, pattern });
  return { ...r, path };
}

/** Export the current view through a native Save dialog.
    Returns the saved path, or null if cancelled. */
export function exportView(args: {
  sessionId: string;
  levels: string | null;
  /** JSON object of field value lists, e.g. {"thread":["12"]} */
  fields: string | null;
  keywords: string | null;
  /** JSON list of regular expressions, e.g. ["code=5\\d\\d"] */
  regex: string | null;
  /** Time range filter, ms in the log's clock (`to` excluded) */
  timeFrom: number | null;
  timeTo: number | null;
  context: number;
  format: "txt" | "csv";
}): Promise<string | null> {
  return invoke<string | null>("export_view", args);
}

/** A file passed on the command line, if any. */
export function initialFile(): Promise<string | null> {
  return invoke<string | null>("initial_file");
}

export interface CliHelp {
  /** The `--help` text of the command line */
  usage: string;
  /** Full path of logfile_processor_cli.exe, if it is next to the viewer */
  cli_path: string | null;
}

/** The command line's help text, for the "Command line" dialog (the same as `--help`). */
export function cliHelp(): Promise<CliHelp> {
  return invoke<CliHelp>("cli_help");
}

/** A time range cut out of the open log into a new file (see `cutTimeRange`). */
export interface CutResult {
  /** Full path of the new file, next to the log */
  path: string;
  /** Its file name */
  name: string;
  line_count: number;
  byte_count: number;
  /** 1-based lines of the log that were copied */
  first_line: number;
  last_line: number;
  millis: number;
}

/** Copy the lines of a time range (ms, log clock, `to` excluded) of the open log, as they
    are, to a new file next to it, named after the log and the range. Never overwrites. */
export function cutTimeRange(sessionId: string, timeFrom: number, timeTo: number): Promise<CutResult> {
  return invoke<CutResult>("cut_time_range", { sessionId, timeFrom, timeTo });
}

/** Show a file selected in Explorer. */
export function revealPath(path: string): Promise<void> {
  return invoke<void>("reveal_path", { path });
}
