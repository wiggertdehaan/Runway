import { Hono } from "hono";
import { logger } from "hono/logger";
import { apiRoutes } from "./routes/api.js";
import { llmsRoutes } from "./routes/llms.js";
import { webRoutes } from "./routes/web.js";

export const app = new Hono();

app.use(logger());

// API routes (used by MCP server and direct HTTP callers)
app.route("/api/v1", apiRoutes);

// Public LLM-facing documentation (/llms.txt). Unauthenticated —
// must be registered before the web routes so its path is matched
// instead of falling through to the session-guarded dashboard.
app.route("/", llmsRoutes);

// Web UI routes
app.route("/", webRoutes);
