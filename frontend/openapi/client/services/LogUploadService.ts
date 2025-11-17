/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { UploadFileBody } from '../models/UploadFileBody';
import type { UploadResponse } from '../models/UploadResponse';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class LogUploadService {

    /**
     * Upload and parse a log file
     * @param requestBody Log file to upload. Only the first file in the multipart request is processed. Maximum size: 1 GB
     * @returns UploadResponse Upload successful, returns session ID and log summary
     * @throws ApiError
     */
    public static uploadHandler(
requestBody: UploadFileBody,
): CancelablePromise<UploadResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/upload',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `No file uploaded or invalid multipart request`,
                500: `Internal server error while creating directories, writing, or reading the file`,
            },
        });
    }

}
