import { AuthRequiredError, fetchWithRetry } from '@cloud-connectors/core';
import { getToken } from './auth.js';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

export interface GraphFetchInit extends RequestInit {
    /**
     * When true, the raw fetch Response is returned instead of a JSON-parsed body.
     * Used by callers that need to stream/download binary content.
     */
    rawResponse?: boolean;
}

function isFullUrl(path: string): boolean {
    return /^https?:\/\//i.test(path);
}

function resolveUrl(path: string): string {
    return isFullUrl(path) ? path : `${GRAPH_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function hasBody(init?: RequestInit): boolean {
    return init?.body !== undefined && init.body !== null;
}

/**
 * Makes an authenticated call to Microsoft Graph. The retry/backoff loop (throttling 429,
 * transient 500/503/504, Retry-After awareness, exponential backoff) is delegated to
 * `fetchWithRetry` from @cloud-connectors/core; this function supplies the Graph-specific
 * pieces: base URL resolution, bearer-token injection (re-acquired fresh on every attempt via
 * `getToken()`), 401 -> AuthRequiredError, and Graph JSON error-body parsing.
 *
 * 500 is included alongside the usual 503/504 because live testing hit a transient
 * `generalException: Error Calling Substrate Search` (500) from OneDrive search that
 * succeeded immediately on retry.
 *
 * Returns the parsed JSON body, `null` for 204 No Content, or the raw Response when
 * `rawResponse: true` is passed (needed for binary content downloads).
 */
export async function graphFetch(path: string, init: GraphFetchInit = {}): Promise<any> {
    const { rawResponse, headers, ...rest } = init;
    const url = resolveUrl(path);

    const response = await fetchWithRetry(async () => {
        const token = await getToken();

        const finalHeaders = new Headers(headers);
        finalHeaders.set('Authorization', `Bearer ${token}`);
        if (hasBody(rest) && !finalHeaders.has('Content-Type')) {
            finalHeaders.set('Content-Type', 'application/json');
        }

        return { url, init: { ...rest, headers: finalHeaders } };
    });

    if (response.ok) {
        if (rawResponse) {
            return response;
        }
        if (response.status === 204) {
            return null;
        }
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }

    if (response.status === 401) {
        throw new AuthRequiredError('Your Microsoft session has expired. Run the ms_login tool to sign in again.');
    }

    let code: string | undefined;
    let message: string | undefined;
    try {
        const errorBody = await response.json();
        code = errorBody?.error?.code;
        message = errorBody?.error?.message;
    } catch {
        // Response body wasn't JSON (or was empty) - fall through with just the status.
    }

    const detail = [code, message].filter(Boolean).join(': ');
    throw new Error(`Graph request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`);
}
