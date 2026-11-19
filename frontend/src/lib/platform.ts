/* Web app vs. Tauri desktop app.
   The UI is the same; only the API location and how a file is opened differ. */
import { invoke } from "@tauri-apps/api/core";
import type { LogSummary } from "../../openapi/client/models/LogSummary";

/** True inside the Tauri desktop app. */
export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Web: the standalone backend (override with VITE_API_URL). */
const WEB_API_BASE: string =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ??
  "http://localhost:8080";

/** Base URL of the HTTP API. In the desktop app it runs in-process on a random port. */
export async function getApiBase(): Promise<string> {
  return isDesktop ? invoke<string>("api_base_url") : WEB_API_BASE;
}

export interface OpenedLog {
  /** Local path (desktop only) */
  path?: string;
  session_id: string;
  summary: LogSummary;
  index_ms: number;
  summary_ms: number;
}

/** Desktop: native file-open dialog; the file is opened in place. Null if cancelled. */
export function openLogDialog(): Promise<OpenedLog | null> {
  return invoke<OpenedLog | null>("open_log_dialog");
}

/** Desktop: open a local file by path (drag and drop, command line). */
export function openLogPath(path: string): Promise<OpenedLog> {
  return invoke<OpenedLog>("open_log_path", { path });
}

/** Desktop: export the current view through a native Save dialog.
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

/** Desktop: a file passed on the command line, if any. */
export function initialFile(): Promise<string | null> {
  return invoke<string | null>("initial_file");
}
