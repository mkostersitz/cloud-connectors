import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import {
    ok,
    errorResult,
    wrapHandler,
    formatBytes,
    sanitizeFilename,
    isTextLikeFile,
    defaultDownloadDir,
} from '@cloud-connectors/core';
import { graphFetch } from '../graph.js';

const AUTH_MESSAGE = 'Not signed in. Run ms_login first.';

const MAX_READ_BYTES = 100 * 1024 * 1024; // 100 MB hard refusal ceiling for onedrive_read_file
const MAX_INLINE_TEXT_BYTES = 1 * 1024 * 1024; // 1 MB inline-text ceiling
const INLINE_TEXT_DISPLAY_LIMIT = 50_000; // truncate inline text display at ~50k chars
const SIMPLE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024; // 4 MB simple PUT ceiling
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024; // 250 MB overall upload ceiling
const UPLOAD_CHUNK_BYTES = 10 * 1024 * 1024; // 10 MiB, a multiple of 320 KiB as required by the Graph upload session API

const LISTING_SELECT = 'id,name,size,folder,file,lastModifiedDateTime,parentReference';
const METADATA_SELECT =
    'id,name,size,folder,file,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy,webUrl,parentReference';

// ---------------------------------------------------------------------------
// Item addressing helpers
// ---------------------------------------------------------------------------

interface ItemRef {
    /** The Graph path segment identifying the item itself (no trailing suffix). */
    base: string;
    /** Whether `base` uses the `root:/path` colon-addressing form (vs. root / items/{id}). */
    isColon: boolean;
}

/** URL-encodes each path segment individually, preserving '/' separators. */
function encodePath(p: string): string {
    const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!trimmed) return '';
    return trimmed
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

/**
 * Resolves a `path` (or `item_id`) input pair into a Graph item reference.
 * - item_id -> /me/drive/items/{id}
 * - path === '/' or omitted -> /me/drive/root
 * - other path -> /me/drive/root:/encoded/segments (colon-addressing)
 */
function itemRef(p?: string, itemId?: string): ItemRef {
    if (itemId && itemId.trim()) {
        return { base: `/me/drive/items/${encodeURIComponent(itemId.trim())}`, isColon: false };
    }
    const normalized = p && p.trim() ? p.trim() : '/';
    if (normalized === '/') {
        return { base: '/me/drive/root', isColon: false };
    }
    return { base: `/me/drive/root:/${encodePath(normalized)}`, isColon: true };
}

/** Appends a child-resource suffix (e.g. '/children', '/content') respecting colon-addressing. */
function withSuffix(ref: ItemRef, suffix: string): string {
    return ref.isColon ? `${ref.base}:${suffix}` : `${ref.base}${suffix}`;
}

/** Builds a `/me/drive/root:/folder/name:suffix` path for creating/overwriting an item by path. */
function buildRootItemPath(folderPath: string, name: string, suffix: string): string {
    const encodedFolder = encodePath(folderPath && folderPath.trim() ? folderPath : '/');
    const encodedName = encodeURIComponent(name);
    const combined = encodedFolder ? `${encodedFolder}/${encodedName}` : encodedName;
    return `/me/drive/root:/${combined}:${suffix}`;
}

function describeRef(p?: string, itemId?: string): string {
    return p ?? itemId ?? '/';
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatListItem(item: any): string {
    const isFolder = Boolean(item.folder);
    const marker = isFolder ? '[folder]' : '[file]  ';
    const size = formatBytes(item.size);
    const modified = item.lastModifiedDateTime ?? 'unknown';
    return `${marker} ${item.name}  |  ${size}  |  modified ${modified}  |  id: ${item.id}`;
}

function formatListing(result: any): string {
    const items = Array.isArray(result?.value) ? result.value : [];
    if (items.length === 0) return 'No items found.';
    const lines = items.map(formatListItem);
    const nextLink = result?.['@odata.nextLink'];
    if (nextLink) {
        lines.push('');
        lines.push('More results are available. Call onedrive_list again with next_link set to:');
        lines.push(nextLink);
    }
    return lines.join('\n');
}

function formatMetadata(item: any): string {
    const lines: string[] = [];
    lines.push(`Name: ${item.name}`);
    lines.push(`Id: ${item.id}`);
    lines.push(`Type: ${item.folder ? 'folder' : 'file'}`);
    lines.push(`Size: ${formatBytes(item.size)}`);
    lines.push(`Created: ${item.createdDateTime ?? 'unknown'}`);
    lines.push(`Last modified: ${item.lastModifiedDateTime ?? 'unknown'}`);
    if (item.createdBy?.user?.displayName) lines.push(`Created by: ${item.createdBy.user.displayName}`);
    if (item.lastModifiedBy?.user?.displayName) lines.push(`Last modified by: ${item.lastModifiedBy.user.displayName}`);
    if (item.webUrl) lines.push(`Web URL: ${item.webUrl}`);
    if (item.parentReference?.path) lines.push(`Parent path: ${item.parentReference.path}`);
    if (item.folder) {
        lines.push(`Child count: ${item.folder.childCount ?? 0}`);
    } else if (item.file) {
        lines.push(`MIME type: ${item.file.mimeType ?? 'unknown'}`);
        if (item.file.hashes) {
            const hashParts = Object.entries(item.file.hashes as Record<string, string>).map(
                ([key, value]) => `${key}=${value}`,
            );
            if (hashParts.length > 0) lines.push(`Hashes: ${hashParts.join(', ')}`);
        }
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Error mapping (item-not-found detection, keyed by the ref the caller passed in)
// ---------------------------------------------------------------------------

/** Maps a Graph 404/itemNotFound error to a friendly "No item at path" message; otherwise falls through to the default `Error: <message>` formatting. */
function notFoundMapper(ref: string) {
    return (err: unknown): CallToolResult | undefined => {
        const message = err instanceof Error ? err.message : String(err);
        if (/\(404/.test(message) || /itemNotFound/i.test(message)) {
            return errorResult(`No item at path ${ref}`);
        }
        return undefined;
    };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerOneDriveTools(server: McpServer): void {
    server.registerTool(
        'onedrive_list',
        {
            title: 'List OneDrive folder contents',
            description:
                "Lists the children of a OneDrive folder (files and subfolders). Provide 'path' " +
                "(default '/' for the drive root) or an 'item_id'. Results are paged 50 at a time; " +
                "if more results exist, pass the returned next_link back in as 'next_link' to continue.",
            inputSchema: {
                path: z.string().optional(),
                item_id: z.string().optional(),
                next_link: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async ({ path: p, item_id, next_link }): Promise<CallToolResult> => {
                if (next_link) {
                    const result = await graphFetch(next_link);
                    return ok(formatListing(result));
                }
                const target = itemRef(p, item_id);
                const childrenPath = withSuffix(target, '/children');
                const result = await graphFetch(`${childrenPath}?$select=${LISTING_SELECT}&$top=50`);
                return ok(formatListing(result));
            },
            {
                authMessage: AUTH_MESSAGE,
                mapError: (err, args) => notFoundMapper(describeRef(args.path, args.item_id))(err),
            },
        ),
    );

    server.registerTool(
        'onedrive_search',
        {
            title: 'Search OneDrive',
            description:
                "Searches OneDrive for items matching 'query'. Optionally restrict the search to a " +
                "folder via 'scope_path'; otherwise searches the whole drive.",
            inputSchema: {
                query: z.string(),
                scope_path: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async ({ query, scope_path }): Promise<CallToolResult> => {
                const escaped = query.replace(/'/g, "''");
                const encodedQuery = encodeURIComponent(escaped);
                const scopeRef = itemRef(scope_path);
                const searchPath = withSuffix(scopeRef, `/search(q='${encodedQuery}')`);
                const result = await graphFetch(`${searchPath}?$select=${LISTING_SELECT}&$top=50`);
                return ok(formatListing(result));
            },
            {
                authMessage: AUTH_MESSAGE,
                mapError: (err, args) => notFoundMapper(args.scope_path ?? '/')(err),
            },
        ),
    );

    server.registerTool(
        'onedrive_get_metadata',
        {
            title: 'Get OneDrive item metadata',
            description:
                "Fetches full metadata for a OneDrive item (file or folder): size, timestamps, " +
                "created/modified by, web URL, and folder child count or file MIME type and hashes. " +
                "Provide 'path' or 'item_id'.",
            inputSchema: {
                path: z.string().optional(),
                item_id: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async ({ path: p, item_id }): Promise<CallToolResult> => {
                if (!p && !item_id) {
                    return errorResult('Provide either path or item_id.');
                }
                const target = itemRef(p, item_id);
                const item = await graphFetch(`${target.base}?$select=${METADATA_SELECT}`);
                return ok(formatMetadata(item));
            },
            {
                authMessage: AUTH_MESSAGE,
                mapError: (err, args) => notFoundMapper(describeRef(args.path, args.item_id))(err),
            },
        ),
    );

    server.registerTool(
        'onedrive_read_file',
        {
            title: 'Read a OneDrive file',
            description:
                "Reads a OneDrive file's content. Provide 'path' or 'item_id'. Small text-like files " +
                "(<=1 MB) are returned inline (truncated at ~50,000 characters). Other files are saved " +
                "to 'save_dir' (default the user's Downloads folder) and the saved path is returned. " +
                'Files over 100 MB are refused.',
            inputSchema: {
                path: z.string().optional(),
                item_id: z.string().optional(),
                save_dir: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async ({ path: p, item_id, save_dir }): Promise<CallToolResult> => {
                const ref = describeRef(p, item_id);
                if (!p && !item_id) {
                    return errorResult('Provide either path or item_id.');
                }
                const target = itemRef(p, item_id);
                const meta = await graphFetch(`${target.base}?$select=id,name,size,file,folder`);

                if (meta.folder) {
                    return errorResult(`"${ref}" is a folder, not a file. Use onedrive_list to view its contents.`);
                }

                const size: number | undefined = meta.size;
                if (typeof size === 'number' && size > MAX_READ_BYTES) {
                    return errorResult(
                        `"${meta.name}" is ${formatBytes(size)}, which exceeds the 100 MB limit for onedrive_read_file.`,
                    );
                }

                const mimeType: string | undefined = meta.file?.mimeType;
                const contentPath = withSuffix(target, '/content');

                if (isTextLikeFile(mimeType, meta.name) && typeof size === 'number' && size <= MAX_INLINE_TEXT_BYTES) {
                    const response = await graphFetch(contentPath, { rawResponse: true });
                    const text: string = await response.text();
                    if (text.length > INLINE_TEXT_DISPLAY_LIMIT) {
                        const truncated = text.slice(0, INLINE_TEXT_DISPLAY_LIMIT);
                        return ok(
                            `${truncated}\n\n[... truncated, showing ${INLINE_TEXT_DISPLAY_LIMIT} of ${text.length} characters ...]`,
                        );
                    }
                    return ok(text);
                }

                const dir = save_dir && save_dir.trim() ? save_dir.trim() : defaultDownloadDir();
                await mkdir(dir, { recursive: true });
                const filename = sanitizeFilename(meta.name, 'download');
                const filePath = path.join(dir, filename);

                const response = await graphFetch(contentPath, { rawResponse: true });
                if (!response.body) {
                    return errorResult(`"${meta.name}" returned no content body.`);
                }
                const nodeStream = Readable.fromWeb(response.body as any);
                await pipeline(nodeStream, createWriteStream(filePath));

                const savedStat = await stat(filePath);
                return ok(`Saved "${meta.name}" (${formatBytes(savedStat.size)}) to ${filePath}`);
            },
            {
                authMessage: AUTH_MESSAGE,
                mapError: (err, args) => notFoundMapper(describeRef(args.path, args.item_id))(err),
            },
        ),
    );

    server.registerTool(
        'onedrive_upload_file',
        {
            title: 'Upload a file to OneDrive',
            description:
                "Uploads a local file to OneDrive. 'local_path' is the file on disk; 'destination_path' " +
                "is the destination OneDrive folder (default '/'); 'rename' optionally gives it a new " +
                'name. Files up to 4 MB use a simple upload; larger files (up to 250 MB) use a chunked ' +
                'upload session. Existing files at the destination are overwritten.',
            inputSchema: {
                local_path: z.string(),
                destination_path: z.string().optional(),
                rename: z.string().optional(),
            },
        },
        wrapHandler(
            async ({ local_path, destination_path, rename }): Promise<CallToolResult> => {
                const folder = destination_path && destination_path.trim() ? destination_path.trim() : '/';

                const stats = await stat(local_path);
                if (!stats.isFile()) {
                    return errorResult(`"${local_path}" is not a file.`);
                }
                if (stats.size > MAX_UPLOAD_BYTES) {
                    return errorResult(`"${local_path}" is ${formatBytes(stats.size)}, which exceeds the 250 MB upload limit.`);
                }

                const filename = rename && rename.trim() ? rename.trim() : path.basename(local_path);
                const fileBuffer = await readFile(local_path);

                let item: any;
                if (fileBuffer.length <= SIMPLE_UPLOAD_MAX_BYTES) {
                    const contentPath = buildRootItemPath(folder, filename, '/content');
                    item = await graphFetch(contentPath, {
                        method: 'PUT',
                        body: fileBuffer,
                        headers: { 'Content-Type': 'application/octet-stream' },
                    });
                } else {
                    const sessionPath = buildRootItemPath(folder, filename, '/createUploadSession');
                    const session = await graphFetch(sessionPath, {
                        method: 'POST',
                        body: JSON.stringify({
                            item: { '@microsoft.graph.conflictBehavior': 'replace', name: filename },
                        }),
                    });
                    const uploadUrl: string = session.uploadUrl;
                    const total = fileBuffer.length;
                    let start = 0;
                    let lastItem: any;
                    while (start < total) {
                        const end = Math.min(start + UPLOAD_CHUNK_BYTES, total);
                        const chunk = fileBuffer.subarray(start, end);
                        // Chunk PUTs go straight to the pre-authorized uploadUrl via plain fetch -
                        // it is not a Graph v1.0 path and needs no Authorization header.
                        const res = await fetch(uploadUrl, {
                            method: 'PUT',
                            headers: {
                                'Content-Length': String(chunk.length),
                                'Content-Range': `bytes ${start}-${end - 1}/${total}`,
                            },
                            body: chunk,
                        });
                        if (!res.ok) {
                            const body = await res.text().catch(() => '');
                            throw new Error(`Upload chunk failed (${res.status} ${res.statusText})${body ? `: ${body}` : ''}`);
                        }
                        if (res.status === 200 || res.status === 201) {
                            lastItem = await res.json();
                        }
                        start = end;
                    }
                    item = lastItem;
                }

                return ok(
                    `Uploaded "${item?.name ?? filename}" (${formatBytes(item?.size ?? fileBuffer.length)}), id: ${item?.id ?? 'unknown'}`,
                );
            },
            {
                authMessage: AUTH_MESSAGE,
                mapError: (err, args) => notFoundMapper(args.local_path)(err),
            },
        ),
    );

    server.registerTool(
        'onedrive_create_folder',
        {
            title: 'Create a OneDrive folder',
            description:
                "Creates a new folder named 'name' under 'parent_path' (default '/'). Fails if a folder " +
                'or file with that name already exists there.',
            inputSchema: {
                parent_path: z.string().optional(),
                name: z.string(),
            },
        },
        wrapHandler(
            async ({ parent_path, name }): Promise<CallToolResult> => {
                const ref = parent_path ?? '/';
                const parentRef = itemRef(parent_path);
                const childrenPath = withSuffix(parentRef, '/children');
                const item = await graphFetch(childrenPath, {
                    method: 'POST',
                    body: JSON.stringify({
                        name,
                        folder: {},
                        '@microsoft.graph.conflictBehavior': 'fail',
                    }),
                });
                return ok(`Created folder "${item.name}" (id: ${item.id}) under ${ref}`);
            },
            {
                authMessage: AUTH_MESSAGE,
                mapError: (err, args) => notFoundMapper(args.parent_path ?? '/')(err),
            },
        ),
    );

    server.registerTool(
        'onedrive_move',
        {
            title: 'Move or rename a OneDrive item',
            description:
                "Moves and/or renames a OneDrive item. Provide 'path' or 'item_id' for the item, and " +
                "'new_parent_path' to move it and/or 'new_name' to rename it. Providing only 'new_name' " +
                'renames the item in place without moving it.',
            inputSchema: {
                path: z.string().optional(),
                item_id: z.string().optional(),
                new_parent_path: z.string().optional(),
                new_name: z.string().optional(),
            },
        },
        wrapHandler(
            async ({ path: p, item_id, new_parent_path, new_name }): Promise<CallToolResult> => {
                if (!p && !item_id) {
                    return errorResult('Provide either path or item_id for the item to move.');
                }
                if (!new_parent_path && !new_name) {
                    return errorResult('Provide new_parent_path and/or new_name.');
                }
                const target = itemRef(p, item_id);
                const patchBody: Record<string, unknown> = {};

                if (new_parent_path) {
                    const destRef = itemRef(new_parent_path);
                    const destMeta = await graphFetch(`${destRef.base}?$select=id`);
                    patchBody.parentReference = { id: destMeta.id };
                }
                if (new_name) {
                    patchBody.name = new_name;
                }

                const item = await graphFetch(target.base, {
                    method: 'PATCH',
                    body: JSON.stringify(patchBody),
                });
                return ok(`Moved/renamed to "${item.name}" (id: ${item.id})`);
            },
            {
                authMessage: AUTH_MESSAGE,
                mapError: (err, args) => notFoundMapper(describeRef(args.path, args.item_id))(err),
            },
        ),
    );

    server.registerTool(
        'onedrive_delete',
        {
            title: 'Delete a OneDrive item',
            description:
                "Deletes a OneDrive item (file or folder) given 'path' or 'item_id'. This should be " +
                'confirmed with the user before calling. Deletion moves the item to the OneDrive recycle ' +
                'bin, not permanent removal - it can be restored from the recycle bin afterward.',
            inputSchema: {
                path: z.string().optional(),
                item_id: z.string().optional(),
            },
            annotations: { destructiveHint: true },
        },
        wrapHandler(
            async ({ path: p, item_id }): Promise<CallToolResult> => {
                const ref = describeRef(p, item_id);
                if (!p && !item_id) {
                    return errorResult('Provide either path or item_id.');
                }
                const target = itemRef(p, item_id);
                await graphFetch(target.base, { method: 'DELETE' });
                return ok(
                    `Deleted "${ref}". It has been moved to the OneDrive recycle bin and can be restored from there if needed.`,
                );
            },
            {
                authMessage: AUTH_MESSAGE,
                mapError: (err, args) => notFoundMapper(describeRef(args.path, args.item_id))(err),
            },
        ),
    );
}
