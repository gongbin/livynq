import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, type McpOptions } from './mcp.ts';

/** Runs the MCP server over stdio (for `livynq mcp`). Nothing else may write to stdout. */
export async function serveMcpStdio(options: McpOptions): Promise<void> {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
}
