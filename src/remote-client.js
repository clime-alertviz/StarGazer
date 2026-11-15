import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Small stdio adapter for plugin installation. It owns no database or provider
// credentials. Every action reaches the same authenticated HTTP MCP as the GUI.
let sequence = 0;
async function rpc(method, params) {
  const base = process.env.STAR_GAZER_URL || "http://127.0.0.1:4317";
  const url = new URL(base);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Use HTTPS for a hosted StarGazer service.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "STAR_GAZER_URL must be the service origin, without credentials or query parameters.",
    );
  const response = await fetch(new URL("/mcp", url), {
    method: "POST",
    headers: {
      ...(process.env.STAR_GAZER_TOKEN
        ? { Authorization: `Bearer ${process.env.STAR_GAZER_TOKEN}` }
        : {}),
      Origin: url.origin,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++sequence,
      method,
      params,
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "StarGazer access expired. Create a new token in Settings."
        : `StarGazer service returned HTTP ${response.status}.`,
    );
  const result = await response.json();
  if (result.error) throw new Error(result.error.message);
  return result.result;
}
const server = new Server(
  { name: "StarGazer", version: "0.4.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () =>
  rpc("tools/list", {}),
);
server.setRequestHandler(CallToolRequestSchema, (request) =>
  rpc("tools/call", request.params),
);
await server.connect(new StdioServerTransport());
