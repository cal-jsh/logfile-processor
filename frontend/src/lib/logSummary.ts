/* Summary of an opened log file, as returned by the Tauri commands that open one.
   Hand-maintained: keep in sync with backend/src/model/log_summary.rs and
   backend/src/parsing/format.rs (FieldDef). */

export type FieldKind = "time" | "level" | "message" | "text";

/** A field of the line format, e.g. the thread */
export type FieldDef = {
    /** Stable id, e.g. "thread"; used in filters and settings */
    name: string;
    /** Shown in the UI, e.g. "Thread" */
    label: string;
    kind: FieldKind;
    /** Offered as a filter (a list of values) */
    filterable: boolean;
};

/** The distinct values of a filterable field */
export type FieldValues = {
    name: string;
    label: string;
    /** Sorted, at most 1000 */
    values: string[];
    /** There are more values than listed */
    more: boolean;
};

/** The line format of the open file */
export type FormatInfo = {
    /** spdlog-style pattern, e.g. "[%Y-%m-%d %H:%M:%S.%e] [%t] [%l] %v" */
    pattern: string;
    /** Chosen automatically (false: set by the user) */
    detected: boolean;
    /** No known format fits: every line is shown as it is */
    raw: boolean;
    /** Non-empty lines at the start of the file used to detect or check the format */
    sample_lines: number;
    /** Of those, the lines in the format */
    sample_matched: number;
    /** The fields of the format, in line order */
    columns: FieldDef[];
};

export type LogSummary = {
    /** Count of log entries per level, e.g., {"INFO": 123, "WARN": 5} */
    levels: Record<string, number>;
    /** Timestamp of the first log entry */
    start_timestamp?: string | null;
    /** Timestamp of the last log entry */
    stop_timestamp?: string | null;
    /** The same two as ms since 1970 in the log's own clock, if they can be read */
    start_ms?: number | null;
    stop_ms?: number | null;
    /** Number of lines in the log format */
    total_lines: number;
    /** Number of lines in the file, including lines not in the log format */
    line_count: number;
    /** The filterable fields (domain, thread, ...) with their values */
    fields: FieldValues[];
    format: FormatInfo;
};
