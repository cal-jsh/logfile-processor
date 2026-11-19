/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

export type LogSummary = {
    /**
     * Count of log entries per level, e.g., {"INFO": 123, "WARN": 5}
     */
    levels: Record<string, number>;
    /**
     * Timestamp of the first log entry
     */
    start_timestamp?: string | null;
    /**
     * Timestamp of the last log entry
     */
    stop_timestamp?: string | null;
    /**
     * Number of lines in the `[ts] [LEVEL] [domain] message` format
     */
    total_lines: number;
    /**
     * Number of lines in the file, including lines not in the log format
     */
    line_count: number;
    /**
     * List of unique domains found in the log
     */
    unique_domains: Array<string>;
};
