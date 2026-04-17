import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";

const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
})();
import { listApps, createApp, deleteApp, getApp } from "../db/apps.js";
import { getEnvVars, setEnvVars, deleteEnvVar } from "../db/env.js";
import { getVolumes, setVolumes, deleteVolume } from "../db/volumes.js";
import { getAppStatsBulk, type AppStats } from "../deploy/stats.js";
import { formatBytes, formatRelative } from "../util/format.js";
import {
  authenticate,
  clearTotp,
  commitTotp,
  countUsers,
  createUser,
  deleteUser,
  getUser,
  getUserByUsername,
  isTotpEnabled,
  listUsers,
  setTotpPending,
} from "../db/users.js";
import { createSession, deleteSession } from "../db/sessions.js";
import {
  createPreauthSession,
  deletePreauthSession,
  getPreauthUserId,
} from "../db/preauth.js";
import { generateTotpSecret, totpUri, verifyTotp } from "../auth/totp.js";
import {
  consumeBackupCode,
  deleteBackupCodes,
  generateBackupCodes,
  getBackupCodeStatus,
  storeBackupCodes,
} from "../auth/backup-codes.js";
import { toDataURL as qrDataUrl } from "qrcode";
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
import { logAudit, getRecentAuditEntries } from "../db/audit.js";
import { updateApp } from "../db/apps.js";
import { writeAppRoute } from "../deploy/gateway.js";
import { appContainerName, destroyApp } from "../deploy/index.js";
import { csrfField } from "../middleware/csrf.js";
import {
  clearAttempts,
  getClientIp,
  isRateLimited,
  recordFailedAttempt,
  remainingLockoutSeconds,
} from "../middleware/rate-limit.js";

export const webRoutes = new Hono<WebEnv>();

/**
 * Did this request reach us over HTTPS? Checks the URL scheme and
 * respects X-Forwarded-Proto from Traefik, which terminates TLS.
 * Used to decide whether to set the Secure flag on session cookies —
 * we want it in production but not in local dev where the dashboard
 * runs on http://localhost:3000.
 */
function isSecureRequest(c: Context): boolean {
  const forwarded = c.req.header("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]?.trim() === "https";
  return new URL(c.req.url).protocol === "https:";
}

const PREAUTH_COOKIE = "runway_preauth";

function sessionCookieOptions(c: Context) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    secure: isSecureRequest(c),
  };
}

function preauthCookieOptions(c: Context) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 5 * 60,
    secure: isSecureRequest(c),
  };
}

// ── Helpers ──────────────────────────────────────────────
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, body: string, opts?: { username?: string; csrf?: string }) {
  const username = opts?.username;
  const csrf = opts?.csrf;
  if (csrf) {
    body = body.replace(
      /(<form\s[^>]*method="POST"[^>]*>)/gi,
      `$1${csrf}`
    );
  }
  const nav = username
    ? `<nav class="nav">
         <a href="/">Apps</a>
         <a href="/users">Users</a>
         <a href="/settings">Settings</a>
         <a href="/audit">Audit</a>
         <a href="/account">Account</a>
         <span class="meta" style="margin-left:0.25rem">v${escapeHtml(APP_VERSION)}</span>
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
          .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: lowercase; }
          .badge-created { background: #1e3a5f; color: #60a5fa; }
          .badge-running { background: #14532d; color: #4ade80; }
          .badge-starting, .badge-building { background: #3b2f00; color: #facc15; }
          .badge-exited, .badge-stopped, .badge-failed { background: #451a03; color: #fb923c; }
          .badge-restarting, .badge-paused { background: #3a1d5f; color: #c084fc; }
          .badge-healthy { background: #14532d; color: #4ade80; }
          .badge-unhealthy { background: #451a03; color: #fb923c; }
          .badge-starting-health { background: #3b2f00; color: #facc15; }
          .stats {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 0.75rem;
            margin-top: 1rem;
            padding: 0.75rem;
            background: #0f0f0f;
            border: 1px solid #262626;
            border-radius: 6px;
          }
          .stat-label {
            color: #737373;
            font-size: 0.7rem;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            margin-bottom: 0.25rem;
          }
          .stat-value {
            font-size: 0.9rem;
            font-weight: 600;
            color: #e5e5e5;
            font-variant-numeric: tabular-nums;
          }
          code { font-family: monospace; background: #262626; padding: 1px 4px; border-radius: 4px; font-size: 0.85rem; }
          @media (max-width: 640px) {
            .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          }
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
          .copy-group { position: relative; display: flex; align-items: stretch; background: #0f0f0f; border: 1px solid #262626; border-radius: 6px; margin-top: 0.5rem; }
          .copy-group code { flex: 1; padding: 0.6rem 0.75rem; background: transparent; border: none; font-size: 0.8rem; white-space: nowrap; overflow-x: auto; display: block; }
          .copy-btn { padding: 0.4rem 0.75rem; background: #262626; border: none; border-left: 1px solid #262626; color: #a3a3a3; cursor: pointer; font-size: 0.75rem; font-family: inherit; border-radius: 0 5px 5px 0; white-space: nowrap; }
          .copy-btn:hover { background: #333; color: #e5e5e5; }
          .app-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.25rem; }
          .app-header h2 { margin: 0; }
          .app-domains { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.25rem; }
          .app-domains a { color: #60a5fa; text-decoration: none; font-size: 0.85rem; }
          .app-domains a:hover { text-decoration: underline; }
          .section-title { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.75rem; margin-top: 1.25rem; color: #a3a3a3; }
        </style>
        <script>
          function confirmDelete(form) {
            var expected = form.getAttribute('data-app-name');
            var input = prompt('Type "' + expected + '" to confirm deletion:');
            if (input !== expected) return false;
            return true;
          }
          function toggleSecret(btn) {
            var code = btn.previousElementSibling;
            if (code.textContent === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022') {
              code.textContent = code.getAttribute('data-value');
              btn.textContent = 'Hide';
            } else {
              code.textContent = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
              btn.textContent = 'Show';
            }
          }
          function copyText(btn) {
            var text = btn.getAttribute('data-copy');
            navigator.clipboard.writeText(text).then(function() {
              var orig = btn.textContent;
              btn.textContent = 'Copied!';
              setTimeout(function() { btn.textContent = orig; }, 1500);
            });
          }
        </script>
      </head>
      <body>
        <div class="container">
          ${raw(nav)}
          ${raw(body)}
        </div>
      </body>
    </html>`;
}

function authLayout(title: string, body: string, csrf?: string) {
  return layout(title, `<div class="auth-card">${body}</div>`, { csrf });
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
    `,
      csrfField(c)
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
  setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(c));
  logAudit(user.id, user.username, "user_created", {
    targetUserId: user.id,
    targetUsername: user.username,
  });
  return c.redirect("/");
});

webRoutes.get("/login", (c) => {
  if (countUsers() === 0) return c.redirect("/setup");
  const error = c.req.query("error");
  const locked = c.req.query("locked");
  const ip = getClientIp(c);
  const remaining = isRateLimited(ip) ? remainingLockoutSeconds(ip) : 0;

  const errorMsg = remaining
    ? `<div class="error">Too many failed attempts. Try again in ${Math.ceil(remaining / 60)} minute${remaining > 60 ? "s" : ""}.</div>`
    : locked
      ? `<div class="error">Too many failed attempts. Try again later.</div>`
      : error
        ? '<div class="error">Invalid username or password.</div>'
        : "";

  return c.html(
    authLayout(
      "Login",
      `
      <h1>Sign in</h1>
      ${errorMsg}
      <form method="POST" action="/login">
        <input type="text" name="username" placeholder="Username" required autofocus />
        <input type="password" name="password" placeholder="Password" required />
        <button type="submit">Sign in</button>
      </form>
    `,
      csrfField(c)
    )
  );
});

webRoutes.post("/login", async (c) => {
  const ip = getClientIp(c);
  if (isRateLimited(ip)) return c.redirect("/login?locked=1");

  const body = await c.req.parseBody();
  const username = (body["username"] as string | undefined)?.trim();
  const password = body["password"] as string | undefined;

  if (!username || !password) {
    recordFailedAttempt(ip);
    return c.redirect("/login?error=1");
  }

  const user = await authenticate(username, password);
  if (!user) {
    recordFailedAttempt(ip);
    logAudit("unknown", username, "login_failed", {
      detail: `IP: ${ip}`,
    });
    return c.redirect("/login?error=1");
  }

  clearAttempts(ip);

  if (isTotpEnabled(user)) {
    const preauth = createPreauthSession(user.id);
    setCookie(c, PREAUTH_COOKIE, preauth.token, preauthCookieOptions(c));
    return c.redirect("/login/2fa");
  }

  const session = createSession(user.id);
  setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(c));
  logAudit(user.id, user.username, "login");
  return c.redirect("/");
});

// ── Second factor ────────────────────────────────────────

webRoutes.get("/login/2fa", (c) => {
  const token = getCookieValue(c, PREAUTH_COOKIE);
  if (!token || !getPreauthUserId(token)) return c.redirect("/login");
  const error = c.req.query("error");
  const locked = c.req.query("locked");
  const ip = getClientIp(c);
  const remaining = isRateLimited(ip) ? remainingLockoutSeconds(ip) : 0;

  const errorMsg = remaining
    ? `<div class="error">Too many failed attempts. Try again in ${Math.ceil(remaining / 60)} minute${remaining > 60 ? "s" : ""}.</div>`
    : locked
      ? `<div class="error">Too many failed attempts. Try again later.</div>`
      : error
        ? '<div class="error">That code did not work. Try again.</div>'
        : "";

  return c.html(
    authLayout(
      "Two-factor authentication",
      `
      <h1>Two-factor code</h1>
      <p class="hint">Enter the 6-digit code from your authenticator, or
        one of your backup codes if you've lost access.</p>
      ${errorMsg}
      <form method="POST" action="/login/2fa">
        <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code"
               placeholder="123456" required autofocus />
        <button type="submit">Verify</button>
      </form>
      <form method="POST" action="/login/2fa/cancel" style="margin-top:0.75rem">
        <button type="submit" class="ghost" style="width:100%">Cancel and sign out</button>
      </form>
    `,
      csrfField(c)
    )
  );
});

webRoutes.post("/login/2fa", async (c) => {
  const ip = getClientIp(c);
  if (isRateLimited(ip)) return c.redirect("/login/2fa?locked=1");

  const token = getCookieValue(c, PREAUTH_COOKIE);
  if (!token) return c.redirect("/login");
  const userId = getPreauthUserId(token);
  if (!userId) {
    deleteCookie(c, PREAUTH_COOKIE, { path: "/" });
    return c.redirect("/login");
  }
  const user = getUser(userId);
  if (!user || !isTotpEnabled(user)) return c.redirect("/login");

  const body = await c.req.parseBody();
  const raw = (body["code"] as string | undefined)?.trim() ?? "";
  const code = raw.replace(/\s+/g, "");

  let ok = false;
  if (/^\d{6}$/.test(code)) {
    ok = verifyTotp(user.totp_secret!, code);
  } else {
    ok = await consumeBackupCode(user.id, code);
  }
  if (!ok) {
    recordFailedAttempt(ip);
    logAudit(user.id, user.username, "2fa_failed", {
      detail: `IP: ${ip}`,
    });
    return c.redirect("/login/2fa?error=1");
  }

  clearAttempts(ip);

  deletePreauthSession(token);
  deleteCookie(c, PREAUTH_COOKIE, { path: "/" });

  const session = createSession(user.id);
  setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(c));
  logAudit(user.id, user.username, "login_2fa");
  return c.redirect("/");
});

webRoutes.post("/login/2fa/cancel", (c) => {
  const token = getCookieValue(c, PREAUTH_COOKIE);
  if (token) deletePreauthSession(token);
  deleteCookie(c, PREAUTH_COOKIE, { path: "/" });
  return c.redirect("/login");
});

webRoutes.post("/logout", (c) => {
  const token = getCookieValue(c, SESSION_COOKIE);
  if (token) deleteSession(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login");
});

function getCookieValue(c: Context, name: string): string | undefined {
  const header = c.req.header("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

// ── Protected routes ─────────────────────────────────────

webRoutes.use("/", requireSession);
webRoutes.use("/apps", requireSession);
webRoutes.use("/apps/*", requireSession);
webRoutes.use("/users", requireSession);
webRoutes.use("/users/*", requireSession);
webRoutes.use("/settings", requireSession);
webRoutes.use("/settings/*", requireSession);
webRoutes.use("/audit", requireSession);
webRoutes.use("/account", requireSession);
webRoutes.use("/account/*", requireSession);

webRoutes.get("/", async (c) => {
  const user = c.get("user");
  const apps = listApps();
  const stats = await getAppStatsBulk(apps);
  const baseDomain = getSetting("base_domain");
  const dashboardDomain = process.env.DASHBOARD_DOMAIN ?? "";

  const appCards = apps
    .map((app, i) => renderAppCard(app, stats[i]!, dashboardDomain))
    .join("");

  return c.html(
    layout(
      "Dashboard",
      `
      <div class="flex between" style="margin-bottom:1.5rem">
        <h1 style="margin:0">Apps</h1>
        <form method="POST" action="/apps" style="margin:0">
          <button type="submit">+ New app</button>
        </form>
      </div>
      ${!baseDomain ? '<p class="hint">No base domain configured. <a href="/settings" style="color:#60a5fa">Set one in settings</a> to get automatic subdomains.</p>' : ""}
      ${apps.length === 0 ? '<p class="meta">No apps yet. Create one to get started.</p>' : appCards}
    `,
      { username: user.username, csrf: csrfField(c) }
    )
  );
});

webRoutes.post("/apps", (c) => {
  createApp();
  return c.redirect("/");
});

function renderAppCard(
  app: ReturnType<typeof listApps>[number],
  stats: AppStats,
  dashboardDomain: string
): string {
  const configured = !!(app.name && app.runtime);
  const title = configured
    ? escapeHtml(app.name!)
    : '<span class="meta">Unconfigured</span>';

  const statBadge = stats.containerState
    ? `badge-${escapeHtml(stats.containerState)}`
    : `badge-${escapeHtml(app.status)}`;
  const statLabel = stats.containerState
    ? escapeHtml(stats.containerState)
    : escapeHtml(app.status);

  const domains: string[] = [];
  if (app.domain) domains.push(app.domain);
  if (app.custom_domain) domains.push(app.custom_domain);
  const domainLinks = domains
    .map(
      (d) =>
        `<a href="https://${encodeURI(d)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d)}</a>`
    )
    .join(" ");

  const llmsTxtUrl = dashboardDomain
    ? `https://${dashboardDomain}/llms.txt`
    : "/llms.txt";
  const claudeInstruction = `Fetch ${llmsTxtUrl} and deploy this project using API key ${app.api_key}`;

  const statsRow = configured
    ? `
      <div class="stats">
        <div>
          <div class="stat-label">Runtime</div>
          <div class="stat-value">${escapeHtml(app.runtime!)}</div>
        </div>
        <div>
          <div class="stat-label">Image</div>
          <div class="stat-value">${formatBytes(stats.imageBytes)}</div>
        </div>
        <div>
          <div class="stat-label">Memory</div>
          <div class="stat-value">${formatBytes(stats.memoryBytes)}</div>
        </div>
        <div>
          <div class="stat-label">Uptime</div>
          <div class="stat-value">${escapeHtml(formatRelative(stats.startedAt))}</div>
        </div>
      </div>
    `
    : "";

  return `
    <div class="card">
      <div class="flex between">
        <div class="app-header">
          <h2>${title}</h2>
          <span class="badge ${statBadge}">${statLabel}</span>
        </div>
        <div class="flex" style="gap:0.5rem">
          <button type="button" class="ghost" style="padding:0.25rem 0.5rem;font-size:0.85rem" data-copy="${escapeHtml(claudeInstruction)}" onclick="copyText(this)">Copy deploy instruction</button>
          ${configured ? `<a href="/apps/${encodeURIComponent(app.id)}" class="ghost" style="color:#a3a3a3;text-decoration:none;font-size:0.85rem;padding:0.25rem 0.5rem;border:1px solid #262626;border-radius:4px">Settings</a>` : ""}
          <form method="POST" action="/apps/${encodeURIComponent(app.id)}/delete" style="margin:0" data-app-name="${escapeHtml(configured ? app.name! : app.id)}" onsubmit="return confirmDelete(this)">
            <button class="danger" type="submit" style="padding:0.25rem 0.5rem;font-size:0.85rem">Delete</button>
          </form>
        </div>
      </div>
      ${domains.length > 0 ? `<div class="app-domains">${domainLinks}</div>` : ""}
      ${statsRow}
      <div class="copy-group" style="margin-top:0.75rem">
        <code>${escapeHtml(app.api_key)}</code>
        <button type="button" class="copy-btn" data-copy="${escapeHtml(app.api_key)}" onclick="copyText(this)">Copy</button>
      </div>
    </div>
  `;
}

webRoutes.post("/apps/:id/delete", async (c) => {
  const app = getApp(c.req.param("id"));
  if (app) {
    await destroyApp(app);
    deleteApp(app.id);
  }
  return c.redirect("/");
});

// ── App detail (env vars + volumes) ─────────────────────

webRoutes.get("/apps/:id", (c) => {
  const user = c.get("user");
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");

  const env = getEnvVars(app.id);
  const volumes = getVolumes(app.id);
  const saved = c.req.query("saved");

  const envRows = Object.entries(env)
    .map(
      ([key, value]) => `
      <tr>
        <td style="padding:0.5rem 0.75rem"><code>${escapeHtml(key)}</code></td>
        <td style="padding:0.5rem 0.75rem">
          <code class="secret-value" data-value="${escapeHtml(value)}">••••••••</code>
          <button type="button" class="ghost" style="padding:0.15rem 0.4rem;font-size:0.7rem;margin-left:0.25rem" onclick="toggleSecret(this)">Show</button>
        </td>
        <td style="padding:0.5rem 0.75rem">
          <form method="POST" action="/apps/${encodeURIComponent(app.id)}/env/${encodeURIComponent(key)}/delete" style="margin:0">
            <button class="danger" type="submit" style="padding:0.25rem 0.5rem;font-size:0.75rem">Delete</button>
          </form>
        </td>
      </tr>`
    )
    .join("");

  const volRows = volumes
    .map(
      (v) => `
      <tr>
        <td style="padding:0.5rem 0.75rem"><code>${escapeHtml(v.mount_path)}</code></td>
        <td style="padding:0.5rem 0.75rem" class="meta">${escapeHtml(v.created_at)}</td>
        <td style="padding:0.5rem 0.75rem">
          <form method="POST" action="/apps/${encodeURIComponent(app.id)}/volumes/delete" style="margin:0">
            <input type="hidden" name="mount_path" value="${escapeHtml(v.mount_path)}" />
            <button class="danger" type="submit" style="padding:0.25rem 0.5rem;font-size:0.75rem">Delete</button>
          </form>
        </td>
      </tr>`
    )
    .join("");

  return c.html(
    layout(
      app.name ?? "App",
      `
      <p style="margin-bottom:1.5rem"><a href="/" style="color:#60a5fa;text-decoration:none">&larr; Back to apps</a></p>
      <h1>${escapeHtml(app.name ?? app.id)}</h1>
      ${saved ? '<div class="card" style="border-color:#14532d;color:#4ade80">Saved.</div>' : ""}

      <div class="card">
        <h2>Custom domain</h2>
        <p class="hint" style="margin:0.5rem 0 1rem">
          Point a CNAME or A record to the Runway server, then enter the domain here.
          Traefik will issue a Let's Encrypt certificate automatically.
        </p>
        <form method="POST" action="/apps/${encodeURIComponent(app.id)}/domain">
          <div class="flex">
            <input type="text" name="custom_domain" value="${escapeHtml(app.custom_domain ?? "")}" placeholder="app.example.com" style="flex:1" />
            <button type="submit">Save</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2>Health check</h2>
        <p class="hint" style="margin:0.5rem 0 1rem">
          HTTP path to probe inside the container every 30 seconds. Leave empty to disable.
          Takes effect on the next deploy.
        </p>
        <form method="POST" action="/apps/${encodeURIComponent(app.id)}/healthcheck">
          <div class="flex">
            <input type="text" name="path" value="${escapeHtml(app.health_check_path ?? "")}" placeholder="/health" style="flex:1" />
            <button type="submit">Save</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2>Environment variables</h2>
        <p class="hint" style="margin:0.5rem 0 1rem">
          Set secrets and configuration here. Changes take effect on the next deploy.
        </p>
        ${
          Object.keys(env).length > 0
            ? `<div style="overflow-x:auto;margin-bottom:1rem">
                <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
                  <thead>
                    <tr style="text-align:left;border-bottom:1px solid #262626">
                      <th style="padding:0.5rem 0.75rem">Key</th>
                      <th style="padding:0.5rem 0.75rem">Value</th>
                      <th style="padding:0.5rem 0.75rem"></th>
                    </tr>
                  </thead>
                  <tbody>${envRows}</tbody>
                </table>
              </div>`
            : '<p class="meta" style="margin-bottom:1rem">No environment variables set.</p>'
        }
        <form method="POST" action="/apps/${encodeURIComponent(app.id)}/env">
          <div class="flex">
            <input type="text" name="key" placeholder="KEY" pattern="[A-Za-z_][A-Za-z0-9_]*" required style="width:12rem" />
            <input type="text" name="value" placeholder="value" required style="flex:1" />
            <button type="submit">Add</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2>Persistent volumes</h2>
        <p class="hint" style="margin:0.5rem 0 1rem">
          Mount paths inside the container that persist across redeploys.
          Data is stored in named Docker volumes. Changes take effect on the next deploy.
        </p>
        ${
          volumes.length > 0
            ? `<div style="overflow-x:auto;margin-bottom:1rem">
                <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
                  <thead>
                    <tr style="text-align:left;border-bottom:1px solid #262626">
                      <th style="padding:0.5rem 0.75rem">Mount path</th>
                      <th style="padding:0.5rem 0.75rem">Added</th>
                      <th style="padding:0.5rem 0.75rem"></th>
                    </tr>
                  </thead>
                  <tbody>${volRows}</tbody>
                </table>
              </div>`
            : '<p class="meta" style="margin-bottom:1rem">No volumes configured.</p>'
        }
        <form method="POST" action="/apps/${encodeURIComponent(app.id)}/volumes">
          <div class="flex">
            <input type="text" name="mount_path" placeholder="/app/data" pattern="/.*" required style="flex:1" />
            <button type="submit">Add</button>
          </div>
        </form>
      </div>
    `,
      { username: user.username, csrf: csrfField(c) }
    )
  );
});

webRoutes.post("/apps/:id/domain", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const raw = (body["custom_domain"] as string | undefined)?.trim().toLowerCase() || null;
  const customDomain = raw && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(raw) ? raw : null;
  updateApp(app.id, { custom_domain: customDomain });
  if (app.domain) {
    await writeAppRoute({
      appId: app.id,
      containerName: appContainerName(app.id),
      domain: app.domain,
      customDomain,
      port: app.port,
    });
  }
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1`);
});

webRoutes.post("/apps/:id/healthcheck", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const path = (body["path"] as string | undefined)?.trim() || null;
  const validPath = path && /^\/[a-zA-Z0-9._\-/?=&%]*$/.test(path) ? path : null;
  updateApp(app.id, { health_check_path: validPath });
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1`);
});

webRoutes.post("/apps/:id/env", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const key = (body["key"] as string | undefined)?.trim();
  const value = body["value"] as string | undefined;
  if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined) {
    setEnvVars(app.id, { [key]: value });
  }
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1`);
});

webRoutes.post("/apps/:id/env/:key/delete", (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  deleteEnvVar(app.id, c.req.param("key"));
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1`);
});

webRoutes.post("/apps/:id/volumes", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const mountPath = (body["mount_path"] as string | undefined)?.trim();
  if (
    mountPath &&
    mountPath !== "/" &&
    !mountPath.includes("..") &&
    /^\/[a-zA-Z0-9._\-/]+$/.test(mountPath)
  ) {
    const existing = getVolumes(app.id).map((v) => v.mount_path);
    if (!existing.includes(mountPath)) {
      setVolumes(app.id, [...existing, mountPath]);
    }
  }
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1`);
});

webRoutes.post("/apps/:id/volumes/delete", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const mountPath = body["mount_path"] as string | undefined;
  if (mountPath) {
    deleteVolume(app.id, mountPath);
  }
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1`);
});

// ── Users management ─────────────────────────────────────

webRoutes.get("/users", (c) => {
  const current = c.get("user");
  const users = listUsers();
  const error = c.req.query("error");

  const rows = users
    .map((u) => {
      const twofa = isTotpEnabled(u)
        ? '<span class="badge badge-running">2FA on</span>'
        : '<span class="badge badge-stopped">2FA off</span>';
      const actions =
        u.id === current.id
          ? '<span class="meta">you</span>'
          : `<div class="flex" style="gap:0.5rem;margin:0">
               ${
                 isTotpEnabled(u)
                   ? `<form method="POST" action="/users/${encodeURIComponent(u.id)}/2fa/reset" style="margin:0" class="flex">
                        <input type="text" name="code" inputmode="numeric" placeholder="Your code" style="width:9rem" ${isTotpEnabled(current) ? "required" : ""} />
                        <button type="submit" class="ghost">Reset 2FA</button>
                      </form>`
                   : ""
               }
               <form method="POST" action="/users/${encodeURIComponent(u.id)}/delete" style="margin:0">
                 <button class="danger" type="submit">Delete</button>
               </form>
             </div>`;
      return `
    <div class="card">
      <div class="flex between">
        <div>
          <div class="flex" style="gap:0.75rem">
            <h2>${escapeHtml(u.username)}</h2>
            ${twofa}
          </div>
          <p class="meta" style="margin-top:0.25rem">Created ${escapeHtml(u.created_at)}</p>
        </div>
        ${actions}
      </div>
    </div>
  `;
    })
    .join("");

  return c.html(
    layout(
      "Users",
      `
      <h1>Users</h1>
      ${error ? '<div class="error">Invalid 2FA code. Please try again.</div>' : ""}
      <form method="POST" action="/users">
        <div class="flex">
          <input type="text" name="username" placeholder="Username" required />
          <input type="password" name="password" placeholder="Password (min 8)" minlength="8" required />
          <button type="submit">Add user</button>
        </div>
      </form>
      ${rows}
    `,
      { username: current.username, csrf: csrfField(c) }
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

  const current = c.get("user");
  const newUser = await createUser(username, password);
  logAudit(current.id, current.username, "user_created", {
    targetUserId: newUser.id,
    targetUsername: newUser.username,
  });
  return c.redirect("/users");
});

webRoutes.post("/users/:id/delete", (c) => {
  const current = c.get("user");
  const id = c.req.param("id");
  if (id === current.id) return c.redirect("/users");
  const target = getUser(id);
  if (!target) return c.redirect("/users");
  deleteUser(id);
  logAudit(current.id, current.username, "user_deleted", {
    targetUserId: target.id,
    targetUsername: target.username,
  });
  return c.redirect("/users");
});

/**
 * Admin reset of another user's 2FA. Useful when someone loses
 * their authenticator and all their backup codes. Intentionally
 * refuses to reset the current user's own 2FA — that has to go
 * through /account so the flow actually requires a current code.
 */
webRoutes.post("/users/:id/2fa/reset", async (c) => {
  const current = c.get("user");
  const id = c.req.param("id");
  if (id === current.id) return c.redirect("/account");

  const target = getUser(id);
  if (!target) return c.redirect("/users");

  if (isTotpEnabled(current)) {
    const body = await c.req.parseBody();
    const code = ((body["code"] as string | undefined) ?? "").trim();
    if (!verifyTotp(current.totp_secret!, code)) {
      return c.redirect("/users?error=1");
    }
  }

  clearTotp(target.id);
  deleteBackupCodes(target.id);
  logAudit(current.id, current.username, "2fa_reset", {
    targetUserId: target.id,
    targetUsername: target.username,
  });
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
      { username: user.username, csrf: csrfField(c) }
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

// ── Audit log ───────────────────────────────────────────

webRoutes.get("/audit", (c) => {
  const user = c.get("user");
  const entries = getRecentAuditEntries(50);

  const rows = entries
    .map((e) => {
      const target =
        e.target_username
          ? `${escapeHtml(e.target_username)}`
          : '<span class="meta">—</span>';
      return `
        <tr>
          <td class="meta">${escapeHtml(e.created_at)}</td>
          <td>${escapeHtml(e.username)}</td>
          <td><code>${escapeHtml(e.action)}</code></td>
          <td>${target}</td>
          <td class="meta">${e.detail ? escapeHtml(e.detail) : "—"}</td>
        </tr>`;
    })
    .join("");

  return c.html(
    layout(
      "Audit log",
      `
      <h1>Audit log</h1>
      <div class="card" style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid #262626">
              <th style="padding:0.5rem 0.75rem">Time</th>
              <th style="padding:0.5rem 0.75rem">User</th>
              <th style="padding:0.5rem 0.75rem">Action</th>
              <th style="padding:0.5rem 0.75rem">Target</th>
              <th style="padding:0.5rem 0.75rem">Detail</th>
            </tr>
          </thead>
          <tbody>
            ${entries.length === 0 ? '<tr><td colspan="5" class="meta" style="padding:0.75rem">No audit entries yet.</td></tr>' : rows}
          </tbody>
        </table>
      </div>
    `,
      { username: user.username, csrf: csrfField(c) }
    )
  );
});

// ── Account (self-service 2FA) ───────────────────────────

webRoutes.get("/account", (c) => {
  const user = c.get("user");
  const enabled = isTotpEnabled(user);
  const backup = enabled ? getBackupCodeStatus(user.id) : null;
  const error = c.req.query("error");

  const twofaCard = enabled
    ? `
      <div class="card">
        <h2>Two-factor authentication</h2>
        <p class="meta" style="margin-top:0.5rem">
          Enabled. You will be asked for a code from your authenticator
          on every sign in.
        </p>
        <p class="meta" style="margin-top:0.5rem">
          Backup codes: <strong>${backup!.unused}</strong> unused of ${backup!.total}.
        </p>
        <div class="flex" style="margin-top:0.75rem;gap:0.5rem">
          <form method="POST" action="/account/2fa/regenerate" style="margin:0">
            <input type="text" name="code" inputmode="numeric"
                   placeholder="Current code" required
                   style="width:9rem" />
            <button type="submit">Regenerate backup codes</button>
          </form>
        </div>
        <form method="POST" action="/account/2fa/disable" style="margin-top:0.75rem">
          <div class="flex">
            <input type="text" name="code" inputmode="numeric"
                   placeholder="Current code" required
                   style="width:9rem" />
            <button class="danger" type="submit">Disable 2FA</button>
          </div>
        </form>
      </div>
    `
    : `
      <div class="card">
        <h2>Two-factor authentication</h2>
        <p class="meta" style="margin-top:0.5rem">
          Not enabled. Add a second factor to harden sign in — any
          authenticator app works (1Password, Google Authenticator,
          Authy, …).
        </p>
        <form method="POST" action="/account/2fa/start" style="margin-top:0.75rem">
          <button type="submit">Enable two-factor authentication</button>
        </form>
      </div>
    `;

  return c.html(
    layout(
      "Account",
      `
      <h1>Account</h1>
      ${error ? '<div class="error">That code did not work. Try again.</div>' : ""}
      <div class="card">
        <h2>${escapeHtml(user.username)}</h2>
        <p class="meta" style="margin-top:0.5rem">
          Member since ${escapeHtml(user.created_at)}
        </p>
      </div>
      ${twofaCard}
    `,
      { username: user.username, csrf: csrfField(c) }
    )
  );
});

/**
 * Start the enable flow: generate a fresh pending secret, render the
 * QR + raw secret, and ask the user to verify a code from their app.
 */
webRoutes.post("/account/2fa/start", async (c) => {
  const user = c.get("user");
  if (isTotpEnabled(user)) return c.redirect("/account");

  const secret = generateTotpSecret();
  setTotpPending(user.id, secret);

  return c.redirect("/account/2fa/verify");
});

webRoutes.get("/account/2fa/verify", async (c) => {
  const user = c.get("user");
  if (isTotpEnabled(user)) return c.redirect("/account");
  if (!user.totp_secret) return c.redirect("/account");

  const uri = totpUri(user.totp_secret, user.username, "Runway");
  const qr = await qrDataUrl(uri, { margin: 1, width: 220 });
  const error = c.req.query("error");

  return c.html(
    layout(
      "Enable 2FA",
      `
      <h1>Enable two-factor authentication</h1>
      <div class="card">
        <h2>1. Scan the QR code</h2>
        <p class="meta" style="margin:0.5rem 0 1rem">
          Open your authenticator app (1Password, Google Authenticator,
          Authy, …) and scan this QR code. Or paste the secret below
          manually.
        </p>
        <img src="${qr}" alt="TOTP QR code" style="background:#fff;padding:0.5rem;border-radius:6px" />
        <p class="meta" style="margin-top:0.75rem">
          Secret: <span class="key">${escapeHtml(user.totp_secret)}</span>
        </p>
      </div>
      <div class="card">
        <h2>2. Enter the 6-digit code</h2>
        ${error ? '<div class="error" style="margin-top:0.75rem">That code did not match. Make sure your device clock is correct and try again.</div>' : ""}
        <form method="POST" action="/account/2fa/verify" style="margin-top:0.75rem">
          <div class="flex">
            <input type="text" name="code" inputmode="numeric"
                   autocomplete="one-time-code"
                   placeholder="123456" required autofocus
                   style="width:9rem" />
            <button type="submit">Verify and enable</button>
          </div>
        </form>
        <form method="POST" action="/account/2fa/cancel" style="margin-top:0.5rem">
          <button type="submit" class="ghost">Cancel</button>
        </form>
      </div>
    `,
      { username: user.username, csrf: csrfField(c) }
    )
  );
});

webRoutes.post("/account/2fa/verify", async (c) => {
  const user = c.get("user");
  if (isTotpEnabled(user)) return c.redirect("/account");
  if (!user.totp_secret) return c.redirect("/account");

  const body = await c.req.parseBody();
  const code = ((body["code"] as string | undefined) ?? "").trim();
  if (!verifyTotp(user.totp_secret, code)) {
    return c.redirect("/account/2fa/verify?error=1");
  }

  commitTotp(user.id);
  const codes = generateBackupCodes(10);
  await storeBackupCodes(user.id, codes);
  logAudit(user.id, user.username, "2fa_enabled");

  return c.html(
    layout(
      "Backup codes",
      `
      <h1>Two-factor authentication enabled</h1>
      <div class="card">
        <h2>Save these backup codes</h2>
        <p class="meta" style="margin-top:0.5rem">
          Each code can be used exactly once to sign in if you lose
          access to your authenticator. <strong>This is the only time
          they will be shown</strong> — store them somewhere safe
          (e.g. your password manager). You can generate new ones
          later from the account page, which invalidates the old set.
        </p>
        <pre style="margin-top:1rem;padding:1rem;background:#0f0f0f;border:1px solid #262626;border-radius:6px;font-family:monospace;font-size:0.95rem;line-height:1.6">${codes.map((c) => escapeHtml(c)).join("\n")}</pre>
        <div style="margin-top:1rem">
          <a href="/account" style="color:#60a5fa">I've saved them — back to account</a>
        </div>
      </div>
    `,
      { username: user.username, csrf: csrfField(c) }
    )
  );
});

webRoutes.post("/account/2fa/cancel", (c) => {
  const user = c.get("user");
  if (!isTotpEnabled(user)) clearTotp(user.id);
  return c.redirect("/account");
});

webRoutes.post("/account/2fa/disable", async (c) => {
  const user = c.get("user");
  if (!isTotpEnabled(user)) return c.redirect("/account");

  const body = await c.req.parseBody();
  const code = ((body["code"] as string | undefined) ?? "").trim();
  const ok =
    verifyTotp(user.totp_secret!, code) ||
    (await consumeBackupCode(user.id, code));
  if (!ok) return c.redirect("/account?error=1");

  clearTotp(user.id);
  deleteBackupCodes(user.id);
  logAudit(user.id, user.username, "2fa_disabled");
  return c.redirect("/account");
});

webRoutes.post("/account/2fa/regenerate", async (c) => {
  const user = c.get("user");
  if (!isTotpEnabled(user)) return c.redirect("/account");

  const body = await c.req.parseBody();
  const code = ((body["code"] as string | undefined) ?? "").trim();
  if (!verifyTotp(user.totp_secret!, code)) {
    return c.redirect("/account?error=1");
  }

  const codes = generateBackupCodes(10);
  await storeBackupCodes(user.id, codes);
  logAudit(user.id, user.username, "backup_codes_regenerated");

  return c.html(
    layout(
      "Backup codes",
      `
      <h1>New backup codes</h1>
      <div class="card">
        <h2>Save these backup codes</h2>
        <p class="meta" style="margin-top:0.5rem">
          Your previous backup codes have been invalidated. Store
          these new ones somewhere safe.
        </p>
        <pre style="margin-top:1rem;padding:1rem;background:#0f0f0f;border:1px solid #262626;border-radius:6px;font-family:monospace;font-size:0.95rem;line-height:1.6">${codes.map((c) => escapeHtml(c)).join("\n")}</pre>
        <div style="margin-top:1rem">
          <a href="/account" style="color:#60a5fa">I've saved them — back to account</a>
        </div>
      </div>
    `,
      { username: user.username, csrf: csrfField(c) }
    )
  );
});
