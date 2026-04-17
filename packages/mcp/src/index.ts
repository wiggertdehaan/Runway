#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RunwayClient } from "./client.js";
import { registerTools } from "./tools.js";

const RUNWAY_URL = process.env.RUNWAY_URL;
const RUNWAY_APP_KEY = process.env.RUNWAY_APP_KEY;

if (!RUNWAY_URL || !RUNWAY_APP_KEY) {
  console.error(
    "Missing required environment variables: RUNWAY_URL and RUNWAY_APP_KEY"
  );
  process.exit(1);
}

const client = new RunwayClient(RUNWAY_URL, RUNWAY_APP_KEY);

const server = new McpServer({
  name: "runway",
  version: "0.1.0",
});

registerTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
