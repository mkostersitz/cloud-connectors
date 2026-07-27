import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import {
    PublicClientApplication,
    LogLevel,
    type AccountInfo,
    type Configuration,
    type ICachePlugin,
    type TokenCacheContext,
} from '@azure/msal-node';
import type { IPersistence, IPersistenceConfiguration } from '@azure/msal-node-extensions';
import { AuthRequiredError } from '@cloud-connectors/core';
import { clientId, cacheDir, cachePath, SCOPES, AUTHORITY } from './config.js';

/**
 * Thrown by getToken() whenever there is no usable cached session. Callers (tool handlers,
 * via wrapHandler from @cloud-connectors/core) catch this and tell the model/user to run the
 * ms_login tool. The class itself lives in core so it can be shared across connectors.
 */
export { AuthRequiredError };

/**
 * Opens the given URL in the user's default browser without blocking the Node process.
 * Platform-specific launch mechanism:
 *   - win32: Must NOT go through cmd.exe (`start`): cmd re-parses its command line and treats
 *     `&` as a command separator, truncating OAuth URLs at the first query parameter.
 *     rundll32's FileProtocolHandler receives the URL as a plain argv element instead.
 *   - darwin: `open` hands the URL straight to LaunchServices, no shell re-parsing involved.
 *   - other (Linux, *BSD, ...): `xdg-open` is the desktop-agnostic equivalent.
 */
async function openBrowser(url: string): Promise<void> {
    let command: string;
    let args: string[];
    if (process.platform === 'win32') {
        command = 'rundll32.exe';
        args = ['url.dll,FileProtocolHandler', url];
    } else if (process.platform === 'darwin') {
        command = 'open';
        args = [url];
    } else {
        command = 'xdg-open';
        args = [url];
    }

    const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.unref();
}

let pcaPromise: Promise<PublicClientApplication> | undefined;

/**
 * Lazily builds (and memoizes) the MSAL PublicClientApplication, wired to a platform-native
 * secure on-disk token cache via msal-node-extensions (falling back to a plaintext file if
 * that isn't available).
 */
function getPca(): Promise<PublicClientApplication> {
    if (!pcaPromise) {
        pcaPromise = buildPca();
    }
    return pcaPromise;
}

/**
 * Fallback ICachePlugin used when the platform-native secure store (DPAPI / Keychain /
 * libsecret, via @azure/msal-node-extensions) is unavailable. Reads/writes the raw MSAL
 * cache JSON to `filePath`, restricting file permissions to the owner on non-Windows
 * (Windows ACLs already default to the owning user for files under %LOCALAPPDATA%).
 */
function createPlaintextCachePlugin(filePath: string): ICachePlugin {
    return {
        async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
            let data: string;
            try {
                data = await readFile(filePath, 'utf-8');
            } catch (err: any) {
                if (err?.code !== 'ENOENT') {
                    throw err;
                }
                return;
            }
            try {
                context.cache.deserialize(data);
            } catch {
                // Unparseable content (e.g. a DPAPI-encrypted file written by another
                // instance, or corruption) must degrade to "signed out", never crash
                // every tool call. Keep the bad file aside once for post-mortems.
                console.error(`[auth] token cache at ${filePath} is not readable as MSAL JSON; treating as empty (re-run ms_login)`);
                await writeFile(`${filePath}.unreadable`, data, 'utf-8').catch(() => {});
            }
        },
        async afterCacheAccess(context: TokenCacheContext): Promise<void> {
            if (context.cacheHasChanged) {
                const data = context.cache.serialize();
                await writeFile(filePath, data, 'utf-8');
                if (process.platform !== 'win32') {
                    await chmod(filePath, 0o600);
                }
            }
        },
    };
}

/**
 * Builds an MSAL ICachePlugin backed by the platform's native secure credential store when
 * possible (DPAPI on Windows, Keychain on macOS, libsecret on Linux via
 * @azure/msal-node-extensions), falling back to a plaintext on-disk cache file if the
 * package - or its per-platform native binding - cannot be loaded, or if creating the
 * native persistence otherwise fails.
 */
async function createCachePlugin(): Promise<ICachePlugin> {
    try {
        if (process.platform === 'win32') {
            // Import the DPAPI persistence class directly by absolute file path instead of
            // the package root. The root (dist/index.mjs) re-exports KeychainPersistence,
            // whose TOP-LEVEL `import keytar` loads a single-arch native binding fetched at
            // npm-install time - under a host runtime of a different architecture (e.g.
            // Claude Desktop's ARM64 Electron running an x64-packed bundle) that import
            // throws and would needlessly take DPAPI down with it, even though
            // msal-node-extensions ships dpapi.node for x64/ia32/arm64 side by side.
            // Absolute-path imports also bypass the package's "exports" map, which only
            // exposes the root.
            const { createRequire } = await import('node:module');
            const { pathToFileURL } = await import('node:url');
            const path = await import('node:path');
            const require_ = createRequire(import.meta.url);
            const pkgRoot = path.dirname(require_.resolve('@azure/msal-node-extensions/package.json'));
            const fpdpMod = await import(
                pathToFileURL(path.join(pkgRoot, 'dist', 'persistence', 'FilePersistenceWithDataProtection.mjs')).href
            );
            const pcpMod = await import(
                pathToFileURL(path.join(pkgRoot, 'dist', 'persistence', 'PersistenceCachePlugin.mjs')).href
            );
            const persistence = await fpdpMod.FilePersistenceWithDataProtection.create(cachePath, 'CurrentUser');
            return new pcpMod.PersistenceCachePlugin(persistence);
        }

        // Non-Windows: the package root is required (Keychain/libsecret classes genuinely
        // need keytar there). Dynamic import so a missing/mismatched native binding cannot
        // crash the whole server at startup.
        const extensions = await import('@azure/msal-node-extensions');

        const persistenceConfig: IPersistenceConfiguration = {
            cachePath,
            dataProtectionScope: 'CurrentUser',
            serviceName: 'windows-live-connector',
            accountName: 'msal-token-cache',
        };

        const persistence: IPersistence = await extensions.PersistenceCreator.createPersistence(persistenceConfig);
        return new extensions.PersistenceCachePlugin(persistence);
    } catch (err) {
        // Fall back to a plaintext cache in a SEPARATE file: the secure-store file may hold
        // encrypted bytes another instance wrote, which the plaintext plugin must never
        // try (and fail) to parse as its own.
        const plainCachePath = `${cachePath}.plain.json`;
        console.error(
            `[auth] secure token-cache persistence unavailable (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); ` +
                `falling back to plaintext cache file at ${plainCachePath} - restrict access to this file`,
        );
        return createPlaintextCachePlugin(plainCachePath);
    }
}

async function buildPca(): Promise<PublicClientApplication> {
    if (!clientId) {
        throw new Error(
            'MS_CLIENT_ID is not set. Register an app in the Microsoft Entra portal ' +
                '(https://portal.azure.com -> App registrations -> New registration) with:\n' +
                '  - Supported account types: Personal Microsoft accounts only\n' +
                '  - Platform: Mobile and desktop applications\n' +
                '  - Redirect URI: http://localhost\n' +
                'Then set MS_CLIENT_ID to the application (client) ID in this connector\'s environment.',
        );
    }

    await mkdir(cacheDir, { recursive: true });

    const cachePlugin = await createCachePlugin();

    const configuration: Configuration = {
        auth: {
            clientId,
            authority: AUTHORITY,
        },
        cache: {
            cachePlugin,
        },
        system: {
            loggerOptions: {
                // MSAL diagnostics must never touch stdout - stdout is the MCP protocol channel.
                loggerCallback: (_level, message) => {
                    console.error(`[msal] ${message}`);
                },
                logLevel: LogLevel.Warning,
                piiLoggingEnabled: false,
            },
        },
    };

    return new PublicClientApplication(configuration);
}

/**
 * Returns a valid Graph access token, refreshing silently from the cached account if possible.
 * Throws AuthRequiredError if there is no cached account or silent refresh fails.
 */
export async function getToken(): Promise<string> {
    const pca = await getPca();
    const accounts = await pca.getAllAccounts();
    const account = accounts[0];
    if (!account) {
        throw new AuthRequiredError('Not signed in. Run the ms_login tool to sign in with your Microsoft account.');
    }

    try {
        const result = await pca.acquireTokenSilent({ account, scopes: SCOPES });
        return result.accessToken;
    } catch (err) {
        throw new AuthRequiredError('Not signed in. Run the ms_login tool to sign in with your Microsoft account.');
    }
}

/**
 * Runs the interactive (browser-based) sign-in flow via authorization code + PKCE.
 */
export async function login(): Promise<{ username: string; name?: string }> {
    const pca = await getPca();

    const result = await pca.acquireTokenInteractive({
        scopes: SCOPES,
        openBrowser,
        successTemplate:
            '<html><body style="font-family:sans-serif;text-align:center;padding-top:4em">' +
            '<h2>Signed in</h2><p>windows-live-connector is connected. You can close this tab.</p>' +
            '</body></html>',
        errorTemplate:
            '<html><body style="font-family:sans-serif;text-align:center;padding-top:4em">' +
            '<h2>Sign-in failed</h2><p>Close this tab and try ms_login again.</p>' +
            '</body></html>',
    });

    const account = result.account;
    if (!account) {
        throw new Error('Sign-in completed but no account was returned.');
    }

    return { username: account.username, name: account.name };
}

/**
 * Removes all cached accounts (and their tokens) from the token cache.
 */
export async function logout(): Promise<void> {
    const pca = await getPca();
    const accounts = await pca.getAllAccounts();
    for (const account of accounts as AccountInfo[]) {
        await pca.getTokenCache().removeAccount(account);
    }
}

/**
 * Non-throwing status check: attempts a silent token acquisition and reports the outcome.
 */
export async function whoami(): Promise<{
    signedIn: boolean;
    username?: string;
    scopes?: string[];
    expiresOn?: string;
}> {
    try {
        const pca = await getPca();
        const accounts = await pca.getAllAccounts();
        const account = accounts[0];
        if (!account) {
            return { signedIn: false };
        }

        const result = await pca.acquireTokenSilent({ account, scopes: SCOPES });
        return {
            signedIn: true,
            username: account.username,
            scopes: result.scopes,
            expiresOn: result.expiresOn ? result.expiresOn.toISOString() : undefined,
        };
    } catch {
        return { signedIn: false };
    }
}
