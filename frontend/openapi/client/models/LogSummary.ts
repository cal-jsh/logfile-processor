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
     * Total number of lines in the log
     */
    total_lines: number;
    /**
     * List of unique domains found in the log
     */
    unique_domains: Array<string>;
};
