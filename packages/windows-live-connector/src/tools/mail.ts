import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
    ok,
    wrapHandler,
    htmlToText,
    sanitizeFilename,
    defaultDownloadDir,
    assertHeaderSafe,
    normalizeRecipients,
    addrSpecOnly,
} from '@cloud-connectors/core';
import { graphFetch } from '../graph.js';

const AUTH_MESSAGE = 'Not signed in. Run ms_login first.';

/** Fields kept small on every listing/search call to keep payloads compact. */
const LIST_SELECT = 'id,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview';

const MAX_COUNT = 50;
const DEFAULT_COUNT = 20;
const MAX_BODY_CHARS = 50_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

interface EmailAddressRecipient {
    emailAddress?: { name?: string; address?: string };
}

/**
 * Maps validated recipients to Graph's recipient shape. Graph composes the MIME itself, so the
 * `address` field must be a bare addr-spec - a `Name <addr>` string there is rejected as an
 * invalid address rather than parsed.
 */
function toGraphRecipients(addresses: string[]): EmailAddressRecipient[] {
    return addresses.map((address) => ({ emailAddress: { address: addrSpecOnly(address) } }));
}

interface GraphMessage {
    id?: string;
    subject?: string;
    from?: EmailAddressRecipient;
    toRecipients?: EmailAddressRecipient[];
    ccRecipients?: EmailAddressRecipient[];
    receivedDateTime?: string;
    isRead?: boolean;
    hasAttachments?: boolean;
    bodyPreview?: string;
    body?: { contentType?: string; content?: string };
}

interface GraphAttachment {
    id?: string;
    name?: string;
    size?: number;
    contentType?: string;
    isInline?: boolean;
    contentBytes?: string;
    '@odata.type'?: string;
}

function clampCount(count: number | undefined): number {
    const value = count ?? DEFAULT_COUNT;
    return Math.min(MAX_COUNT, Math.max(1, Math.trunc(value)));
}

function formatRecipient(r: EmailAddressRecipient | undefined): string {
    if (!r?.emailAddress) return '(unknown)';
    const { name, address } = r.emailAddress;
    if (name && address && name !== address) return `${name} <${address}>`;
    return address ?? name ?? '(unknown)';
}

function formatRecipientList(list: EmailAddressRecipient[] | undefined): string {
    if (!list || list.length === 0) return '(none)';
    return list.map(formatRecipient).join(', ');
}

/** Renders one message as a compact, human-readable block (not raw JSON). */
function formatMessageSummary(m: GraphMessage): string {
    const lines = [
        `[${m.id ?? '(no id)'}] ${m.receivedDateTime ?? '(no date)'}`,
        `From: ${formatRecipient(m.from)}  |  ${m.isRead ? 'read' : 'UNREAD'}${m.hasAttachments ? '  |  has attachments' : ''}`,
        `Subject: ${m.subject ?? '(no subject)'}`,
        `${m.bodyPreview ?? ''}`.trim(),
    ];
    return lines.join('\n');
}

function formatMessageList(messages: GraphMessage[], nextLink?: string): string {
    if (messages.length === 0) {
        return 'No messages found.';
    }
    const blocks = messages.map(formatMessageSummary);
    const parts = [`${messages.length} message(s):`, '', blocks.join('\n\n')];
    if (nextLink) {
        parts.push('', `More results available. Next page link: ${nextLink}`);
    }
    return parts.join('\n');
}

function truncateBody(text: string): string {
    if (text.length <= MAX_BODY_CHARS) return text;
    return `${text.slice(0, MAX_BODY_CHARS)}\n\n[... truncated, body exceeds ${MAX_BODY_CHARS} characters ...]`;
}

export function registerMailTools(server: McpServer): void {
    server.registerTool(
        'mail_list',
        {
            title: 'List mail messages',
            description:
                "Lists messages from a mail folder (default 'inbox'), newest first. Accepts well-known folder " +
                "names (inbox, sentitems, drafts, junkemail, deleteditems, archive, ...) or a folder id.",
            inputSchema: {
                folder: z
                    .string()
                    .optional()
                    .describe("Well-known folder name (e.g. 'inbox', 'sentitems', 'drafts', 'junkemail') or a folder id. Defaults to 'inbox'."),
                count: z
                    .number()
                    .int()
                    .optional()
                    .describe(`Max messages to return (default ${DEFAULT_COUNT}, max ${MAX_COUNT}).`),
                unread_only: z.boolean().optional().describe('If true, only return unread messages.'),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(async ({ folder, count, unread_only }): Promise<CallToolResult> => {
            const folderId = folder && folder.trim().length > 0 ? folder.trim() : 'inbox';
            const top = clampCount(count);

            const params = new URLSearchParams();
            params.set('$select', LIST_SELECT);
            params.set('$orderby', 'receivedDateTime desc');
            params.set('$top', String(top));
            if (unread_only) {
                params.set('$filter', 'isRead eq false');
            }

            const result = await graphFetch(
                `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${params.toString()}`,
            );
            const messages: GraphMessage[] = result?.value ?? [];
            const nextLink: string | undefined = result?.['@odata.nextLink'];
            return ok(formatMessageList(messages, nextLink));
        }, { authMessage: AUTH_MESSAGE }),
    );

    server.registerTool(
        'mail_search',
        {
            title: 'Search mail messages',
            description:
                'Searches messages across the mailbox using a Graph $search query (relevance-ordered). ' +
                'Cannot be combined with folder filtering or custom ordering.',
            inputSchema: {
                query: z.string().describe('Search text (matches subject, body, sender, etc.).'),
                count: z
                    .number()
                    .int()
                    .optional()
                    .describe(`Max messages to return (default ${DEFAULT_COUNT}, max ${MAX_COUNT}).`),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(async ({ query, count }): Promise<CallToolResult> => {
            const top = clampCount(count);
            const params = new URLSearchParams();
            params.set('$select', LIST_SELECT);
            params.set('$search', `"${query.replace(/"/g, "'")}"`);
            params.set('$top', String(top));

            const result = await graphFetch(`/me/messages?${params.toString()}`);
            const messages: GraphMessage[] = result?.value ?? [];
            const nextLink: string | undefined = result?.['@odata.nextLink'];
            return ok(formatMessageList(messages, nextLink));
        }, { authMessage: AUTH_MESSAGE }),
    );

    server.registerTool(
        'mail_read',
        {
            title: 'Read a mail message',
            description:
                'Fetches the full content of a single message, including a plain-text rendering of the body ' +
                '(HTML is converted to text) and a list of attachments (without downloading their contents).',
            inputSchema: {
                message_id: z.string().describe('The Graph message id to read.'),
            },
            annotations: { readOnlyHint: true },
        },
        wrapHandler(async ({ message_id }): Promise<CallToolResult> => {
            const messageSelect =
                'id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,body';
            const message: GraphMessage = await graphFetch(
                `/me/messages/${encodeURIComponent(message_id)}?$select=${messageSelect}`,
            );

            let bodyText = '';
            if (message.body?.content) {
                bodyText =
                    message.body.contentType?.toLowerCase() === 'html'
                        ? htmlToText(message.body.content)
                        : message.body.content;
            }
            bodyText = truncateBody(bodyText);

            let attachmentsText = 'Attachments: none';
            if (message.hasAttachments) {
                const attachmentResult = await graphFetch(
                    `/me/messages/${encodeURIComponent(message_id)}/attachments?$select=id,name,size,contentType,isInline`,
                );
                const attachments: GraphAttachment[] = attachmentResult?.value ?? [];
                if (attachments.length > 0) {
                    const lines = attachments.map(
                        (a) => `  - ${a.name ?? '(unnamed)'} (${a.size ?? '?'} bytes, id: ${a.id})`,
                    );
                    attachmentsText = `Attachments (${attachments.length}):\n${lines.join('\n')}`;
                }
            }

            const header = [
                `ID: ${message.id ?? message_id}`,
                `Date: ${message.receivedDateTime ?? '(no date)'}`,
                `From: ${formatRecipient(message.from)}`,
                `To: ${formatRecipientList(message.toRecipients)}`,
                `Cc: ${formatRecipientList(message.ccRecipients)}`,
                `Subject: ${message.subject ?? '(no subject)'}`,
                `Read: ${message.isRead ? 'yes' : 'no'}`,
                attachmentsText,
            ].join('\n');

            return ok(`${header}\n\n---\n\n${bodyText}`);
        }, { authMessage: AUTH_MESSAGE }),
    );

    server.registerTool(
        'mail_get_attachment',
        {
            title: 'Download a mail attachment',
            description:
                'Downloads a single file attachment from a message and saves it to disk. Refuses attachments ' +
                'larger than 25 MB. Non-file attachments (e.g. embedded items) are not supported.',
            inputSchema: {
                message_id: z.string().describe('The Graph message id containing the attachment.'),
                attachment_id: z.string().describe('The attachment id (from mail_read).'),
                save_dir: z
                    .string()
                    .optional()
                    .describe('Directory to save the file into. Defaults to the user\'s Downloads folder.'),
            },
        },
        wrapHandler(async ({ message_id, attachment_id, save_dir }): Promise<CallToolResult> => {
            const attachment: GraphAttachment = await graphFetch(
                `/me/messages/${encodeURIComponent(message_id)}/attachments/${encodeURIComponent(attachment_id)}`,
            );

            const odataType = attachment['@odata.type'] ?? '';
            if (!odataType.toLowerCase().includes('fileattachment') || !attachment.contentBytes) {
                throw new Error(
                    `Attachment ${attachment_id} is not a downloadable file attachment (type: ${odataType || 'unknown'}).`,
                );
            }

            if (typeof attachment.size === 'number' && attachment.size > MAX_ATTACHMENT_BYTES) {
                throw new Error(
                    `Attachment "${attachment.name ?? attachment_id}" is ${attachment.size} bytes, which exceeds the 25 MB limit.`,
                );
            }

            const buffer = Buffer.from(attachment.contentBytes, 'base64');
            if (buffer.length > MAX_ATTACHMENT_BYTES) {
                throw new Error(
                    `Attachment "${attachment.name ?? attachment_id}" is ${buffer.length} bytes, which exceeds the 25 MB limit.`,
                );
            }

            const targetDir =
                save_dir && save_dir.trim().length > 0 ? save_dir.trim() : defaultDownloadDir();
            await mkdir(targetDir, { recursive: true });

            const filename = sanitizeFilename(attachment.name ?? `attachment-${attachment_id}`, 'attachment');
            const fullPath = path.join(targetDir, filename);
            await writeFile(fullPath, buffer);

            return ok(`Saved attachment to ${fullPath} (${buffer.length} bytes).`);
        }, { authMessage: AUTH_MESSAGE }),
    );

    server.registerTool(
        'mail_create_draft',
        {
            title: 'Create a draft email',
            description:
                'Creates a new draft message (not sent). This is the PREFERRED way to compose email - it lets ' +
                'the user review the draft in Outlook before sending.',
            inputSchema: {
                to: z.array(z.string()).describe('Recipient email addresses.'),
                subject: z.string().describe('Email subject.'),
                body: z.string().describe('Plain-text email body.'),
                cc: z.array(z.string()).optional().describe('CC email addresses.'),
            },
        },
        wrapHandler(async ({ to, subject, body, cc }): Promise<CallToolResult> => {
            const payload = {
                subject: assertHeaderSafe(subject, 'Subject'),
                body: { contentType: 'Text', content: body },
                toRecipients: toGraphRecipients(normalizeRecipients(to, 'To', { required: true })),
                ...(cc && cc.length > 0 ? { ccRecipients: toGraphRecipients(normalizeRecipients(cc, 'Cc')) } : {}),
            };

            const draft: GraphMessage = await graphFetch('/me/messages', {
                method: 'POST',
                body: JSON.stringify(payload),
            });

            return ok(
                `Draft created (id: ${draft.id}). This message has NOT been sent - review it in Outlook, ` +
                    'or call mail_send with this draft_id to send it.',
            );
        }, { authMessage: AUTH_MESSAGE }),
    );

    server.registerTool(
        'mail_send',
        {
            title: 'Send an email',
            description:
                'Sends an email immediately and irreversibly, either by composing a new message (to/subject/body) ' +
                'or by sending an existing draft (draft_id). Sends immediately and irreversibly. Always confirm ' +
                'the recipient list and content with the user before calling.',
            inputSchema: {
                draft_id: z.string().optional().describe('If set, sends this existing draft instead of composing a new message.'),
                to: z.array(z.string()).optional().describe('Recipient email addresses (required if draft_id is not set).'),
                subject: z.string().optional().describe('Email subject (required if draft_id is not set).'),
                body: z.string().optional().describe('Plain-text email body (required if draft_id is not set).'),
                cc: z.array(z.string()).optional().describe('CC email addresses.'),
            },
            annotations: { destructiveHint: true },
        },
        wrapHandler(async ({ draft_id, to, subject, body, cc }): Promise<CallToolResult> => {
            if (draft_id) {
                await graphFetch(`/me/messages/${encodeURIComponent(draft_id)}/send`, { method: 'POST' });
                return ok(`Draft ${draft_id} sent.`);
            }

            if (!to || to.length === 0 || !subject || !body) {
                throw new Error('Provide either draft_id, or all of to/subject/body to compose and send a new message.');
            }

            const toList = normalizeRecipients(to, 'To', { required: true });
            const message = {
                subject: assertHeaderSafe(subject, 'Subject'),
                body: { contentType: 'Text', content: body },
                toRecipients: toGraphRecipients(toList),
                ...(cc && cc.length > 0 ? { ccRecipients: toGraphRecipients(normalizeRecipients(cc, 'Cc')) } : {}),
            };

            await graphFetch('/me/sendMail', {
                method: 'POST',
                body: JSON.stringify({ message, saveToSentItems: true }),
            });

            return ok(`Message sent to ${toList.join(', ')}.`);
        }, { authMessage: AUTH_MESSAGE }),
    );

    server.registerTool(
        'mail_move',
        {
            title: 'Move a mail message',
            description:
                'Moves a message to another mail folder. Accepts a well-known folder name (inbox, archive, ' +
                'deleteditems, junkemail, ...) or a folder id as the destination.',
            inputSchema: {
                message_id: z.string().describe('The Graph message id to move.'),
                destination_folder: z.string().describe("Well-known folder name (e.g. 'archive') or folder id."),
            },
        },
        wrapHandler(async ({ message_id, destination_folder }): Promise<CallToolResult> => {
            const moved: GraphMessage = await graphFetch(
                `/me/messages/${encodeURIComponent(message_id)}/move`,
                {
                    method: 'POST',
                    body: JSON.stringify({ destinationId: destination_folder }),
                },
            );
            return ok(`Message moved to '${destination_folder}'. New message id: ${moved.id}.`);
        }, { authMessage: AUTH_MESSAGE }),
    );

    server.registerTool(
        'mail_mark',
        {
            title: 'Mark a mail message read/unread or flagged',
            description: 'Updates the read state and/or flag state of a message. At least one of read/flagged is required.',
            inputSchema: {
                message_id: z.string().describe('The Graph message id to update.'),
                read: z.boolean().optional().describe('Set true to mark read, false to mark unread.'),
                flagged: z.boolean().optional().describe('Set true to flag the message, false to clear the flag.'),
            },
        },
        wrapHandler(async ({ message_id, read, flagged }): Promise<CallToolResult> => {
            if (read === undefined && flagged === undefined) {
                throw new Error('At least one of read or flagged must be provided.');
            }

            const payload: Record<string, unknown> = {};
            if (read !== undefined) {
                payload.isRead = read;
            }
            if (flagged !== undefined) {
                payload.flag = { flagStatus: flagged ? 'flagged' : 'notFlagged' };
            }

            await graphFetch(`/me/messages/${encodeURIComponent(message_id)}`, {
                method: 'PATCH',
                body: JSON.stringify(payload),
            });

            const changes = [
                read !== undefined ? `read=${read}` : undefined,
                flagged !== undefined ? `flagged=${flagged}` : undefined,
            ]
                .filter(Boolean)
                .join(', ');
            return ok(`Message ${message_id} updated (${changes}).`);
        }, { authMessage: AUTH_MESSAGE }),
    );
}
