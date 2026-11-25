import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RunwayRegistry } from "./registry.js";
import { installTasks, RunwayTaskStore } from "./tasks.js";
import { registerTools } from "./tools.js";

/** The Runway MCP server: every tool, plus MCP Tasks for the slow ones (see tasks.ts). */
export function createRunwayServer(registry: RunwayRegistry, version = "0.1.0"): McpServer {
  const store = new RunwayTaskStore();
  const server = new McpServer(
    { name: "runway", version },
    {
      taskStore: store,
      capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
    }
  );
  registerTools(server, registry);
  installTasks(server, registry, store);
  return server;
}
