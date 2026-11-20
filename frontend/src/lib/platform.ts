/* Calls into the Tauri desktop shell (frontend/src-tauri). */
import { invoke } from "@tauri-apps/api/core";
import type { LogSummary } from "./logSummary";

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
}

/** Native file-open dialog; the file is opened in place. Null if cancelled. */
export function openLogDialog(): Promise<OpenedLog | null> {
  return invoke<OpenedLog | null>("open_log_dialog");
}

/** Open a local file by path (drag and drop, command line). */
export function openLogPath(path: string): Promise<OpenedLog> {
  return invoke<OpenedLog>("open_log_path", { path });
}

/** Export the current view through a native Save dialog.
    Returns the saved path, or null if cancelled. */
export function exportView(args: {
  sessionId: string;
  levels: string | null;
  domains: string | null;
  keywords: string | null;
  context: number;
  format: "txt" | "csv";
}): Promise<string | null> {
  return invoke<string | null>("export_view", args);
}

/** A file passed on the command line, if any. */
export function initialFile(): Promise<string | null> {
  return invoke<string | null>("initial_file");
}
