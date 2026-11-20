/* The recently opened log files, shown on the start page. Kept in the webview's
   localStorage, so the list survives restarts and is shared by all windows. */
import { invoke } from "@tauri-apps/api/core";

export interface RecentFile {
    path: string;
    /** When it was last opened, ms since epoch */
    openedAt: number;
}

const KEY = "logviewer.recentFiles";
export const MAX_RECENT = 10;

/** Windows paths are case-insensitive, so C:\Logs\a.log and c:\logs\A.LOG are one entry. */
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function loadRecent(): RecentFile[] {
    try {
        const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
        if (!Array.isArray(list)) return [];
        return list
            .filter((r): r is RecentFile => typeof r?.path === "string" && typeof r?.openedAt === "number")
            .slice(0, MAX_RECENT);
    } catch {
        return [];
    }
}

function save(list: RecentFile[]): RecentFile[] {
    try {
        localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
        // storage unavailable: the list just is not kept
    }
    return list;
}

/** Put a file at the top of the list (most recent first, no duplicates, at most 10). */
export function addRecent(path: string): RecentFile[] {
    const rest = loadRecent().filter((r) => !samePath(r.path, path));
    return save([{ path, openedAt: Date.now() }, ...rest].slice(0, MAX_RECENT));
}

export function removeRecent(path: string): RecentFile[] {
    return save(loadRecent().filter((r) => !samePath(r.path, path)));
}

export function clearRecent(): RecentFile[] {
    return save([]);
}

/** Which of the paths are files right now (false for deleted, moved or unreachable ones). */
export function filesExist(paths: string[]): Promise<boolean[]> {
    return invoke<boolean[]>("files_exist", { paths });
}

/** File name and folder of a path, for display. */
export function splitPath(path: string): { name: string; dir: string } {
    const i = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/** "just now", "5 min ago", "3 h ago", "yesterday", or a date. */
export function openedAgo(ms: number, now = Date.now()): string {
    const min = Math.floor((now - ms) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h ago`;
    if (h < 48) return "yesterday";
    return new Date(ms).toLocaleDateString();
}
