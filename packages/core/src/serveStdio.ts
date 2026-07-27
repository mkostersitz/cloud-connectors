import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * Boots an MCP server over stdio: constructs the McpServer, lets `register` attach tools to it,
 * connects the stdio transport, and logs a connected message once ready.
 *
 * All logging goes to stderr - stdout is reserved for the MCP JSON-RPC protocol. Any error
 * during startup is logged and exits the process with status 1, so callers do not need to
 * attach their own `.catch()`.
 */
export async function serveStdio(
    name: string,
    version: string,
    register: (server: McpServer) => void,
): Promise<void> {
    try {
        const server = new McpServer({ name, version });
        register(server);

        const transport = new StdioServerTransport();
        await server.connect(transport);

        console.error(`${name}: MCP server connected over stdio`);
    } catch (err) {
        console.error(`${name}: fatal error`, err);
        process.exit(1);
    }
}
