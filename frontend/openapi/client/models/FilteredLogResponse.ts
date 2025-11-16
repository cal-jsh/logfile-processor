/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { LogSummary } from './LogSummary';

/**
 * Response after filtering logs
 */
export type FilteredLogResponse = {
    /**
     * Lines of the log that match the filter
     */
    filtered_lines: Array<string>;
    /**
     * Summary of the filtered log
     */
    summary: LogSummary;
};
