import { Hono } from "hono";
import { logger } from "hono/logger";
import { securityHeaders } from "./middleware/security.js";
import { verifyCsrf } from "./middleware/csrf.js";
import { keepInternalRoutesOffTheDashboardHost } from "./middleware/internal-routes.js";
import { expireLegacySessionCookie } from "./middleware/cookies.js";
import { apiRateLimit } from "./middleware/rate-limit.js";
import { assetRoutes } from "./routes/assets.js";
import { instanceRoutes } from "./routes/instance.js";
import { apiRoutes } from "./routes/api.js";
import { llmsRoutes } from "./routes/llms.js";
import { mcpRoutes } from "./routes/mcp.js";
import { webRoutes } from "./routes/web.js";
import { oauthRoutes } from "./routes/oauth.js";

export const app = new Hono();

app.use(logger());
app.use(securityHeaders);
// S23: /auth/verify and /maintenance are for Traefik, not for the dashboard host.
app.use(keepInternalRoutesOffTheDashboardHost);
// S02: browsers that still hold the old domain-wide session cookie are told to
// drop it (those sessions were ended on upgrade). Not on forward-auth calls:
// their Set-Cookie would only be relayed on a refusal, and that path already
// answers with its own headers.
app.use(async (c, next) => {
  if (c.req.path !== "/auth/verify") expireLegacySessionCookie(c);
  await next();
});
app.use(verifyCsrf);
app.use(apiRateLimit);

// API routes (used by MCP server and direct HTTP callers)
app.route("/api/v1", apiRoutes);

// Skill-distribution MCP server. Bearer-auth, JSON-RPC over HTTP.
// Mounted before web routes so /mcp doesn't fall through to dashboard.
app.route("/", mcpRoutes);

// Public LLM-facing documentation (/llms.txt). Unauthenticated —
// must be registered before the web routes so its path is matched
// instead of falling through to the session-guarded dashboard.
app.route("/", llmsRoutes);

// Self-hosted static assets (htmx). Public, before the session-guarded web routes.
app.route("/", assetRoutes);

// Public, display-only: the favicon and {name, color} of this instance (the
// login page shows the same two things). Before the session-guarded web routes.
app.route("/", instanceRoutes);

// OAuth and forward-auth routes (before web so /auth/* matches first)
app.route("/", oauthRoutes);

// Web UI routes
app.route("/", webRoutes);
