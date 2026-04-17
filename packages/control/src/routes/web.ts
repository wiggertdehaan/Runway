import { Hono } from "hono";
import { html, raw } from "hono/html";
import { deleteCookie, setCookie } from "hono/cookie";
import { listApps, createApp, deleteApp } from "../db/apps.js";
import {
  authenticate,
  countUsers,
  createUser,
  deleteUser,
  getUserByUsername,
  listUsers,
} from "../db/users.js";
import { createSession, deleteSession } from "../db/sessions.js";
import {
  getSetting,
  setSetting,
  normalizeBaseDomain,
} from "../db/settings.js";
import {
  SESSION_COOKIE,
  requireSession,
  type WebEnv,
} from "../middleware/session.js";

export const webRoutes = new Hono<WebEnv>();

// ── Helpers ──────────────────────────────────────────────
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, body: string, username?: string) {
  const nav = username
    ? `<nav class="nav">
         <a href="/">Apps</a>
         <a href="/users">Users</a>
         <a href="/settings">Settings</a>
         <div class="nav-spacer"></div>
         <span class="meta">${escapeHtml(username)}</span>
         <form method="POST" action="/logout" style="display:inline;margin:0">
           <button type="submit" class="ghost">Logout</button>
         </form>
       </nav>`
    : "";

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${title} - Runway</title>
        <script src="https://unpkg.com/htmx.org@2.0.4"></script>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 2rem; }
          h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
          h2 { font-size: 1.1rem; }
          .container { max-width: 800px; margin: 0 auto; }
          .nav { display: flex; gap: 1rem; align-items: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid #262626; }
          .nav a { color: #e5e5e5; text-decoration: none; font-weight: 500; }
          .nav a:hover { color: #60a5fa; }
          .nav-spacer { flex: 1; }
          .card { background: #171717; border: 1px solid #262626; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
          .card h2 { margin-bottom: 0.5rem; }
          .meta { color: #737373; font-size: 0.85rem; }
          .key { font-family: monospace; background: #262626; padding: 2px 6px; border-radius: 4px; font-size: 0.85rem; word-break: break-all; }
          .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }
          .badge-created { background: #1e3a5f; color: #60a5fa; }
          .badge-running { background: #14532d; color: #4ade80; }
          .badge-stopped { background: #451a03; color: #fb923c; }
          form { margin-bottom: 1.5rem; }
          input, select, button { padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid #262626; background: #171717; color: #e5e5e5; font-size: 0.9rem; font-family: inherit; }
          input:focus, select:focus { outline: none; border-color: #2563eb; }
          button { background: #2563eb; border-color: #2563eb; cursor: pointer; font-weight: 600; }
          button:hover { background: #1d4ed8; }
          button.danger { background: #dc2626; border-color: #dc2626; }
          button.danger:hover { background: #b91c1c; }
          button.ghost { background: transparent; border-color: #262626; }
          button.ghost:hover { background: #171717; }
          .flex { display: flex; gap: 0.5rem; align-items: center; }
          .between { justify-content: space-between; }
          .auth-card { max-width: 400px; margin: 4rem auto; }
          .auth-card input { width: 100%; margin-bottom: 0.75rem; }
          .auth-card button { width: 100%; }
          .error { background: #451a1a; border: 1px solid #dc2626; color: #fca5a5; padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem; }
          .hint { color: #737373; font-size: 0.85rem; margin-bottom: 1rem; }
        </style>
      </head>
      <body>
        <div class="container">
          ${raw(nav)}
          ${raw(body)}
        </div>
      </body>
    </html>`;
}

function authLayout(title: string, body: string) {
  return layout(title, `<div class="auth-card">${body}</div>`);
}

// ── Public routes (no auth) ──────────────────────────────

webRoutes.get("/setup", (c) => {
  if (countUsers() > 0) return c.redirect("/login");
  return c.html(
    authLayout(
      "Setup",
      `
      <h1>Welcome to Runway</h1>
      <p class="hint">Create the first admin account and configure your base domain.</p>
      <form method="POST" action="/setup">
        <input type="text" name="username" placeholder="Username" required autofocus />
        <input type="password" name="password" placeholder="Password (min 8 characters)" minlength="8" required />
        <input type="text" name="base_domain" placeholder="Base domain (optional, e.g. runway.example.com)" />
        <p class="hint">
          Point a wildcard DNS record <span class="key">*.your-domain</span> to this server.
          Each app will get its own subdomain automatically.
        </p>
        <button type="submit">Create account</button>
      </form>
    `
    )
  );
});

webRoutes.post("/setup", async (c) => {
  if (countUsers() > 0) return c.redirect("/login");

  const body = await c.req.parseBody();
  const username = (body["username"] as string | undefined)?.trim();
  const password = body["password"] as string | undefined;
  const baseDomainRaw = body["base_domain"] as string | undefined;

  if (!username || !password || password.length < 8) {
    return c.redirect("/setup");
  }

  const user = await createUser(username, password);

  if (baseDomainRaw && baseDomainRaw.trim()) {
    const normalized = normalizeBaseDomain(baseDomainRaw);
    if (normalized) setSetting("base_domain", normalized);
  }

  const session = createSession(user.id);
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.redirect("/");
});

webRoutes.get("/login", (c) => {
  if (countUsers() === 0) return c.redirect("/setup");
  const error = c.req.query("error");
  return c.html(
    authLayout(
      "Login",
      `
      <h1>Sign in</h1>
      ${error ? '<div class="error">Invalid username or password.</div>' : ""}
      <form method="POST" action="/login">
        <input type="text" name="username" placeholder="Username" required autofocus />
        <input type="password" name="password" placeholder="Password" required />
        <button type="submit">Sign in</button>
      </form>
    `
    )
  );
});

webRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const username = (body["username"] as string | undefined)?.trim();
  const password = body["password"] as string | undefined;

  if (!username || !password) {
    return c.redirect("/login?error=1");
  }

  const user = await authenticate(username, password);
  if (!user) return c.redirect("/login?error=1");

  const session = createSession(user.id);
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return c.redirect("/");
});

webRoutes.post("/logout", (c) => {
  const token = c.req.header("cookie")?.match(/runway_session=([^;]+)/)?.[1];
  if (token) deleteSession(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login");
});

// ── Protected routes ─────────────────────────────────────

webRoutes.use("/", requireSession);
webRoutes.use("/apps", requireSession);
webRoutes.use("/apps/*", requireSession);
webRoutes.use("/users", requireSession);
webRoutes.use("/users/*", requireSession);
webRoutes.use("/settings", requireSession);
webRoutes.use("/settings/*", requireSession);

webRoutes.get("/", (c) => {
  const user = c.get("user");
  const apps = listApps();
  const baseDomain = getSetting("base_domain");
  const domainHint = baseDomain
    ? `<p class="hint">Configured apps will be reachable at <span class="key">&lt;slug&gt;.${escapeHtml(baseDomain)}</span></p>`
    : `<p class="hint">No base domain configured. <a href="/settings" style="color:#60a5fa">Set one in settings</a> to get automatic subdomains.</p>`;

  const appCards = apps
    .map((app) => {
      const configured = !!(app.name && app.runtime);
      const title = configured
        ? escapeHtml(app.name!)
        : '<span class="meta">Unconfigured</span>';
      const metaLine = configured
        ? `Runtime: ${escapeHtml(app.runtime!)} &middot; Port: ${app.port} &middot; Domain: ${escapeHtml(app.domain || "not set")}`
        : `Waiting for configuration via MCP`;

      return `
        <div class="card">
          <div class="flex between">
            <h2>${title}</h2>
            <span class="badge badge-${escapeHtml(app.status)}">${escapeHtml(app.status)}</span>
          </div>
          <p class="meta" style="margin-top:0.5rem">${metaLine}</p>
          <p class="meta" style="margin-top:0.5rem">
            API Key: <span class="key">${escapeHtml(app.api_key)}</span>
          </p>
          <div style="margin-top:0.75rem">
            <form method="POST" action="/apps/${encodeURIComponent(app.id)}/delete" style="display:inline;margin:0">
              <button class="danger" type="submit">Delete</button>
            </form>
          </div>
        </div>
      `;
    })
    .join("");

  return c.html(
    layout(
      "Dashboard",
      `
      <h1>Apps</h1>
      ${domainHint}
      <p class="hint">
        Generate an API key below, then configure the app from Claude Code
        through the Runway MCP server. The MCP tools will prompt you for
        a name and runtime on first deploy.
      </p>
      <form method="POST" action="/apps">
        <button type="submit">Generate new API key</button>
      </form>
      ${apps.length === 0 ? '<p class="meta">No apps yet. Generate an API key to get started.</p>' : appCards}
    `,
      user.username
    )
  );
});

webRoutes.post("/apps", (c) => {
  createApp();
  return c.redirect("/");
});

webRoutes.post("/apps/:id/delete", (c) => {
  deleteApp(c.req.param("id"));
  return c.redirect("/");
});

// ── Users management ─────────────────────────────────────

webRoutes.get("/users", (c) => {
  const current = c.get("user");
  const users = listUsers();

  const rows = users
    .map(
      (u) => `
    <div class="card">
      <div class="flex between">
        <div>
          <h2>${escapeHtml(u.username)}</h2>
          <p class="meta">Created ${escapeHtml(u.created_at)}</p>
        </div>
        ${
          u.id === current.id
            ? '<span class="meta">you</span>'
            : `<form method="POST" action="/users/${encodeURIComponent(u.id)}/delete" style="margin:0">
                 <button class="danger" type="submit">Delete</button>
               </form>`
        }
      </div>
    </div>
  `
    )
    .join("");

  return c.html(
    layout(
      "Users",
      `
      <h1>Users</h1>
      <form method="POST" action="/users">
        <div class="flex">
          <input type="text" name="username" placeholder="Username" required />
          <input type="password" name="password" placeholder="Password (min 8)" minlength="8" required />
          <button type="submit">Add user</button>
        </div>
      </form>
      ${rows}
    `,
      current.username
    )
  );
});

webRoutes.post("/users", async (c) => {
  const body = await c.req.parseBody();
  const username = (body["username"] as string | undefined)?.trim();
  const password = body["password"] as string | undefined;

  if (!username || !password || password.length < 8) {
    return c.redirect("/users");
  }

  if (getUserByUsername(username)) {
    return c.redirect("/users");
  }

  await createUser(username, password);
  return c.redirect("/users");
});

webRoutes.post("/users/:id/delete", (c) => {
  const current = c.get("user");
  const id = c.req.param("id");
  // Prevent deleting yourself
  if (id === current.id) return c.redirect("/users");
  deleteUser(id);
  return c.redirect("/users");
});

// ── Settings ─────────────────────────────────────────────

webRoutes.get("/settings", (c) => {
  const user = c.get("user");
  const baseDomain = getSetting("base_domain") ?? "";
  const saved = c.req.query("saved");

  return c.html(
    layout(
      "Settings",
      `
      <h1>Settings</h1>
      ${saved ? '<div class="card" style="border-color:#14532d;color:#4ade80">Settings saved.</div>' : ""}
      <div class="card">
        <h2>Base domain</h2>
        <p class="hint" style="margin:0.5rem 0 1rem">
          Wildcard domain used to generate subdomains for your apps. Point a DNS
          record <span class="key">*.your-domain</span> to this server's public IP.
          When set, new apps get <span class="key">&lt;app-slug&gt;.your-domain</span>
          automatically and Traefik issues Let's Encrypt certificates on demand.
        </p>
        <form method="POST" action="/settings">
          <div class="flex">
            <input type="text" name="base_domain" value="${escapeHtml(baseDomain)}" placeholder="runway.example.com" style="flex:1" />
            <button type="submit">Save</button>
          </div>
        </form>
      </div>
    `,
      user.username
    )
  );
});

webRoutes.post("/settings", async (c) => {
  const body = await c.req.parseBody();
  const input = (body["base_domain"] as string | undefined) ?? "";

  if (!input.trim()) {
    // Empty clears the setting
    setSetting("base_domain", "");
    return c.redirect("/settings?saved=1");
  }

  const normalized = normalizeBaseDomain(input);
  if (!normalized) return c.redirect("/settings");

  setSetting("base_domain", normalized);
  return c.redirect("/settings?saved=1");
});
