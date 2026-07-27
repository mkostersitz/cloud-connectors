import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Thrown by a connector's auth layer whenever there is no usable signed-in session. Connectors
 * should throw this from their token-acquisition code path; `wrapHandler` (below) recognizes it
 * and turns it into a friendly, non-crashing tool result instead of a raw stack trace.
 */
export class AuthRequiredError extends Error {
    constructor(message = 'Not signed in.') {
        super(message);
        this.name = 'AuthRequiredError';
    }
}

/** Builds a successful, plain-text CallToolResult. */
export function ok(text: string): CallToolResult {
    return { content: [{ type: 'text', text }] };
}

/**
 * Builds a failed CallToolResult carrying `text` verbatim - no automatic "Error:" prefix is
 * added, so callers that want one should include it in `text` themselves.
 */
export function errorResult(text: string): CallToolResult {
    return { content: [{ type: 'text', text }], isError: true };
}

export interface WrapHandlerOptions<Args extends unknown[]> {
    /** Message used when the handler throws AuthRequiredError. Defaults to the thrown error's own message. */
    authMessage?: string;
    /**
     * Called (with the thrown error and the original handler arguments) for any non-
     * AuthRequiredError exception, before falling back to the default `Error: <message>`
     * formatting. Return a CallToolResult to use it as-is, or undefined to fall through to the
     * default formatting.
     */
    mapError?: (err: unknown, ...args: Args) => CallToolResult | undefined;
}

/**
 * Wraps an async MCP tool handler so thrown errors become `isError` CallToolResults instead of
 * crashing the server or bubbling up an unhandled rejection: AuthRequiredError is mapped to a
 * friendly sign-in message, everything else is offered to `options.mapError` (if provided) and
 * otherwise rendered as `Error: <message>`.
 */
export function wrapHandler<Args extends unknown[]>(
    handler: (...args: Args) => Promise<CallToolResult>,
    options: WrapHandlerOptions<Args> = {},
): (...args: Args) => Promise<CallToolResult> {
    return async (...args: Args): Promise<CallToolResult> => {
        try {
            return await handler(...args);
        } catch (err) {
            if (err instanceof AuthRequiredError) {
                return errorResult(options.authMessage ?? err.message);
            }
            const mapped = options.mapError?.(err, ...args);
            if (mapped) {
                return mapped;
            }
            const message = err instanceof Error ? err.message : String(err);
            return errorResult(`Error: ${message}`);
        }
    };
}
