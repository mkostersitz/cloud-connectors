import { ImapFlow } from 'imapflow';
import { AuthRequiredError } from '@cloud-connectors/core';
import { requireCredentials, IMAP_HOST, IMAP_PORT, tlsOptions } from './config.js';

/**
 * Well-known iCloud mailbox names, keyed by lowercase friendly alias. iCloud does not use the
 * generic IMAP names ("Sent Messages" / "Deleted Messages" rather than "Sent" / "Trash"), so
 * tools accept either the alias or the literal mailbox name.
 */
const MAILBOX_ALIASES: Readonly<Record<string, string>> = {
    inbox: 'INBOX',
    drafts: 'Drafts',
    sent: 'Sent Messages',
    sentitems: 'Sent Messages',
    'sent messages': 'Sent Messages',
    deleted: 'Deleted Messages',
    trash: 'Deleted Messages',
    'deleted messages': 'Deleted Messages',
    junk: 'Junk',
    spam: 'Junk',
    archive: 'Archive',
};

/**
 * Resolves a friendly folder alias (case-insensitive: inbox, drafts, sent, sentitems, deleted,
 * trash, junk, archive) to iCloud's actual mailbox name. Anything that isn't a recognized alias
 * is passed through unchanged, so callers may also supply a literal mailbox name.
 */
export function resolveMailbox(name: string): string {
    const trimmed = name.trim();
    const alias = MAILBOX_ALIASES[trimmed.toLowerCase()];
    return alias ?? trimmed;
}

/**
 * Builds the "MAILBOX:UID" id exposed to the model for a given message. iCloud mailbox names
 * (INBOX, Drafts, "Sent Messages", ...) don't contain colons in practice, so a simple join is
 * unambiguous as long as decoding splits on the LAST colon (see decodeMessageId).
 */
export function encodeMessageId(mailbox: string, uid: number): string {
    return `${mailbox}:${uid}`;
}

/**
 * Splits a "MAILBOX:UID" id back into its parts. Splits on the LAST colon (rather than the
 * first) so that this keeps working if a mailbox name ever contains a colon; the UID part is
 * validated to be purely numeric to catch malformed ids early with a clear error.
 */
export function decodeMessageId(id: string): { mailbox: string; uid: number } {
    const idx = id.lastIndexOf(':');
    if (idx <= 0 || idx === id.length - 1) {
        throw new Error(`Invalid message id "${id}": expected the form "MAILBOX:UID".`);
    }
    const mailbox = id.slice(0, idx);
    const uidPart = id.slice(idx + 1);
    if (!/^\d+$/.test(uidPart)) {
        throw new Error(`Invalid message id "${id}": expected the form "MAILBOX:UID" with a numeric UID.`);
    }
    return { mailbox, uid: Number(uidPart) };
}

/**
 * Detects IMAP/SMTP authentication failures across imapflow and nodemailer. imapflow's
 * AuthenticationFailure class is NOT re-exported from the package's public entry point (only
 * ImapFlow is - verified against node_modules/imapflow/lib/imap-flow.js), so `instanceof` is not
 * usable here; every internal auth code path (LOGIN, AUTH=PLAIN, AUTH=LOGIN, OAUTH) does
 * reliably set `err.authenticationFailed = true` on the thrown error, so duck-typing on that
 * property is the robust check. nodemailer's SMTP transport sets `err.code === 'EAUTH'` for the
 * equivalent failure.
 */
export function isAuthFailure(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { authenticationFailed?: unknown; code?: unknown; message?: unknown };
    if (e.authenticationFailed === true) return true;
    if (e.code === 'EAUTH') return true;
    const message = typeof e.message === 'string' ? e.message : '';
    return /authenticationfailed|authentication failed|invalid credentials/i.test(message);
}

/**
 * Runs `fn` against a freshly connected, authenticated ImapFlow client, always logging out /
 * closing the connection afterwards. Each call opens its own short-lived connection (no pooling)
 * since this is invoked per MCP tool call rather than from a long-running mail client.
 *
 * Throws ConfigError (unchanged) if credentials are not configured, or AuthRequiredError if the
 * server rejects the configured credentials.
 */
export async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const { user, pass } = requireCredentials();

    const client = new ImapFlow({
        host: IMAP_HOST,
        port: IMAP_PORT,
        secure: true,
        tls: tlsOptions(IMAP_HOST),
        auth: { user, pass },
        // Must stay false: imapflow's logger writes JSON to stdout, which is the MCP protocol
        // channel, and its debug records include the credentials sent during AUTH.
        logger: false,
    });

    try {
        await client.connect();
    } catch (err) {
        if (isAuthFailure(err)) {
            throw new AuthRequiredError(
                'iCloud IMAP login failed. Check that ICLOUD_EMAIL is your Apple ID email and ' +
                    'ICLOUD_APP_PASSWORD is a valid, unrevoked app-specific password generated at ' +
                    'https://account.apple.com (Sign-In and Security -> App-Specific Passwords).',
            );
        }
        throw err;
    }

    try {
        return await fn(client);
    } catch (err) {
        if (isAuthFailure(err)) {
            throw new AuthRequiredError(
                'iCloud IMAP authentication was rejected. Check ICLOUD_EMAIL and ICLOUD_APP_PASSWORD ' +
                    '(generate a fresh app-specific password at https://account.apple.com if needed).',
            );
        }
        throw err;
    } finally {
        try {
            await client.logout();
        } catch {
            // Best-effort graceful close; fall back to a hard close if logout itself fails
            // (e.g. connection already dropped).
            client.close();
        }
    }
}
