/**
 * Tiny MCP client to try the server by hand:
 *   MCP_URL=http://127.0.0.1:8000/mcp MCP_TOKEN=… node scripts/call.ts search_products '{"query":"lessive"}'
 * Without a tool name, lists the tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8000/mcp");
const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN ?? ""}` } },
});
const client = new Client({ name: "manual-call", version: "0.0.0" });
await client.connect(transport);

const [tool, args] = process.argv.slice(2);
const result =
    tool === undefined
        ? await client.listTools()
        : await client.callTool({ name: tool, arguments: JSON.parse(args ?? "{}") }, undefined, {
              timeout: 300_000,
          });
console.log(JSON.stringify(result, null, 2));
await client.close();
