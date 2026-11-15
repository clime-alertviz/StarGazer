import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { geoapifyTools, skyTools } from "./providers/tools.js";

const group = process.argv[2];
if (!["geoapify", "sky"].includes(group))
  throw new Error("Choose provider-server.js geoapify or sky.");
const provider = group === "geoapify" ? geoapifyTools() : skyTools();
const server = new Server(
  {
    name:
      group === "geoapify" ? "Geoapify" : "StarGazer weather and astronomy",
    version: "0.4.0",
  },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: provider.tools,
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const result = await provider.callTool(
      req.params.name,
      req.params.arguments || {},
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error.message }],
    };
  }
});
await server.connect(new StdioServerTransport());
