/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

/**
 * Request payload for filtering logs
 */
export type FilterRequest = {
    /**
     * Optional list of domains to filter by
     */
    domains?: any[] | null;
    /**
     * Optional list of log levels to filter by
     */
    levels?: any[] | null;
    /**
     * Full log text
     */
    log_text: string;
};
