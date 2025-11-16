/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { LogSummary } from '../models/LogSummary';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class UploadService {

    /**
     * Upload and parse a log file
     * @returns LogSummary Parsed log summary
     * @throws ApiError
     */
    public static uploadHandler(): CancelablePromise<LogSummary> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/upload',
        });
    }

}
