#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadRunwayConfig } from "./config.js";
import { RunwayRegistry } from "./registry.js";
import { createRunwayServer } from "./server.js";

let registry: RunwayRegistry;
try {
  const config = loadRunwayConfig(process.env);
  // stderr only: stdout belongs to the MCP protocol. Warnings never contain a credential.
  for (const w of config.warnings) console.error(`runway-mcp: ${w}`);
  registry = new RunwayRegistry(config);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : "runway-mcp: could not read its configuration.");
  process.exit(1);
}

const server = createRunwayServer(registry);

const transport = new StdioServerTransport();
await server.connect(transport);
