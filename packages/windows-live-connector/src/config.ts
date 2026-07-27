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
 *   - darwin: ~/Library/Application Support/windows-live-connector (Keychain-backed)
 *   - other: ~/.config/windows-live-connector (libsecret-backed, or plaintext fallback)
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
 * Full path to the MSAL token cache file.
 */
export const cachePath: string = path.join(cacheDir, 'msal-cache.bin');

/**
 * Delegated Microsoft Graph scopes requested for the personal Microsoft Account.
 * `offline_access` is added automatically by MSAL and must not be listed explicitly.
 */
export const SCOPES: string[] = ['User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Files.ReadWrite.All'];

/**
 * Authority restricted to personal Microsoft accounts (MSA) only.
 */
export const AUTHORITY = 'https://login.microsoftonline.com/consumers';
