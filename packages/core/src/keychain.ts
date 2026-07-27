import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

/** Absolute path to the macOS keychain CLI. Absolute, never PATH-resolved, so a hijacked PATH cannot substitute it. */
const SECURITY_BIN = '/usr/bin/security';

/** `security find-generic-password` exit status for "no such item in the keychain". */
const ERR_ITEM_NOT_FOUND = 44;

/**
 * Upper bound on what may be written through `security -i`. The interactive command parser reads
 * its input line by line with a fixed-size buffer (~2 KB) and silently splits anything longer,
 * re-parsing the tail as a fresh command - which fails with `unknown command "<secret tail>"`
 * *and* echoes part of the secret to stderr. Callers must therefore only put SHORT secrets here
 * (a wrapped data key, not a whole token cache); `sealedStore.ts` is the intended consumer.
 */
const MAX_SECRET_LENGTH = 512;

/**
 * True when this process can use the macOS Keychain through the built-in `security` CLI.
 *
 * Using the CLI rather than a native binding (keytar and friends) is deliberate: a compiled
 * `.node` addon is tied to both the CPU architecture and the exact Node ABI it was built
 * against, so a bundle packed on one machine routinely fails to load under Claude Desktop's
 * runtime - and a credential store that silently fails to load is exactly the failure mode that
 * used to demote token storage to a plaintext file. `/usr/bin/security` ships with macOS and has
 * neither coupling.
 */
export function isKeychainSupported(): boolean {
    return process.platform === 'darwin' && existsSync(SECURITY_BIN) && hasKeychainDirectory();
}

/**
 * True when the user's per-user keychain directory exists.
 *
 * This guard exists to keep `security` from being run against a home directory that has no
 * keychain at all: in that situation macOS does not simply fail, it puts up a Keychain Access
 * dialog offering to create or reset the login keychain. A background MCP server must never
 * provoke that prompt - refusing up front, and letting the caller report a plain error, is the
 * only acceptable behaviour. The check is on the directory rather than a specific
 * `login.keychain-db`, so custom or renamed default keychains still pass.
 */
function hasKeychainDirectory(): boolean {
    const home = process.env.HOME;
    return typeof home === 'string' && home.length > 0 && existsSync(`${home}/Library/Keychains`);
}

/**
 * Reads a generic-password item. Returns undefined when no such item exists.
 * The secret is read from the child's stdout, which is a private pipe - unlike a command line,
 * it is not visible to other processes via `ps`.
 */
export async function keychainGet(service: string, account: string): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync(
            SECURITY_BIN,
            ['find-generic-password', '-s', service, '-a', account, '-w'],
            { encoding: 'utf-8', maxBuffer: 1024 * 1024 },
        );
        return stdout.replace(/\r?\n$/, '');
    } catch (err) {
        if ((err as { code?: unknown })?.code === ERR_ITEM_NOT_FOUND) {
            return undefined;
        }
        throw err;
    }
}

/**
 * Creates or replaces a generic-password item (`-U` updates in place when it already exists).
 *
 * The secret is fed to `security -i` over stdin instead of being passed as the `-w` argument of a
 * normal invocation, because command-line arguments of a running process are readable by other
 * processes of the same user (`ps -ww`). stdin is not.
 */
export async function keychainSet(service: string, account: string, secret: string): Promise<void> {
    if (secret.length > MAX_SECRET_LENGTH) {
        throw new Error(
            `keychainSet: secret is ${secret.length} chars, over the ${MAX_SECRET_LENGTH}-char limit for ` +
                "the `security -i` command parser. Store a short key here and seal the payload with it.",
        );
    }
    // The interactive parser is whitespace-separated and line-terminated, so any argument
    // containing whitespace or quoting metacharacters would be mis-parsed (and, for the secret,
    // partially echoed to stderr). Callers pass base64 secrets and constant identifiers; assert it.
    if (/[\s"'\\]/.test(secret)) {
        throw new Error('keychainSet: secret must not contain whitespace, quotes, or backslashes (use base64).');
    }
    for (const [label, value] of [['service', service], ['account', account]] as const) {
        if (value.length === 0 || /[\s"'\\]/.test(value)) {
            throw new Error(`keychainSet: ${label} must be non-empty and free of whitespace and quoting characters.`);
        }
    }

    const child = spawn(SECURITY_BIN, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
    });

    const finished = new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? -1));
    });

    child.stdin.end(`add-generic-password -U -s ${service} -a ${account} -w ${secret}\n`);

    const code = await finished;
    const diagnostic = redactSecret(stderr, secret).trim();
    if (code !== 0 || diagnostic.length > 0) {
        // `security`'s exit codes are its own internal table rather than OSStatus values, so the
        // message text is the only useful diagnostic - but it must be redacted first, since a
        // mis-parsed command line is echoed back verbatim.
        throw new Error(
            `security add-generic-password failed (exit ${code})${diagnostic ? `: ${firstLine(diagnostic)}` : ''}`,
        );
    }
}

/** Replaces every occurrence of `secret` in `text` so it can never reach a log or an error message. */
function redactSecret(text: string, secret: string): string {
    return secret.length > 0 ? text.split(secret).join('<redacted>') : text;
}

function firstLine(text: string): string {
    return text.split('\n')[0].slice(0, 300);
}

/** Deletes a generic-password item. A missing item is not an error. */
export async function keychainDelete(service: string, account: string): Promise<void> {
    try {
        await execFileAsync(SECURITY_BIN, ['delete-generic-password', '-s', service, '-a', account], {
            encoding: 'utf-8',
        });
    } catch (err) {
        if ((err as { code?: unknown })?.code === ERR_ITEM_NOT_FOUND) {
            return;
        }
        throw err;
    }
}
