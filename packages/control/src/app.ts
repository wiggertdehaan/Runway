import { Hono } from "hono";
import { logger } from "hono/logger";
import { securityHeaders } from "./middleware/security.js";
import { verifyCsrf } from "./middleware/csrf.js";
import { apiRateLimit } from "./middleware/rate-limit.js";
import { apiRoutes } from "./routes/api.js";
import { llmsRoutes } from "./routes/llms.js";
import { webRoutes } from "./routes/web.js";
import { oauthRoutes } from "./routes/oauth.js";

export const app = new Hono();

app.use(logger());
app.use(securityHeaders);
app.use(verifyCsrf);
app.use(apiRateLimit);

// API routes (used by MCP server and direct HTTP callers)
app.route("/api/v1", apiRoutes);

// Public LLM-facing documentation (/llms.txt). Unauthenticated —
// must be registered before the web routes so its path is matched
// instead of falling through to the session-guarded dashboard.
app.route("/", llmsRoutes);

// OAuth and forward-auth routes (before web so /auth/* matches first)
app.route("/", oauthRoutes);

// Web UI routes
app.route("/", webRoutes);
