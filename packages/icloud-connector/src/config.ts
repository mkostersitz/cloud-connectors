import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Apple ID email and app-specific password, injected by Claude Desktop from the
 * extension's user_config (the password field is declared sensitive and lives in the
 * OS keychain). Generate an app-specific password at https://account.apple.com
 * -> Sign-In and Security -> App-Specific Passwords.
 *
 * NEVER log the password.
 */
export const appleId: string | undefined = process.env.ICLOUD_EMAIL;
export const appPassword: string | undefined = process.env.ICLOUD_APP_PASSWORD;

export const IMAP_HOST = 'imap.mail.me.com';
export const IMAP_PORT = 993; // implicit TLS
export const SMTP_HOST = 'smtp.mail.me.com';
export const SMTP_PORT = 587; // STARTTLS

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigError';
    }
}

/** Throws a ConfigError with setup instructions when credentials are missing. */
export function requireCredentials(): { user: string; pass: string } {
    if (!appleId || !appPassword) {
        throw new ConfigError(
            'iCloud credentials are not configured. Set ICLOUD_EMAIL to your Apple ID email and ' +
                'ICLOUD_APP_PASSWORD to an app-specific password generated at https://account.apple.com ' +
                '(Sign-In and Security -> App-Specific Passwords). When installed as a Claude Desktop ' +
                'extension, both are entered in the extension settings.',
        );
    }
    return { user: appleId, pass: appPassword };
}

/**
 * Resolves the local iCloud Drive sync-folder root: ICLOUD_DRIVE_PATH override, else the
 * platform default. Throws ConfigError (with guidance) if the folder does not exist.
 */
export function driveRoot(): string {
    const override = process.env.ICLOUD_DRIVE_PATH;
    const candidate =
        override && override.trim().length > 0
            ? override
            : process.platform === 'darwin'
              ? path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
              : path.join(os.homedir(), 'iCloudDrive');

    if (!fs.existsSync(candidate)) {
        throw new ConfigError(
            `iCloud Drive folder not found at "${candidate}". Install and sign in to the iCloud client ` +
                '(iCloud for Windows from the Microsoft Store, or System Settings -> Apple ID -> iCloud on macOS) ' +
                'and enable iCloud Drive syncing, or set ICLOUD_DRIVE_PATH to the correct folder.',
        );
    }
    return candidate;
}
