import os from 'node:os';
import path from 'node:path';

/**
 * Default directory for file downloads (attachments, remote-file reads, ...) - the user's
 * Downloads folder, which exists by default on Windows, macOS, and Linux.
 */
export function defaultDownloadDir(): string {
    return path.join(os.homedir(), 'Downloads');
}

/**
 * Strips path separators and Windows-reserved filename characters, trims whitespace, and falls
 * back to `fallback` if the result would otherwise be empty.
 */
export function sanitizeFilename(name: string, fallback = 'file'): string {
    const cleaned = name
        .replace(/[\\/]/g, '_')
        .replace(/[<>:"|?*\x00-\x1f]/g, '_')
        .trim();
    return cleaned.length > 0 ? cleaned : fallback;
}

/** Renders a byte count as a human-readable size (B, KB, MB, GB, TB - one decimal place above B). */
export function formatBytes(bytes: number | undefined | null): string {
    if (bytes === undefined || bytes === null) return 'unknown size';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = -1;
    do {
        value /= 1024;
        unitIndex += 1;
    } while (value >= 1024 && unitIndex < units.length - 1);
    return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** MIME types (exact match, parameters stripped) treated as text-like beyond the `text/*` prefix. */
export const TEXT_MIME_TYPES: ReadonlySet<string> = new Set([
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-javascript',
    'application/typescript',
    'application/x-sh',
    'application/x-yaml',
    'application/yaml',
    'application/x-httpd-php',
    'application/x-python-code',
    'application/sql',
]);

/** File extensions (lowercase, with leading dot) treated as text-like regardless of MIME type. */
export const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.markdown', '.txt',
    '.log', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.css', '.scss', '.html',
    '.htm', '.svg', '.csv', '.tsv', '.py', '.rb', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat',
    '.cmd', '.c', '.h', '.cpp', '.hpp', '.cs', '.java', '.kt', '.go', '.rs', '.swift', '.m', '.tcl',
    '.lua', '.pl', '.sql', '.r', '.ino', '.dockerfile', '.env', '.gitignore', '.editorconfig',
    '.php', '.less',
]);

/**
 * Detects whether a file should be treated as text (safe to decode and display inline) from its
 * MIME type and/or file name.
 */
export function isTextLikeFile(mimeType: string | undefined, name: string): boolean {
    if (mimeType) {
        const base = mimeType.split(';')[0].trim().toLowerCase();
        if (base.startsWith('text/')) return true;
        if (TEXT_MIME_TYPES.has(base)) return true;
    }
    const ext = path.extname(name).toLowerCase();
    return TEXT_FILE_EXTENSIONS.has(ext);
}
