/** A URL plus fetch RequestInit for one attempt, produced fresh by the caller for every retry. */
export interface RequestFactoryResult {
    url: string;
    init?: RequestInit;
}

export interface FetchWithRetryOptions {
    /** HTTP status codes that should be retried. Defaults to [429, 500, 503, 504]. */
    retryableStatuses?: number[];
    /** Maximum number of retries after the initial attempt. Defaults to 3. */
    maxRetries?: number;
    /** Base backoff (ms) for exponential backoff when no Retry-After header is present. Defaults to 1000. */
    baseBackoffMs?: number;
}

const DEFAULT_RETRYABLE_STATUSES = [429, 500, 503, 504];
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generic fetch-with-retry: calls `buildRequest()` to get a fresh URL/RequestInit for every
 * attempt (so callers can re-acquire a bearer token, etc. on each try), and retries on
 * `options.retryableStatuses` with Retry-After awareness and exponential backoff otherwise.
 *
 * Returns the underlying `Response` as soon as it is `ok`, or once retries are exhausted / the
 * status isn't retryable - callers are responsible for interpreting non-ok responses (auth
 * errors, parsing error bodies, etc.), since that is API-specific.
 */
export async function fetchWithRetry(
    buildRequest: () => Promise<RequestFactoryResult> | RequestFactoryResult,
    options: FetchWithRetryOptions = {},
): Promise<Response> {
    const retryableStatuses = options.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { url, init } = await buildRequest();
        const response = await fetch(url, init);

        if (response.ok) {
            return response;
        }

        const isRetryable = retryableStatuses.includes(response.status);
        if (isRetryable && attempt < maxRetries) {
            const retryAfterHeader = response.headers.get('Retry-After');
            const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
            const backoffMs =
                retryAfterMs && !Number.isNaN(retryAfterMs) ? retryAfterMs : baseBackoffMs * 2 ** attempt;
            attempt += 1;
            await sleep(backoffMs);
            continue;
        }

        return response;
    }
}
