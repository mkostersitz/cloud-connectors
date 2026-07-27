import os from 'node:os';
import path from 'node:path';

/**
 * Azure AD (Entra) application (client) ID for this connector.
 * Must be registered in the Microsoft Entra portal with:
 *   - Supported account types: Personal Microsoft accounts
 *   - Platform: Mobile and desktop applications
 *   - Redirect URI: http://localhost
 */
export const clientId: string | undefined = process.env.MS_CLIENT_ID;

/**
 * Picks the platform-appropriate directory for persisting the MSAL token cache:
 *   - win32: %LOCALAPPDATA%\windows-live-connector (DPAPI-encrypted)
 *   - darwin: ~/Library/Application Support/windows-live-connector (AES-256-GCM under a Keychain key)
 *   - other: ~/.config/windows-live-connector (libsecret-backed)
 * Uses os.homedir() rather than the USERPROFILE env var so it works identically on
 * every platform.
 */
function computeCacheDir(): string {
    switch (process.platform) {
        case 'win32':
            return path.join(
                process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
                'windows-live-connector',
            );
        case 'darwin':
            return path.join(os.homedir(), 'Library', 'Application Support', 'windows-live-connector');
        default:
            return path.join(os.homedir(), '.config', 'windows-live-connector');
    }
}

/**
 * Directory used to persist the MSAL token cache.
 */
export const cacheDir: string = computeCacheDir();

/**
 * Full path to the MSAL token cache file. Its contents are ciphertext on every supported
 * platform: DPAPI-protected on Windows, AES-256-GCM under a Keychain-held data key on macOS.
 */
export const cachePath: string = path.join(cacheDir, 'msal-cache.bin');

/**
 * Where an unencrypted cache lives if (and only if) MS_ALLOW_PLAINTEXT_TOKEN_CACHE is set.
 * Kept separate from `cachePath` so the two formats can never be confused for one another - and
 * so older versions' plaintext leftovers are findable at a known path for migration.
 */
export const plaintextCachePath = `${cachePath}.plain.json`;

/**
 * Escape hatch for systems with no secret service at all. Off by default: without it the
 * connector refuses to persist refresh tokens rather than writing them out in the clear.
 */
export const allowPlaintextTokenCache: boolean = process.env.MS_ALLOW_PLAINTEXT_TOKEN_CACHE === '1';

/** Identifiers for the OS credential-store item holding this connector's token-cache key. */
export const KEYCHAIN_SERVICE = 'windows-live-connector';
export const KEYCHAIN_ACCOUNT = 'msal-token-cache';

/**
 * Delegated Microsoft Graph scopes requested for the personal Microsoft Account.
 * `offline_access` is added automatically by MSAL and must not be listed explicitly.
 */
export const SCOPES: string[] = ['User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Files.ReadWrite.All'];

/**
 * Authority restricted to personal Microsoft accounts (MSA) only.
 */
export const AUTHORITY = 'https://login.microsoftonline.com/consumers';
