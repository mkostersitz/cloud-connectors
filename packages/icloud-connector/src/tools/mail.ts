import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from 'imapflow';
import nodemailer from 'nodemailer';
// MailComposer has no top-level export from 'nodemailer' - it's a deep import. The package has
// no "exports" map restricting subpaths, so plain Node.js file resolution applies.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser } from 'mailparser';
import type { AddressObject } from 'mailparser';
import {
    ok,
    errorResult,
    wrapHandler,
    htmlToText,
    sanitizeFilename,
    defaultDownloadDir,
    formatBytes,
    AuthRequiredError,
} from '@cloud-connectors/core';
import { requireCredentials, SMTP_HOST, SMTP_PORT, ConfigError } from '../config.js';
import { withImap, encodeMessageId, decodeMessageId, resolveMailbox, isAuthFailure } from '../imap.js';

const AUTH_MESSAGE =
    'iCloud sign-in failed. Check that ICLOUD_EMAIL is your Apple ID email and ICLOUD_APP_PASSWORD is a ' +
    'valid, unrevoked app-specific password generated at https://account.apple.com (Sign-In and Security ' +
    '-> App-Specific Passwords).';

const DEFAULT_COUNT = 20;
const MAX_COUNT = 50;
const MAX_BODY_CHARS = 50_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function clampCount(count: number | undefined): number {
    const value = count ?? DEFAULT_COUNT;
    return Math.min(MAX_COUNT, Math.max(1, Math.trunc(value)));
}

/** ConfigError already carries full setup guidance - surface it verbatim, no "Error:" prefix. */
function mapConfigError(err: unknown): CallToolResult | undefined {
    if (err instanceof ConfigError) {
        return errorResult(err.message);
    }
    return undefined;
}

function formatEnvelopeAddress(list: MessageAddressObject[] | undefined): string {
    if (!list || list.length === 0) return '(unknown)';
    return list
        .map((a) => (a.name && a.address && a.name !== a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? '(unknown)')))
        .join(', ');
}

/** Best-effort attachment detection from BODYSTRUCTURE: explicit "attachment" disposition, or a
 * named part that isn't marked inline (covers servers that omit disposition but set a filename). */
function structureHasAttachment(node: MessageStructureObject | undefined): boolean {
    if (!node) return false;
    const disposition = node.disposition?.toLowerCase();
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
    if (disposition === 'attachment') return true;
    if (filename && disposition !== 'inline') return true;
    if (node.childNodes) {
        return node.childNodes.some(structureHasAttachment);
    }
    return false;
}

function formatMessageSummary(mailbox: string, m: FetchMessageObject): string {
    const id = encodeMessageId(mailbox, m.uid);
    const flags = m.flags ?? new Set<string>();
    const readState = flags.has('\\Seen') ? 'read' : 'UNREAD';
    const attachmentNote = structureHasAttachment(m.bodyStructure) ? '  |  has attachments' : '';
    const date = m.envelope?.date ? m.envelope.date.toISOString() : '(no date)';
    return [
        `[${id}] ${date}`,
        `From: ${formatEnvelopeAddress(m.envelope?.from)}  |  ${readState}${attachmentNote}`,
        `Subject: ${m.envelope?.subject ?? '(no subject)'}`,
    ].join('\n');
}

function formatMessageList(mailbox: string, messages: FetchMessageObject[]): string {
    if (messages.length === 0) {
        return `No messages found in "${mailbox}".`;
    }
    const blocks = messages.map((m) => formatMessageSummary(mailbox, m));
    return `${messages.length} message(s) in "${mailbox}":\n\n${blocks.join('\n\n')}`;
}

function truncateBody(text: string): string {
    if (text.length <= MAX_BODY_CHARS) return text;
    return `${text.slice(0, MAX_BODY_CHARS)}\n\n[... truncated, body exceeds ${MAX_BODY_CHARS} characters ...]`;
}

function formatParsedAddress(addr: AddressObject | AddressObject[] | undefined): string {
    if (!addr) return '(none)';
    const list = Array.isArray(addr) ? addr : [addr];
    const text = list.map((a) => a.text).filter(Boolean).join(', ');
    return text || '(none)';
}

/**
 * Fetches the most recent `limit` messages (by UID, descending) matching `uids` from the
 * currently-locked mailbox, with envelope/flags/bodyStructure for listing.
 */
async function fetchSummaries(client: import('imapflow').ImapFlow, uids: number[], limit: number): Promise<FetchMessageObject[]> {
    const selected = [...uids].sort((a, b) => b - a).slice(0, limit);
    if (selected.length === 0) return [];
    const results: FetchMessageObject[] = [];
    for await (const msg of client.fetch(selected, { uid: true, envelope: true, flags: true, bodyStructure: true }, { uid: true })) {
        results.push(msg);
    }
    results.sort((a, b) => b.uid - a.uid);
    return results;
}

export function registerMailTools(server: McpServer): void {
    server.registerTool(
        'icloud_status',
        {
            title: 'iCloud connection status',
            description: 'Verifies IMAP login to iCloud Mail and reports the account email and the mailbox names found.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async (): Promise<CallToolResult> => {
                const { user } = requireCredentials();
                const mailboxes = await withImap(async (client) => {
                    const list = await client.list();
                    return list.map((m) => m.path);
                });
                return ok(
                    `Connected to iCloud Mail as ${user}.\nMailboxes (${mailboxes.length}): ${mailboxes.join(', ') || '(none found)'}`,
                );
            },
            { authMessage: AUTH_MESSAGE, mapError: (err) => mapConfigError(err) },
        ),
    );

    server.registerTool(
        'icloud_mail_list',
        {
            title: 'List mail messages',
            description:
                "Lists the most recent messages from a mailbox (default 'inbox'), newest first. Accepts friendly " +
                "aliases (inbox, drafts, sent, deleted, trash, junk, archive) or a literal iCloud mailbox name.",
            inputSchema: {
                folder: z
                    .string()
                    .optional()
                    .describe("Mailbox alias (e.g. 'inbox', 'sent', 'junk') or literal mailbox name. Defaults to 'inbox'."),
                count: z
                    .number()
                    .int()
                    .optional()
                    .describe(`Max messages to return (default ${DEFAULT_COUNT}, max ${MAX_COUNT}).`),
                unread_only: z.boolean().optional().describe('If true, only return unread messages.'),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async ({ folder, count, unread_only }): Promise<CallToolResult> => {
                const mailbox = resolveMailbox(folder && folder.trim().length > 0 ? folder : 'inbox');
                const limit = clampCount(count);

                const messages = await withImap(async (client) => {
                    const lock = await client.getMailboxLock(mailbox);
                    try {
                        const found = unread_only ? await client.search({ seen: false }, { uid: true }) : await client.search({ all: true }, { uid: true });
                        const uids = found === false ? [] : found;
                        return await fetchSummaries(client, uids, limit);
                    } finally {
                        lock.release();
                    }
                });

                return ok(formatMessageList(mailbox, messages));
            },
            { authMessage: AUTH_MESSAGE, mapError: (err) => mapConfigError(err) },
        ),
    );

    server.registerTool(
        'icloud_mail_search',
        {
            title: 'Search mail messages',
            description:
                "Searches a mailbox (default 'inbox') for messages matching text in the subject, sender, or body, newest first.",
            inputSchema: {
                query: z.string().describe('Text to search for.'),
                folder: z
                    .string()
                    .optional()
                    .describe("Mailbox alias or literal mailbox name to search within. Defaults to 'inbox'."),
                count: z
                    .number()
                    .int()
                    .optional()
                    .describe(`Max messages to return (default ${DEFAULT_COUNT}, max ${MAX_COUNT}).`),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async ({ query, folder, count }): Promise<CallToolResult> => {
                const mailbox = resolveMailbox(folder && folder.trim().length > 0 ? folder : 'inbox');
                const limit = clampCount(count);

                const messages = await withImap(async (client) => {
                    const lock = await client.getMailboxLock(mailbox);
                    try {
                        const found = await client.search(
                            { or: [{ subject: query }, { from: query }, { body: query }] },
                            { uid: true },
                        );
                        const uids = found === false ? [] : found;
                        return await fetchSummaries(client, uids, limit);
                    } finally {
                        lock.release();
                    }
                });

                return ok(formatMessageList(mailbox, messages));
            },
            { authMessage: AUTH_MESSAGE, mapError: (err) => mapConfigError(err) },
        ),
    );

    server.registerTool(
        'icloud_mail_read',
        {
            title: 'Read a mail message',
            description:
                'Fetches the full content of a single message (id from icloud_mail_list / icloud_mail_search), ' +
                'including a plain-text rendering of the body and a list of attachments (without downloading them). ' +
                'Note: downloading the message source from the IMAP server typically marks it \\Seen as a side effect.',
            inputSchema: {
                message_id: z.string().describe('Message id in the form "MAILBOX:UID".'),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(
            async ({ message_id }): Promise<CallToolResult> => {
                const { mailbox, uid } = decodeMessageId(message_id);

                const parsed = await withImap(async (client) => {
                    const lock = await client.getMailboxLock(mailbox);
                    try {
                        const download = await client.download(uid, undefined, { uid: true });
                        return await simpleParser(download.content);
                    } finally {
                        lock.release();
                    }
                });

                let bodyText = parsed.text ?? '';
                if (!bodyText && parsed.html) {
                    bodyText = htmlToText(parsed.html);
                }

                const attachmentsText =
                    parsed.attachments.length === 0
                        ? 'Attachments: none'
                        : `Attachments (${parsed.attachments.length}):\n` +
                          parsed.attachments
                              .map((a, i) => `  [${i}] ${a.filename ?? '(unnamed)'} (${formatBytes(a.size)}, ${a.contentType})`)
                              .join('\n');

                const header = [
                    `ID: ${message_id}`,
                    `Date: ${parsed.date ? parsed.date.toISOString() : '(no date)'}`,
                    `From: ${formatParsedAddress(parsed.from)}`,
                    `To: ${formatParsedAddress(parsed.to)}`,
                    `Cc: ${formatParsedAddress(parsed.cc)}`,
                    `Subject: ${parsed.subject ?? '(no subject)'}`,
                    attachmentsText,
                ].join('\n');

                return ok(`${header}\n\n---\n\n${truncateBody(bodyText)}`);
            },
            { authMessage: AUTH_MESSAGE, mapError: (err) => mapConfigError(err) },
        ),
    );

    server.registerTool(
        'icloud_mail_get_attachment',
        {
            title: 'Download a mail attachment',
            description:
                'Downloads a single file attachment from a message (attachment_index from icloud_mail_read) and ' +
                'saves it to disk. Refuses attachments larger than 25 MB.',
            inputSchema: {
                message_id: z.string().describe('Message id in the form "MAILBOX:UID".'),
                attachment_index: z.number().int().describe('Zero-based attachment index, from icloud_mail_read.'),
                save_dir: z
                    .string()
                    .optional()
                    .describe("Directory to save the file into. Defaults to the user's Downloads folder."),
            },
        },
        wrapHandler(
            async ({ message_id, attachment_index, save_dir }): Promise<CallToolResult> => {
                const { mailbox, uid } = decodeMessageId(message_id);

                const parsed = await withImap(async (client) => {
                    const lock = await client.getMailboxLock(mailbox);
                    try {
                        const download = await client.download(uid, undefined, { uid: true });
                        return await simpleParser(download.content);
                    } finally {
                        lock.release();
                    }
                });

                const attachment = parsed.attachments[attachment_index];
                if (!attachment) {
                    throw new Error(
                        `Attachment index ${attachment_index} not found (message has ${parsed.attachments.length} attachment(s)).`,
                    );
                }
                if (attachment.size > MAX_ATTACHMENT_BYTES) {
                    throw new Error(
                        `Attachment "${attachment.filename ?? '(unnamed)'}" is ${formatBytes(attachment.size)}, which exceeds the 25 MB limit.`,
                    );
                }

                const targetDir = save_dir && save_dir.trim().length > 0 ? save_dir.trim() : defaultDownloadDir();
                await mkdir(targetDir, { recursive: true });

                const filename = sanitizeFilename(attachment.filename ?? `attachment-${attachment_index}`, 'attachment');
                const fullPath = path.join(targetDir, filename);
                await writeFile(fullPath, attachment.content);

                return ok(`Saved attachment to ${fullPath} (${formatBytes(attachment.content.length)}).`);
            },
            { authMessage: AUTH_MESSAGE, mapError: (err) => mapConfigError(err) },
        ),
    );

    server.registerTool(
        'icloud_mail_create_draft',
        {
            title: 'Create a draft email',
            description:
                'Creates a new draft message in the Drafts mailbox (not sent). This is the PREFERRED way to compose ' +
                'email - it lets the user review and edit the draft in any mail client before sending.',
            inputSchema: {
                to: z.array(z.string()).describe('Recipient email addresses.'),
                subject: z.string().describe('Email subject.'),
                body: z.string().describe('Plain-text email body.'),
                cc: z.array(z.string()).optional().describe('CC email addresses.'),
            },
        },
        wrapHandler(
            async ({ to, subject, body, cc }): Promise<CallToolResult> => {
                const { user } = requireCredentials();
                const draftsMailbox = resolveMailbox('drafts');

                const raw = await new MailComposer({
                    from: user,
                    to,
                    ...(cc && cc.length > 0 ? { cc } : {}),
                    subject,
                    text: body,
                })
                    .compile()
                    .build();

                const result = await withImap(async (client) => client.append(draftsMailbox, raw, ['\\Draft']));

                const uidNote = result && result.uid !== undefined ? ` (uid ${result.uid})` : '';
                return ok(
                    `Draft created in "${draftsMailbox}"${uidNote}. This message has NOT been sent - it is editable ` +
                        'in any mail client connected to this account.',
                );
            },
            { authMessage: AUTH_MESSAGE, mapError: (err) => mapConfigError(err) },
        ),
    );

    server.registerTool(
        'icloud_mail_send',
        {
            title: 'Send an email',
            description:
                'Sends immediately and irreversibly. Always confirm the recipient list and content with the user ' +
                'before calling. After sending, also saves a copy to the Sent Messages mailbox (iCloud SMTP does ' +
                'not do this automatically).',
            inputSchema: {
                to: z.array(z.string()).describe('Recipient email addresses.'),
                subject: z.string().describe('Email subject.'),
                body: z.string().describe('Plain-text email body.'),
                cc: z.array(z.string()).optional().describe('CC email addresses.'),
            },
            annotations: { destructiveHint: true },
        },
        wrapHandler(
            async ({ to, subject, body, cc }): Promise<CallToolResult> => {
                if (!to || to.length === 0) {
                    throw new Error('At least one recipient (to) is required.');
                }
                const { user, pass } = requireCredentials();

                // Compose once so the bytes actually sent and the bytes archived to Sent Messages
                // are identical.
                const raw = await new MailComposer({
                    from: user,
                    to,
                    ...(cc && cc.length > 0 ? { cc } : {}),
                    subject,
                    text: body,
                })
                    .compile()
                    .build();

                const transport = nodemailer.createTransport({
                    host: SMTP_HOST,
                    port: SMTP_PORT,
                    secure: false,
                    requireTLS: true,
                    auth: { user, pass },
                });

                try {
                    await transport.sendMail({
                        envelope: { from: user, to: [...to, ...(cc ?? [])] },
                        raw,
                    });
                } catch (err) {
                    if (isAuthFailure(err)) {
                        throw new AuthRequiredError(AUTH_MESSAGE);
                    }
                    throw err;
                } finally {
                    transport.close();
                }

                let sentCopyNote = '';
                try {
                    await withImap(async (client) => {
                        await client.append(resolveMailbox('sent'), raw, ['\\Seen']);
                    });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    sentCopyNote = ` Warning: the message was sent, but saving a copy to Sent Messages failed: ${message}`;
                }

                return ok(`Message sent to ${to.join(', ')}.${sentCopyNote}`);
            },
            { authMessage: AUTH_MESSAGE, mapError: (err) => mapConfigError(err) },
        ),
    );

    server.registerTool(
        'icloud_mail_move',
        {
            title: 'Move a mail message',
            description:
                'Moves a message to another mailbox. Accepts a friendly alias (inbox, archive, junk, trash, ...) ' +
                'or a literal mailbox name as the destination.',
            inputSchema: {
                message_id: z.string().describe('Message id in the form "MAILBOX:UID".'),
                destination_folder: z.string().describe("Mailbox alias (e.g. 'archive') or literal mailbox name."),
            },
        },
        wrapHandler(
            async ({ message_id, destination_folder }): Promise<CallToolResult> => {
                const { mailbox, uid } = decodeMessageId(message_id);
                const destination = resolveMailbox(destination_folder);

                await withImap(async (client) => {
                    const lock = await client.getMailboxLock(mailbox);
                    try {
                        const result = await client.messageMove(uid, destination, { uid: true });
                        if (!result) {
                            throw new Error(`Message ${message_id} was not found in "${mailbox}".`);
                        }
                    } finally {
                        lock.release();
                    }
                });

                return ok(
                    `Message moved to "${destination}". Its UID changes after a move - re-list the folder ` +
                        '(icloud_mail_list) rather than reusing the old message id.',
                );
            },
            { authMessage: AUTH_MESSAGE, mapError: (err) => mapConfigError(err) },
        ),
    );

    server.registerTool(
        'icloud_mail_mark',
        {
            title: 'Mark a mail message read/unread or flagged',
            description: 'Updates the read state and/or flagged state of a message. At least one of read/flagged is required.',
            inputSchema: {
                message_id: z.string().describe('Message id in the form "MAILBOX:UID".'),
                read: z.boolean().optional().describe('Set true to mark read, false to mark unread.'),
                flagged: z.boolean().optional().describe('Set true to flag the message, false to clear the flag.'),
            },
        },
        wrapHandler(
            async ({ message_id, read, flagged }): Promise<CallToolResult> => {
                if (read === undefined && flagged === undefined) {
                    throw new Error('At least one of read or flagged must be provided.');
                }
                const { mailbox, uid } = decodeMessageId(message_id);

                await withImap(async (client) => {
                    const lock = await client.getMailboxLock(mailbox);
                    try {
                        if (read !== undefined) {
                            if (read) {
                                await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
                            } else {
                                await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
                            }
                        }
                        if (flagged !== undefined) {
                            if (flagged) {
                                await client.messageFlagsAdd(uid, ['\\Flagged'], { uid: true });
                            } else {
                                await client.messageFlagsRemove(uid, ['\\Flagged'], { uid: true });
                            }
                        }
                    } finally {
                        lock.release();
                    }
                });

                const changes = [read !== undefined ? `read=${read}` : undefined, flagged !== undefined ? `flagged=${flagged}` : undefined]
                    .filter(Boolean)
                    .join(', ');
                return ok(`Message ${message_id} updated (${changes}).`);
            },
            { authMessage: AUTH_MESSAGE, mapError: (err) => mapConfigError(err) },
        ),
    );
}
