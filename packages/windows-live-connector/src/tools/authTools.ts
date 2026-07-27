import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ok, wrapHandler } from '@cloud-connectors/core';
import { login, logout, whoami } from '../auth.js';

export function registerAuthTools(server: McpServer): void {
    server.registerTool(
        'ms_login',
        {
            title: 'Sign in to Microsoft account',
            description:
                'Signs in to your personal Microsoft account. This opens your system\'s default web browser ' +
                'to complete an interactive Microsoft sign-in (authorization code + PKCE); the connector never ' +
                'sees your password. Run this first if ms_whoami reports you are not signed in.',
            inputSchema: {},
        },
        wrapHandler(async (): Promise<CallToolResult> => {
            const account = await login();
            return ok(`Signed in as ${account.username}${account.name ? ` (${account.name})` : ''}`);
        }),
    );

    server.registerTool(
        'ms_logout',
        {
            title: 'Sign out of Microsoft account',
            description: 'Clears the cached Microsoft account and tokens for this connector.',
            inputSchema: {},
        },
        wrapHandler(async (): Promise<CallToolResult> => {
            await logout();
            return ok('Signed out. All cached accounts and tokens have been removed.');
        }),
    );

    server.registerTool(
        'ms_whoami',
        {
            title: 'Show current Microsoft sign-in status',
            description:
                'Reports whether a Microsoft account is currently signed in, which account it is, and when the ' +
                'current access token expires.',
            inputSchema: {},
        },
        wrapHandler(async (): Promise<CallToolResult> => {
            const status = await whoami();
            if (!status.signedIn) {
                return ok('Not signed in. Run ms_login to sign in with your Microsoft account.');
            }
            const lines = [
                'Signed in: yes',
                `Account: ${status.username}`,
                status.scopes ? `Scopes: ${status.scopes.join(', ')}` : undefined,
                status.expiresOn ? `Token expires: ${status.expiresOn}` : undefined,
            ].filter(Boolean);
            return ok(lines.join('\n'));
        }),
    );
}
