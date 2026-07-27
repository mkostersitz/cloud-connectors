import path from 'node:path';
import { realpath, stat, lstat, readdir, readFile, writeFile, copyFile, mkdir, rename } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import trash from 'trash';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
    ok,
    errorResult,
    wrapHandler,
    formatBytes,
    sanitizeFilename,
    isTextLikeFile,
    defaultDownloadDir,
} from '@cloud-connectors/core';
import { driveRoot } from '../config.js';

// ---------------------------------------------------------------------------
// Path confinement - the core security invariant for this module.
//
// Every user-supplied path is drive-relative ('/Documents/notes.txt', root '/').
// resolveDrivePath() is the ONE resolver used by every tool below: it joins the
// input against driveRoot(), normalizes it, verifies the result stays inside the
// root (textually), then re-verifies after dereferencing symlinks on whatever
// portion of the path already exists on disk - so a symlinked ancestor can't be
// used to walk out of the Drive folder either.
// ---------------------------------------------------------------------------

const ESCAPE_MESSAGE = 'Path escapes the iCloud Drive folder';

export class PathEscapeError extends Error {
    constructor() {
        super(ESCAPE_MESSAGE);
        this.name = 'PathEscapeError';
    }
}

/** Strips any leading run of slashes/backslashes - drive-relative paths are root-relative, not filesystem-absolute. */
function stripLeadingSeparators(input: string): string {
    return input.replace(/^[\\/]+/, '');
}

/** Case-insensitive (on win32) containment check: candidate === root, or candidate is root + sep + anything. */
function isWithinRoot(candidate: string, root: string): boolean {
    const c = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    const r = process.platform === 'win32' ? root.toLowerCase() : root;
    if (c === r) return true;
    const rootWithSep = r.endsWith(path.sep) ? r : r + path.sep;
    return c.startsWith(rootWithSep);
}

/**
 * Resolves symlinks on the nearest existing ancestor of `target` (walking up until something on
 * disk is found - at worst, that is `root` itself, which driveRoot() already guarantees exists),
 * and rebuilds the full path from that real ancestor plus the still-nonexistent tail segments.
 */
async function realpathNearestAncestor(target: string): Promise<string> {
    const tail: string[] = [];
    let probe = target;
    for (;;) {
        try {
            const real = await realpath(probe);
            return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
        } catch (err) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
            const parent = path.dirname(probe);
            if (parent === probe) {
                // Reached the filesystem root without finding anything - shouldn't happen since
                // driveRoot() guarantees the root itself exists, but fail safe rather than loop.
                return target;
            }
            tail.push(path.basename(probe));
            probe = parent;
        }
    }
}

/**
 * Resolves a drive-relative path to an absolute filesystem path confined to the iCloud Drive
 * root. Throws PathEscapeError on any attempt to escape (via '..' segments, a bare absolute
 * path, or a symlinked ancestor pointing outside the root). Exported for direct unit testing.
 */
export async function resolveDrivePath(relativePath: string | undefined | null): Promise<string> {
    const root = path.resolve(driveRoot());
    const stripped = stripLeadingSeparators((relativePath ?? '/').trim() || '/');

    // A remainder that is still absolute after stripping the root-relative leading slash(es) -
    // e.g. a bare drive letter like 'C:\evil' - is an explicit attempt to name a filesystem
    // location outside the Drive root; reject it outright rather than let path.join silently
    // fold it into a (harmless but confusing) literal subpath.
    if (path.isAbsolute(stripped)) {
        throw new PathEscapeError();
    }

    const joined = path.join(root, stripped);
    const candidate = path.resolve(joined);

    if (!isWithinRoot(candidate, root)) {
        throw new PathEscapeError();
    }

    const realRoot = await realpath(root).catch(() => root);
    const realCandidate = await realpathNearestAncestor(candidate);

    if (!isWithinRoot(realCandidate, realRoot)) {
        throw new PathEscapeError();
    }

    return realCandidate;
}

// ---------------------------------------------------------------------------
// Small filesystem / formatting helpers
// ---------------------------------------------------------------------------

const MAX_LIST_ENTRIES = 200;
const SEARCH_DEPTH_CAP = 12;
const SEARCH_VISITED_CAP = 20_000;
const SEARCH_RESULTS_CAP = 100;
const MAX_READ_BYTES = 100 * 1024 * 1024; // 100 MB hard refusal ceiling for icloud_drive_read_file
const MAX_INLINE_TEXT_BYTES = 1 * 1024 * 1024; // 1 MB inline-text ceiling
const INLINE_TEXT_DISPLAY_LIMIT = 50_000; // truncate inline text display at ~50k chars
const MAX_LOCAL_COPY_BYTES = 250 * 1024 * 1024; // 250 MB ceiling for local_source_path copies

async function pathExists(p: string): Promise<boolean> {
    try {
        await stat(p);
        return true;
    } catch {
        return false;
    }
}

/** Converts an absolute filesystem path (must be inside root) to a drive-relative, forward-slash display path. */
function toDrivePath(root: string, absPath: string): string {
    const rel = path.relative(root, absPath);
    if (!rel || rel === '') return '/';
    return '/' + rel.split(path.sep).join('/');
}

/** Joins a drive-relative parent path with a child name into a new drive-relative path string. */
function joinDrivePath(parentDrivePath: string, name: string): string {
    const trimmedParent = parentDrivePath.replace(/[\\/]+$/, '');
    return `${trimmedParent}/${name}`;
}

function shouldSkip(name: string): boolean {
    if (name.toLowerCase() === 'node_modules') return true;
    if (/^\.trash/i.test(name)) return true; // .Trash, .Trashes, .Trash-1000, etc.
    return false;
}

/** One listing line: [folder]/[file], name, size (folders: entry count), modified ISO timestamp, drive-relative path. */
function formatEntry(name: string, drivePath: string, st: Stats, childCount?: number): string {
    const isDir = st.isDirectory();
    const marker = isDir ? '[folder]' : '[file]  ';
    const sizePart = isDir
        ? `${childCount ?? 0} item${childCount === 1 ? '' : 's'}`
        : formatBytes(st.size);
    const modified = st.mtime.toISOString();
    return `${marker} ${name}  |  ${sizePart}  |  modified ${modified}  |  ${drivePath}`;
}

async function directoryChildCount(absDirPath: string): Promise<number | undefined> {
    try {
        const names = await readdir(absDirPath);
        return names.length;
    } catch {
        return undefined;
    }
}

/** Wraps an error from an actual file read/copy with a hint about iCloud Files On Demand. */
function hydrationHint(ref: string, err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return (
        `Error reading "${ref}": ${message}. If this file uses iCloud Files On Demand it may be a ` +
        'placeholder that needs to download before it can be read - make sure the iCloud client is ' +
        'installed, running, and signed in, then try again (a large file may also just need time to finish downloading).'
    );
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function driveErrorMapper(ref: string) {
    return (err: unknown): CallToolResult | undefined => {
        if (err instanceof PathEscapeError) {
            return errorResult(err.message);
        }
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return errorResult(`No item found at path "${ref}".`);
        }
        return undefined;
    };
}

// ---------------------------------------------------------------------------
// Recursive search walk
// ---------------------------------------------------------------------------

interface SearchState {
    visited: number;
    results: string[];
    hitVisitedCap: boolean;
    hitResultsCap: boolean;
    hitDepthCap: boolean;
}

async function walkSearch(root: string, dirAbs: string, queryLower: string, depth: number, state: SearchState): Promise<void> {
    if (state.hitVisitedCap || state.hitResultsCap) return;
    if (depth > SEARCH_DEPTH_CAP) {
        state.hitDepthCap = true;
        return;
    }

    let names: string[];
    try {
        names = await readdir(dirAbs);
    } catch {
        return;
    }

    for (const name of names) {
        if (state.hitVisitedCap || state.hitResultsCap) return;
        if (shouldSkip(name)) continue;

        state.visited += 1;
        if (state.visited > SEARCH_VISITED_CAP) {
            state.hitVisitedCap = true;
            return;
        }

        const full = path.join(dirAbs, name);
        let lst: Stats;
        try {
            lst = await lstat(full);
        } catch {
            continue;
        }

        const isSymlink = lst.isSymbolicLink();
        const drivePath = toDrivePath(root, full);

        if (name.toLowerCase().includes(queryLower)) {
            const childCount = lst.isDirectory() ? await directoryChildCount(full) : undefined;
            state.results.push(formatEntry(name, drivePath, lst, childCount));
            if (state.results.length >= SEARCH_RESULTS_CAP) {
                state.hitResultsCap = true;
                return;
            }
        }

        if (lst.isDirectory() && !isSymlink) {
            await walkSearch(root, full, queryLower, depth + 1, state);
            if (state.hitVisitedCap || state.hitResultsCap) return;
        }
    }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerDriveTools(server: McpServer): void {
    server.registerTool(
        'icloud_drive_list',
        {
            title: 'List iCloud Drive folder contents',
            description:
                "Lists the direct children of an iCloud Drive folder (files and subfolders). 'path' is " +
                "drive-relative (default '/' for the Drive root). Non-recursive; capped at 200 entries.",
            inputSchema: {
                path: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async ({ path: p }): Promise<CallToolResult> => {
                const ref = p ?? '/';
                const root = path.resolve(driveRoot());
                const target = await resolveDrivePath(ref);

                const st = await stat(target);
                if (!st.isDirectory()) {
                    return errorResult(`"${ref}" is not a folder.`);
                }

                const names = (await readdir(target)).sort((a, b) => a.localeCompare(b));
                const shown = names.slice(0, MAX_LIST_ENTRIES);
                const lines: string[] = [];

                for (const name of shown) {
                    const full = path.join(target, name);
                    let entryStat: Stats;
                    try {
                        entryStat = await stat(full);
                    } catch {
                        lines.push(`[?]      ${name}  |  unavailable (cannot stat)`);
                        continue;
                    }
                    const drivePath = toDrivePath(root, full);
                    const childCount = entryStat.isDirectory() ? await directoryChildCount(full) : undefined;
                    lines.push(formatEntry(name, drivePath, entryStat, childCount));
                }

                if (names.length > shown.length) {
                    lines.push(`... and ${names.length - shown.length} more`);
                }

                return ok(lines.length > 0 ? lines.join('\n') : '(empty folder)');
            },
            { mapError: (err, args) => driveErrorMapper(args.path ?? '/')(err) },
        ),
    );

    server.registerTool(
        'icloud_drive_search',
        {
            title: 'Search iCloud Drive',
            description:
                "Recursively searches an iCloud Drive folder for items whose name contains 'query' " +
                "(case-insensitive). 'scope_path' restricts the search to a subfolder (default '/', the " +
                'whole Drive). Depth is capped at 12, the scan visits at most ~20,000 entries, and results ' +
                "are capped at 100 - caps are reported in the output when hit. Skips '.Trash'-like folders and node_modules.",
            inputSchema: {
                query: z.string(),
                scope_path: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async ({ query, scope_path }): Promise<CallToolResult> => {
                const ref = scope_path ?? '/';
                const root = path.resolve(driveRoot());
                const target = await resolveDrivePath(ref);

                const st = await stat(target);
                if (!st.isDirectory()) {
                    return errorResult(`"${ref}" is not a folder.`);
                }

                const state: SearchState = {
                    visited: 0,
                    results: [],
                    hitVisitedCap: false,
                    hitResultsCap: false,
                    hitDepthCap: false,
                };
                await walkSearch(root, target, query.toLowerCase(), 1, state);

                const lines = state.results.length > 0 ? [...state.results] : ['No matches found.'];
                if (state.hitResultsCap) lines.push(`(results capped at ${SEARCH_RESULTS_CAP}; more may exist)`);
                if (state.hitVisitedCap) lines.push(`(scan capped at ${SEARCH_VISITED_CAP} entries visited; results may be incomplete)`);
                if (state.hitDepthCap) lines.push(`(depth capped at ${SEARCH_DEPTH_CAP}; deeper folders were not scanned)`);

                return ok(lines.join('\n'));
            },
            { mapError: (err, args) => driveErrorMapper(args.scope_path ?? '/')(err) },
        ),
    );

    server.registerTool(
        'icloud_drive_get_metadata',
        {
            title: 'Get iCloud Drive item metadata',
            description:
                "Fetches full metadata for an iCloud Drive item (file or folder) at 'path': type, size, " +
                'created/modified timestamps, and (for folders) the direct child count.',
            inputSchema: {
                path: z.string(),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async ({ path: p }): Promise<CallToolResult> => {
                const root = path.resolve(driveRoot());
                const target = await resolveDrivePath(p);
                const st = await stat(target);
                const drivePath = toDrivePath(root, target);

                const lines = [
                    `Path: ${drivePath}`,
                    `Type: ${st.isDirectory() ? 'folder' : 'file'}`,
                    `Size: ${st.isDirectory() ? 'n/a' : formatBytes(st.size)}`,
                    `Created: ${st.birthtime.toISOString()}`,
                    `Modified: ${st.mtime.toISOString()}`,
                ];
                if (st.isDirectory()) {
                    const childCount = await directoryChildCount(target);
                    lines.push(`Child count: ${childCount ?? 'unknown'}`);
                }

                return ok(lines.join('\n'));
            },
            { mapError: (err, args) => driveErrorMapper(args.path)(err) },
        ),
    );

    server.registerTool(
        'icloud_drive_read_file',
        {
            title: 'Read an iCloud Drive file',
            description:
                "Reads an iCloud Drive file's content at 'path'. Small text-like files (<=1 MB) are " +
                "returned inline (truncated at ~50,000 characters). Other files are saved to 'save_dir' " +
                "(default the user's Downloads folder) and the saved path is returned. Files over 100 MB " +
                'are refused. Note: iCloud Drive files may be un-hydrated placeholders (Files On Demand) - ' +
                'a read may block while the iCloud client downloads the file, or fail if the client is not running.',
            inputSchema: {
                path: z.string(),
                save_dir: z.string().optional(),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async ({ path: p, save_dir }): Promise<CallToolResult> => {
                const target = await resolveDrivePath(p);
                const st = await stat(target);

                if (st.isDirectory()) {
                    return errorResult(`"${p}" is a folder, not a file. Use icloud_drive_list to view its contents.`);
                }
                if (st.size > MAX_READ_BYTES) {
                    return errorResult(`"${p}" is ${formatBytes(st.size)}, which exceeds the 100 MB limit for icloud_drive_read_file.`);
                }

                const name = path.basename(target);

                if (isTextLikeFile(undefined, name) && st.size <= MAX_INLINE_TEXT_BYTES) {
                    let text: string;
                    try {
                        text = await readFile(target, 'utf8');
                    } catch (err) {
                        return errorResult(hydrationHint(p, err));
                    }
                    if (text.length > INLINE_TEXT_DISPLAY_LIMIT) {
                        const truncated = text.slice(0, INLINE_TEXT_DISPLAY_LIMIT);
                        return ok(`${truncated}\n\n[... truncated, showing ${INLINE_TEXT_DISPLAY_LIMIT} of ${text.length} characters ...]`);
                    }
                    return ok(text);
                }

                const dir = save_dir && save_dir.trim() ? save_dir.trim() : defaultDownloadDir();
                await mkdir(dir, { recursive: true });
                const destName = sanitizeFilename(name, 'download');
                const destPath = path.join(dir, destName);

                try {
                    await copyFile(target, destPath);
                } catch (err) {
                    return errorResult(hydrationHint(p, err));
                }

                const savedStat = await stat(destPath);
                return ok(`Saved "${name}" (${formatBytes(savedStat.size)}) to ${destPath}`);
            },
            { mapError: (err, args) => driveErrorMapper(args.path)(err) },
        ),
    );

    server.registerTool(
        'icloud_drive_write_file',
        {
            title: 'Write a file to iCloud Drive',
            description:
                'Writes a file into iCloud Drive at destination_path (drive-relative, must include the ' +
                'filename). Provide exactly one source: text_content (a string, written as UTF-8) or ' +
                'local_source_path (an absolute path to an existing local file, copied in - up to 250 MB). ' +
                'Refuses to overwrite an existing item unless overwrite is true. Parent folders are created as needed.',
            inputSchema: {
                text_content: z.string().optional(),
                local_source_path: z.string().optional(),
                destination_path: z.string(),
                overwrite: z.boolean().optional(),
            },
        },
        wrapHandler(
            async ({ text_content, local_source_path, destination_path, overwrite }): Promise<CallToolResult> => {
                const hasText = typeof text_content === 'string';
                const hasLocal = typeof local_source_path === 'string' && local_source_path.trim().length > 0;
                if (hasText === hasLocal) {
                    return errorResult('Provide exactly one of text_content or local_source_path.');
                }

                const target = await resolveDrivePath(destination_path);
                const existing = await stat(target).catch(() => undefined);
                if (existing) {
                    if (!overwrite) {
                        return errorResult(`"${destination_path}" already exists. Pass overwrite: true to replace it.`);
                    }
                    if (existing.isDirectory()) {
                        return errorResult(`"${destination_path}" is an existing folder; refusing to overwrite it with a file.`);
                    }
                }

                await mkdir(path.dirname(target), { recursive: true });

                if (hasText) {
                    await writeFile(target, text_content as string, 'utf8');
                    const written = await stat(target);
                    return ok(`Wrote ${formatBytes(written.size)} to "${destination_path}".`);
                }

                const srcPath = (local_source_path as string).trim();
                let srcStat: Stats;
                try {
                    srcStat = await stat(srcPath);
                } catch {
                    return errorResult(`Local source file not found: "${srcPath}".`);
                }
                if (!srcStat.isFile()) {
                    return errorResult(`"${srcPath}" is not a file.`);
                }
                if (srcStat.size > MAX_LOCAL_COPY_BYTES) {
                    return errorResult(`"${srcPath}" is ${formatBytes(srcStat.size)}, which exceeds the 250 MB copy limit.`);
                }

                await copyFile(srcPath, target);
                const written = await stat(target);
                return ok(`Copied "${srcPath}" (${formatBytes(written.size)}) to "${destination_path}".`);
            },
            { mapError: (err, args) => driveErrorMapper(args.destination_path)(err) },
        ),
    );

    server.registerTool(
        'icloud_drive_create_folder',
        {
            title: 'Create an iCloud Drive folder',
            description:
                "Creates a new folder named 'name' under 'parent_path' (default '/'). Fails if an item " +
                'with that name already exists there.',
            inputSchema: {
                parent_path: z.string().optional(),
                name: z.string(),
            },
        },
        wrapHandler(
            async ({ parent_path, name }): Promise<CallToolResult> => {
                const parentRef = parent_path ?? '/';
                const parentTarget = await resolveDrivePath(parentRef);
                const parentStat = await stat(parentTarget).catch(() => undefined);
                if (!parentStat || !parentStat.isDirectory()) {
                    return errorResult(`"${parentRef}" is not an existing folder.`);
                }

                const childDrivePath = joinDrivePath(parentRef, name);
                const target = await resolveDrivePath(childDrivePath);
                if (await pathExists(target)) {
                    return errorResult(`"${name}" already exists under "${parentRef}".`);
                }

                await mkdir(target);
                return ok(`Created folder "${name}" under "${parentRef}".`);
            },
            { mapError: (err, args) => driveErrorMapper(args.parent_path ?? '/')(err) },
        ),
    );

    server.registerTool(
        'icloud_drive_move',
        {
            title: 'Move or rename an iCloud Drive item',
            description:
                "Moves and/or renames an iCloud Drive item at 'path'. Provide 'new_parent_path' to move " +
                "it and/or 'new_name' to rename it (providing only new_name renames in place). Refuses if " +
                'the destination already exists.',
            inputSchema: {
                path: z.string(),
                new_parent_path: z.string().optional(),
                new_name: z.string().optional(),
            },
        },
        wrapHandler(
            async ({ path: p, new_parent_path, new_name }): Promise<CallToolResult> => {
                if (!new_parent_path && !new_name) {
                    return errorResult('Provide new_parent_path and/or new_name.');
                }

                const root = path.resolve(driveRoot());
                const source = await resolveDrivePath(p);
                if (!(await pathExists(source))) {
                    return errorResult(`No item found at path "${p}".`);
                }
                const currentDrivePath = toDrivePath(root, source);

                const destParentDrivePath = new_parent_path ?? path.posix.dirname(currentDrivePath);
                const destName = new_name ?? path.basename(source);
                const destDrivePath = joinDrivePath(destParentDrivePath, destName);

                const destParentTarget = await resolveDrivePath(destParentDrivePath);
                const destParentStat = await stat(destParentTarget).catch(() => undefined);
                if (!destParentStat || !destParentStat.isDirectory()) {
                    return errorResult(`Destination folder "${destParentDrivePath}" does not exist.`);
                }

                const destination = await resolveDrivePath(destDrivePath);
                if (await pathExists(destination)) {
                    return errorResult(`"${destDrivePath}" already exists; refusing to overwrite.`);
                }

                await rename(source, destination);
                return ok(`Moved "${p}" to "${destDrivePath}".`);
            },
            { mapError: (err, args) => driveErrorMapper(args.path)(err) },
        ),
    );

    server.registerTool(
        'icloud_drive_delete',
        {
            title: 'Delete an iCloud Drive item',
            description:
                "Deletes an iCloud Drive item (file or folder) at 'path'. This should be confirmed with " +
                'the user before calling. Deletion moves the item to the OS recycle bin, not permanent ' +
                'removal - it can be restored from there afterward.',
            inputSchema: {
                path: z.string(),
            },
            annotations: { destructiveHint: true },
        },
        wrapHandler(
            async ({ path: p }): Promise<CallToolResult> => {
                const target = await resolveDrivePath(p);
                if (!(await pathExists(target))) {
                    return errorResult(`No item found at path "${p}".`);
                }

                try {
                    await trash(target, { glob: false });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    return errorResult(
                        `Failed to move "${p}" to the recycle bin: ${message}. Refusing to permanently delete it.`,
                    );
                }

                return ok(`Moved "${p}" to the recycle bin. It can be restored from there if needed.`);
            },
            { mapError: (err, args) => driveErrorMapper(args.path)(err) },
        ),
    );
}
