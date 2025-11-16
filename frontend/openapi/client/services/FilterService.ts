/* generated using openapi-typescript-codegen -- do no edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { FilteredLogResponse } from '../models/FilteredLogResponse';
import type { FilterRequest } from '../models/FilterRequest';

import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';

export class FilterService {

    /**
     * Filter log lines and produce a summary
     * @param requestBody 
     * @returns FilteredLogResponse Filtered log lines with summary
     * @throws ApiError
     */
    public static filterHandler(
requestBody: FilterRequest,
): CancelablePromise<FilteredLogResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/filter',
            body: requestBody,
            mediaType: 'application/json',
        });
    }

}
