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
import { getAppStats } from "../deploy/stats.js";
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
  isAdmin,
  isTotpEnabled,
  listUsers,
  setPassword,
  setTotpPending,
  setUserRole,
  countAdmins,
  type Role,
  ROLES,
} from "../db/users.js";
import { createSession, deleteAllUserSessions, deleteSession } from "../db/sessions.js";
import {
  createPreauthSession,
  deletePreauthSession,
  getPreauthUserId,
} from "../db/preauth.js";
import { generateTotpSecret, totpUri, verifyTotp } from "../auth/totp.js";
import { verifyPassword } from "../auth/password.js";
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
  deleteSetting,
  normalizeBaseDomain,
} from "../db/settings.js";
import {
  SESSION_COOKIE,
  requireAdmin,
  requireAppAccess,
  requireSession,
  type WebEnv,
} from "../middleware/session.js";
import { logAudit, getRecentAuditEntries } from "../db/audit.js";
import { updateApp } from "../db/apps.js";
import { getLatestDeployWithScan, getLatestDeploys } from "../db/deploys.js";
import { THRESHOLDS, isValidThreshold, effectiveThreshold, getScannerHealth, type Threshold, type ScanResult, type Finding } from "../deploy/scan.js";
import { appBasicAuth, buildHtpasswd, writeAppRoute } from "../deploy/gateway.js";
import { getAppAllowedEmails, addAppAllowedEmail, removeAppAllowedEmail } from "../db/app-emails.js";
import { appContainerName, destroyApp, rollbackApp } from "../deploy/index.js";
import { docker } from "../deploy/docker.js";
import { csrfField } from "../middleware/csrf.js";
import { checkWildcardDns } from "../util/dns-check.js";
import { validateCustomDomain } from "../util/domain.js";
import { assertSafeOutboundUrl } from "../util/ssrf-guard.js";
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
  const baseDomain = getSetting("base_domain");
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    secure: isSecureRequest(c),
    // Set domain-wide cookie when base_domain is configured so the
    // session is readable by forward-auth on app subdomains.
    ...(baseDomain ? { domain: `.${baseDomain}` } : {}),
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

function layout(
  title: string,
  body: string,
  opts?: { username?: string; csrf?: string; isAdmin?: boolean }
) {
  const username = opts?.username;
  const csrf = opts?.csrf;
  const admin = opts?.isAdmin ?? false;
  if (csrf) {
    body = body.replace(
      /(<form\s[^>]*method="POST"[^>]*>)/gi,
      `$1${csrf}`
    );
  }
  const adminLinks = admin
    ? `<a href="/users">Users</a>
         <a href="/settings">Settings</a>
         <a href="/audit">Audit</a>
         <a href="/health">Health</a>`
    : "";
  const nav = username
    ? `<nav class="nav">
         <a href="/" class="nav-brand">&#9992; Runway</a>
         <a href="/">Apps</a>
         ${adminLinks}
         <div class="nav-spacer"></div>
         <span class="nav-meta">v${escapeHtml(APP_VERSION)}</span>
         <span class="nav-meta"><a href="https://github.com/wiggertdehaan/Runway" target="_blank" rel="noopener noreferrer" title="Documentation">Docs</a></span>
         <a href="/account" style="font-weight:400">${escapeHtml(username)}</a>
         <form method="POST" action="/logout" style="display:inline;margin:0">
           ${csrf ?? ""}
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
          :root {
            --bg: #0a0a0a; --bg-card: #171717; --bg-inset: #0f0f0f;
            --border: #262626; --text: #e5e5e5; --text-muted: #8a8a8a; --text-dim: #6a6a6a;
            --brand: #60a5fa; --brand-hover: #3b82f6;
            --status-success: #4ade80; --status-success-bg: #14532d;
            --status-warn: #fbbf24; --status-warn-bg: #3b2f00;
            --status-error: #f87171; --status-error-bg: #7f1d1d;
            --status-info: #60a5fa; --status-info-bg: #1e3a5f;
            --status-neutral: #a3a3a3; --status-neutral-bg: #262626;
          }
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 2rem; }
          h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 1.5rem; letter-spacing: -0.01em; }
          h2 { font-size: 1.1rem; }
          .container { max-width: 960px; margin: 0 auto; }
          .app-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1rem; }
          @media (max-width: 500px) { .app-grid { grid-template-columns: 1fr; } }
          .app-card { display: flex; flex-direction: column; border-left: 3px solid var(--border); }
          .app-card.status-running { border-left-color: var(--status-success); }
          .app-card.status-building, .app-card.status-starting { border-left-color: var(--status-warn); }
          .app-card.status-failed, .app-card.status-exited { border-left-color: var(--status-error); }
          .app-card.status-created { border-left-color: var(--status-info); }
          .overflow-menu { position: relative; }
          .overflow-menu summary { list-style: none; cursor: pointer; color: var(--text-dim); font-size: 1.1rem; padding: 0.1rem 0.4rem; border-radius: 4px; line-height: 1; }
          .overflow-menu summary:hover { color: var(--text); background: var(--border); }
          .overflow-menu summary::-webkit-details-marker { display: none; }
          .overflow-menu[open] .overflow-dropdown { display: block; }
          .overflow-dropdown { display: none; position: absolute; right: 0; top: 100%; z-index: 10; background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 0.25rem; min-width: 180px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
          .overflow-dropdown button, .overflow-dropdown .overflow-item { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--text-muted); font-size: 0.8rem; padding: 0.4rem 0.75rem; cursor: pointer; border-radius: 4px; font-family: inherit; }
          .overflow-dropdown button:hover, .overflow-dropdown .overflow-item:hover { background: var(--border); color: var(--text); }
          .overflow-dropdown .overflow-danger:hover { color: var(--status-error); }
          .dashboard-filter { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
          .dashboard-filter input[type="search"] { flex: 1; min-width: 180px; }
          .nav { display: flex; gap: 1rem; align-items: center; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); }
          .nav a { color: var(--text); text-decoration: none; font-weight: 500; }
          .nav a:hover { color: var(--brand); }
          .nav-brand { font-weight: 700; font-size: 1.1rem; letter-spacing: -0.02em; margin-right: 0.75rem; color: var(--text) !important; }
          .nav-brand:hover { color: var(--brand) !important; }
          .nav-meta { font-size: 0.75rem; color: var(--text-dim); }
          .nav-meta a { color: var(--text-dim); font-weight: 400; font-size: 0.75rem; }
          .nav-meta a:hover { color: var(--text-muted); }
          .nav-spacer { flex: 1; }
          .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
          .tabs { display: flex; flex-wrap: wrap; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 1rem; }
          .tabs input[type="radio"] { display: none; }
          .tabs label { padding: 0.6rem 1.2rem; cursor: pointer; color: var(--text-dim); border-bottom: 3px solid transparent; font-size: 0.95rem; font-weight: 500; transition: color 0.15s; }
          .tabs label:hover { color: var(--text); }
          .tabs input:checked + label { color: var(--text); border-bottom-color: var(--brand); }
          .tab-panel { display: none; }
          #tab-deploys:checked ~ .tab-panels .panel-deploys,
          #tab-access:checked ~ .tab-panels .panel-access,
          #tab-config:checked ~ .tab-panels .panel-config,
          #tab-general:checked ~ .tab-panels .panel-general,
          #tab-security:checked ~ .tab-panels .panel-security,
          #tab-sso:checked ~ .tab-panels .panel-sso { display: block; }
          .card h2 { margin-bottom: 0.5rem; }
          .meta { color: var(--text-muted); font-size: 0.85rem; }
          .key { font-family: monospace; background: var(--border); padding: 2px 6px; border-radius: 4px; font-size: 0.85rem; word-break: break-all; }
          .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: lowercase; }
          .badge-created { background: var(--status-info-bg); color: var(--status-info); }
          .badge-running { background: var(--status-success-bg); color: var(--status-success); }
          .badge-starting, .badge-building { background: var(--status-warn-bg); color: var(--status-warn); }
          .badge-exited, .badge-stopped, .badge-failed { background: var(--status-error-bg); color: var(--status-error); }
          .badge-restarting, .badge-paused { background: #3a1d5f; color: #c084fc; }
          .badge-healthy { background: var(--status-success-bg); color: var(--status-success); }
          .badge-unhealthy { background: var(--status-error-bg); color: var(--status-error); }
          .badge-starting-health { background: var(--status-warn-bg); color: var(--status-warn); }
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
          .auth-card { max-width: 400px; margin: 0 auto; min-height: calc(100vh - 8rem); display: flex; flex-direction: column; justify-content: center; }
          .auth-card input { width: 100%; margin-bottom: 0.75rem; }
          .auth-card button[type="submit"] { width: 100%; }
          .auth-brand { text-align: center; margin-bottom: 2rem; }
          .auth-brand h1 { font-size: 2rem; margin-bottom: 0.25rem; }
          .auth-brand p { color: var(--text-muted); font-size: 0.9rem; }
          .error { background: #451a1a; border: 1px solid #dc2626; color: #fca5a5; padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; font-size: 0.9rem; }
          .hint { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1rem; }
          .feature-body { transition: opacity 0.15s; }
          .feature-body.disabled { opacity: 0.35; pointer-events: none; }
          .settings-layout { display: grid; grid-template-columns: 180px 1fr; gap: 2rem; }
          .settings-nav { position: sticky; top: 2rem; align-self: start; display: flex; flex-direction: column; gap: 0.25rem; }
          .settings-nav a { color: var(--text-dim); text-decoration: none; font-size: 0.85rem; padding: 0.4rem 0.75rem; border-radius: 4px; transition: color 0.15s, background 0.15s; }
          .settings-nav a:hover { color: var(--text); background: var(--bg-card); }
          .settings-nav a.active { color: var(--brand); background: var(--bg-card); }
          @media (max-width: 700px) { .settings-layout { grid-template-columns: 1fr; } .settings-nav { position: static; flex-direction: row; flex-wrap: wrap; } }
          .health-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.75rem; }
          .health-tile { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; display: flex; align-items: flex-start; gap: 0.75rem; }
          .health-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 0.3rem; flex-shrink: 0; }
          .health-dot.ok { background: var(--status-success); }
          .health-dot.warn { background: var(--status-warn); }
          .health-dot.fail { background: var(--status-error); }
          .copy-group { position: relative; display: flex; align-items: stretch; background: #0f0f0f; border: 1px solid #262626; border-radius: 6px; margin-top: 0.5rem; }
          .copy-group code { flex: 1; padding: 0.6rem 0.75rem; background: transparent; border: none; font-size: 0.8rem; white-space: nowrap; overflow-x: auto; display: block; }
          .copy-btn { padding: 0.4rem 0.75rem; background: #262626; border: none; border-left: 1px solid #262626; color: #a3a3a3; cursor: pointer; font-size: 0.75rem; font-family: inherit; border-radius: 0 5px 5px 0; white-space: nowrap; }
          .copy-btn:hover { background: #333; color: #e5e5e5; }
          .app-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.25rem; }
          .app-header h2 { margin: 0; }
          .app-domain { color: #60a5fa; text-decoration: none; font-size: 0.8rem; display: block; margin-bottom: 0.25rem; }
          .app-domain:hover { text-decoration: underline; }
          .section-title { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.75rem; margin-top: 1.25rem; color: #a3a3a3; }
        </style>
        <script>
          function filterApps() {
            var q = (document.getElementById('app-search') || {}).value || '';
            q = q.toLowerCase();
            var cards = document.querySelectorAll('.app-card[data-name]');
            var shown = 0;
            cards.forEach(function(c) {
              var match = !q || c.getAttribute('data-name').toLowerCase().indexOf(q) !== -1
                || (c.getAttribute('data-domain') || '').toLowerCase().indexOf(q) !== -1;
              c.style.display = match ? '' : 'none';
              if (match) shown++;
            });
            var empty = document.getElementById('no-match');
            if (empty) empty.style.display = shown === 0 && q ? '' : 'none';
          }
          document.addEventListener('click', function(e) {
            document.querySelectorAll('.overflow-menu[open]').forEach(function(m) {
              if (!m.contains(e.target)) m.removeAttribute('open');
            });
          });
          function featureToggle(checkbox) {
            var body = checkbox.closest('.card').querySelector('.feature-body');
            if (body) { body.classList.toggle('disabled', !checkbox.checked); }
          }
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
  return layout(
    title,
    `<div class="auth-card">
      <div class="auth-brand">
        <h1>&#9992; Runway</h1>
        <p>Deploy AI apps to your own server</p>
      </div>
      ${body}
    </div>`,
    { csrf }
  );
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

  const user = await createUser(username, password, "admin");

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
  return c.redirect("/?welcome=1");
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

  const returnTo = c.req.query("return_to") ?? "";
  const returnParam = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";

  const hasGoogle = !!getSetting("oauth_google_client_id");
  const hasMicrosoft = !!getSetting("oauth_microsoft_client_id");

  const oauthButtons = (hasGoogle || hasMicrosoft)
    ? `<div style="margin-top:1rem;border-top:1px solid #333;padding-top:1rem">
        ${hasGoogle ? `<a href="/auth/google${returnParam}" style="display:block;text-align:center;padding:0.6rem;margin-bottom:0.5rem;background:#1a73e8;color:#fff;text-decoration:none;border-radius:4px;font-size:0.9rem">Sign in with Google</a>` : ""}
        ${hasMicrosoft ? `<a href="/auth/microsoft${returnParam}" style="display:block;text-align:center;padding:0.6rem;background:#0078d4;color:#fff;text-decoration:none;border-radius:4px;font-size:0.9rem">Sign in with Microsoft</a>` : ""}
      </div>`
    : "";

  const oauthError = error === "oauth_state" || error === "oauth_no_code" || error === "oauth_exchange" || error === "oauth_no_email"
    ? '<div class="error">OAuth login failed. Please try again.</div>'
    : "";

  return c.html(
    authLayout(
      "Login",
      `
      <h1>Sign in</h1>
      ${errorMsg}
      ${oauthError}
      <form method="POST" action="/login">
        <input type="text" name="username" placeholder="Username" required autofocus />
        <input type="password" name="password" placeholder="Password" required />
        <button type="submit">Sign in</button>
      </form>
      ${oauthButtons}
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
webRoutes.use("/apps/:id", requireAppAccess);
webRoutes.use("/apps/:id/*", requireAppAccess);
webRoutes.use("/users", requireSession);
webRoutes.use("/users/*", requireSession);
webRoutes.use("/users", requireAdmin);
webRoutes.use("/users/*", requireAdmin);
webRoutes.use("/settings", requireSession);
webRoutes.use("/settings/*", requireSession);
webRoutes.use("/settings", requireAdmin);
webRoutes.use("/settings/*", requireAdmin);
webRoutes.use("/audit", requireSession);
webRoutes.use("/audit", requireAdmin);
webRoutes.use("/account", requireSession);
webRoutes.use("/account/*", requireSession);
webRoutes.use("/health", requireSession);
webRoutes.use("/health", requireAdmin);

webRoutes.get("/", (c) => {
  const user = c.get("user");
  const admin = isAdmin(user);
  // Admins see every app; members only see what they created. Apps
  // created before the `created_by` column existed have a NULL
  // creator — treat those as admin-only so nothing leaks.
  const apps = admin
    ? listApps()
    : listApps().filter((a) => a.created_by === user.username);
  const baseDomain = getSetting("base_domain");
  const dashboardDomain = process.env.DASHBOARD_DOMAIN ?? "";

  const appCards = apps
    .map((app) => renderAppCard(app, dashboardDomain))
    .join("");

  return c.html(
    layout(
      "Dashboard",
      `
      ${c.req.query("forbidden") ? '<div class="card" style="border-color:#7f1d1d;color:#fca5a5;margin-bottom:1.5rem"><strong>Not allowed.</strong> That page is admin-only. Ask an administrator if you need access.</div>' : ""}
      ${c.req.query("welcome") ? `
        <div class="card" style="border-color:#14532d;color:#4ade80;margin-bottom:1.5rem">
          <strong>Welcome to Runway!</strong> Your admin account is ready.
          Create your first app below to get started.
        </div>
      ` : ""}
      ${c.req.query("new") ? `
        <div class="card" style="border-color:#1e3a8a;margin-bottom:1.5rem">
          <strong style="color:#93c5fd">New app created.</strong>
          <p style="margin:0.5rem 0 0;font-size:0.9rem;color:#d4d4d4">
            Scroll down to the highlighted card, click
            <em>Copy deploy instruction</em>, and paste it into
            <a href="https://claude.ai/code" target="_blank" rel="noopener noreferrer" style="color:#60a5fa">Claude Code</a>
            inside your project directory. Claude reads your Dockerfile (or generates one),
            packages the project, uploads it, and the server builds &amp; runs the container.
            The app's URL appears on the card once it's live.
          </p>
        </div>
      ` : ""}
      <div class="flex between" style="margin-bottom:1rem">
        <h1 style="margin:0">Apps</h1>
        <form method="POST" action="/apps" style="margin:0">
          <button type="submit" style="width:auto">+ New app</button>
        </form>
      </div>
      ${apps.length > 0 ? (() => {
        const running = apps.filter((a) => a.status === "running").length;
        const failing = apps.filter((a) => ["failed", "exited"].includes(a.status)).length;
        const parts = [`${apps.length} app${apps.length !== 1 ? "s" : ""}`];
        if (running) parts.push(`<span style="color:var(--status-success)">${running} running</span>`);
        if (failing) parts.push(`<span style="color:var(--status-error)">${failing} failing</span>`);
        return `<div style="margin-bottom:1rem">
          <p class="meta">${parts.join(" &middot; ")}</p>
          ${apps.length >= 4 ? `<div class="dashboard-filter" style="margin-top:0.75rem">
            <input type="search" id="app-search" placeholder="Search apps..." oninput="filterApps()" style="font-size:0.85rem" />
          </div>` : ""}
        </div>`;
      })() : ""}
      ${!baseDomain ? '<p class="hint">No base domain configured. <a href="/settings" style="color:var(--brand)">Set one in settings</a> to get automatic subdomains.</p>' : ""}
      ${apps.length === 0 ? `
        <div class="card" style="text-align:center;padding:3rem 2rem">
          <h2 style="margin-bottom:1rem">Get started</h2>
          <p class="hint" style="max-width:500px;margin:0 auto 1.5rem">
            Create your first app to get an API key. Then open your project in
            <a href="https://claude.ai/code" target="_blank" style="color:#60a5fa">Claude Code</a>
            and paste the deploy instruction — Runway handles the rest.
          </p>
          <p style="margin-bottom:1.5rem">
            <strong>1.</strong> Click <em>"+ New app"</em> above<br/>
            <strong>2.</strong> Copy the deploy instruction<br/>
            <strong>3.</strong> Paste it in Claude Code
          </p>
          <p class="meta">
            Need help? Check the <a href="https://github.com/wiggertdehaan/Runway#deploying-an-app" target="_blank" style="color:#60a5fa">deploy guide</a>
            or the <a href="${escapeHtml(dashboardDomain ? "https://" + dashboardDomain + "/llms.txt" : "/llms.txt")}" target="_blank" style="color:#60a5fa">API docs</a>.
          </p>
        </div>
      ` : `<div class="app-grid">${appCards}</div>
      <p id="no-match" class="meta" style="display:none;text-align:center;padding:2rem 0">No apps match your search.</p>`}
    `,
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
    )
  );
});

webRoutes.post("/apps", (c) => {
  const user = c.get("user");
  const app = createApp(user.username);
  return c.redirect(`/?new=${encodeURIComponent(app.id)}`);
});

function renderDeployHistory(
  app: ReturnType<typeof listApps>[number]
): string {
  const deploys = getLatestDeploys(app.id, 7);
  if (deploys.length === 0) {
    return `
      <div class="card" id="deploys">
        <h2>Deploy history</h2>
        <p class="meta">No deploys yet.</p>
      </div>
    `;
  }

  const rows = deploys
    .map((d) => {
      const isCurrent = !!(
        app.image_tag &&
        d.image_tag &&
        d.image_tag === app.image_tag &&
        d.status === "success"
      );
      const statusColor =
        d.status === "success"
          ? "#4ade80"
          : d.status === "blocked"
          ? "#fca5a5"
          : d.status === "warned"
          ? "#fbbf24"
          : d.status === "failed"
          ? "#f87171"
          : "#a3a3a3";
      const statusLabel = escapeHtml(d.status);
      const when = escapeHtml(formatRelative(d.created_at));
      const tagShort = d.image_tag
        ? escapeHtml(d.image_tag.split(":").pop() ?? d.image_tag)
        : '<span class="meta">—</span>';
      const canRollback =
        d.status === "success" && !!d.image_tag && !isCurrent;
      const action = isCurrent
        ? '<span class="meta" style="font-size:0.75rem">current</span>'
        : canRollback
        ? `<form method="POST" action="/apps/${encodeURIComponent(app.id)}/rollback/${d.id}" style="margin:0" onsubmit="return confirm('Restore deploy #${d.id}? The current container will be replaced.');">
             <button type="submit" class="ghost" style="font-size:0.75rem;padding:0.25rem 0.5rem">Restore</button>
           </form>`
        : "";
      return `
        <tr style="border-bottom:1px solid #262626">
          <td style="padding:0.4rem 0.75rem;font-family:monospace;font-size:0.8rem">#${d.id}</td>
          <td style="padding:0.4rem 0.75rem"><span style="color:${statusColor};font-size:0.8rem">${statusLabel}</span></td>
          <td style="padding:0.4rem 0.75rem;font-family:monospace;font-size:0.75rem" title="${escapeHtml(d.image_tag ?? "")}">${tagShort}</td>
          <td style="padding:0.4rem 0.75rem;font-size:0.8rem" class="meta">${when}</td>
          <td style="padding:0.4rem 0.75rem;text-align:right">${action}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="card" id="deploys">
      <h2>Deploy history</h2>
      <p class="hint" style="margin:0.5rem 0 1rem">
        Most recent deploys first. Restoring a previous deploy replaces the
        running container with that image. Env vars, volumes, and domain
        config are preserved.
      </p>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid #262626">
              <th style="padding:0.5rem 0.75rem;font-size:0.8rem">Deploy</th>
              <th style="padding:0.5rem 0.75rem;font-size:0.8rem">Status</th>
              <th style="padding:0.5rem 0.75rem;font-size:0.8rem">Image</th>
              <th style="padding:0.5rem 0.75rem;font-size:0.8rem">When</th>
              <th style="padding:0.5rem 0.75rem"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderScanSection(
  app: ReturnType<typeof listApps>[number],
  admin: boolean
): string {
  const thresholdOptions = THRESHOLDS.map((t) => {
    const selected = app.scan_threshold === t ? " selected" : "";
    const labels: Record<Threshold, string> = {
      none: "None — never block (warn only)",
      low: "Low — block on any finding",
      medium: "Medium — block on medium+ findings",
      high: "High — block on high/critical",
      critical: "Critical — block only on critical",
    };
    return `<option value="${t}"${selected}>${escapeHtml(labels[t])}</option>`;
  }).join("");

  const serverFloor = (getSetting("min_scan_threshold") ?? "none") as Threshold;
  const exempt = !!app.scan_floor_exempt;
  const effective = effectiveThreshold(app.scan_threshold as Threshold, serverFloor, exempt);
  const floorApplies = effective !== app.scan_threshold && serverFloor !== "none";

  const floorNote = floorApplies
    ? `<p style="color:#fbbf24;font-size:0.8rem;margin:0.5rem 0">
         &#9888; Server-wide floor <strong>${escapeHtml(serverFloor)}</strong> raises
         this app's effective threshold above its per-app setting.
       </p>`
    : "";

  const exemptToggle = admin
    ? `<form method="POST" action="/apps/${encodeURIComponent(app.id)}/scan-floor-exempt" style="margin:0.5rem 0 1rem">
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.85rem">
          <input type="checkbox" name="exempt" value="1"${exempt ? " checked" : ""} onchange="this.form.submit()" />
          Exempt from server-wide scan floor
          ${exempt ? '<span class="meta">(using per-app threshold only)</span>' : ""}
        </label>
      </form>`
    : "";

  const latest = getLatestDeployWithScan(app.id);
  let reportHtml = '<p class="meta">No scan has run yet. Deploy the app to generate a report.</p>';
  if (latest?.scan_report) {
    try {
      const report: ScanResult = JSON.parse(latest.scan_report);
      const findings = report.findings ?? [];
      if (findings.length === 0) {
        reportHtml = `<p style="color:#4ade80">&#10003; No findings in deploy #${latest.id} (image <code>${escapeHtml(latest.image_tag ?? "?")}</code>).</p>`;
      } else {
        const sevRank: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
        const threshRank: Record<string, number> = { none: -1, low: 1, medium: 2, high: 3, critical: 4 };
        const effectiveRank = threshRank[effective] ?? -1;

        const relevant = findings.filter(
          (f) => (sevRank[f.severity] ?? 0) >= effectiveRank && effectiveRank > 0
        );
        const below = findings.filter(
          (f) => effectiveRank <= 0 || (sevRank[f.severity] ?? 0) < effectiveRank
        );

        const showAll = effective === "none";
        const visible = showAll
          ? [...findings].sort((a, b) => (sevRank[b.severity] ?? 0) - (sevRank[a.severity] ?? 0))
          : [...relevant].sort((a, b) => (sevRank[b.severity] ?? 0) - (sevRank[a.severity] ?? 0));

        const hasImageFindings = visible.some((f) => f.source === "image");

        const makeRow = (f: Finding) => {
          const isLow = f.severity === "LOW" || f.severity === "UNKNOWN";
          const opacity = isLow ? "opacity:0.5" : "";
          return `
          <tr style="${opacity}">
            <td style="padding:0.4rem 0.6rem"><span class="badge badge-${
              f.severity === "CRITICAL" || f.severity === "HIGH"
                ? "failed"
                : "stopped"
            }" style="font-size:0.65rem">${escapeHtml(f.severity)}</span></td>
            <td style="padding:0.4rem 0.6rem;font-size:0.75rem">${escapeHtml(f.source)}</td>
            <td style="padding:0.4rem 0.6rem;font-size:0.75rem"><code>${escapeHtml(f.id)}</code></td>
            <td style="padding:0.4rem 0.6rem;font-size:0.75rem">${
              f.pkg ? `<code>${escapeHtml(f.pkg)}${f.version ? `@${escapeHtml(f.version)}` : ""}</code>` : escapeHtml(f.location ?? "")
            }</td>
            <td style="padding:0.4rem 0.6rem;font-size:0.75rem">${
              f.fixedVersion ? `<code>${escapeHtml(f.fixedVersion)}</code>` : '<span class="meta">—</span>'
            }</td>
            <td style="padding:0.4rem 0.6rem;font-size:0.75rem">${escapeHtml(f.title ?? "")}</td>
          </tr>`;
        };

        const rows = visible.slice(0, 50).map(makeRow).join("");
        const more =
          visible.length > 50
            ? `<p class="meta" style="margin-top:0.5rem">Showing first 50 of ${visible.length} findings at this threshold.</p>`
            : "";

        // Summarize below-threshold findings
        const belowCounts: Record<string, number> = {};
        for (const f of below) {
          belowCounts[f.severity] = (belowCounts[f.severity] ?? 0) + 1;
        }
        const belowParts = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"]
          .filter((s) => (belowCounts[s] ?? 0) > 0)
          .map((s) => `${belowCounts[s]} ${s.toLowerCase()}`);
        const belowSummary =
          belowParts.length > 0 && !showAll
            ? `<p class="meta" style="margin-top:0.5rem;opacity:0.7">Below threshold (not shown): ${belowParts.join(", ")}.</p>`
            : "";

        const imageHint = hasImageFindings
          ? `<p class="hint" style="font-size:0.75rem;margin-top:0.5rem;opacity:0.7">
              Findings with source <strong>image</strong> come from OS packages
              in the base Docker image, not from your code. Update the base image
              tag in your Dockerfile or add <code>RUN apk upgrade</code> /
              <code>RUN apt-get update &amp;&amp; apt-get upgrade -y</code> to fix them.
            </p>`
          : "";

        reportHtml = `
          <p class="meta" style="margin-bottom:0.5rem">Deploy #${latest.id} — status <strong>${escapeHtml(report.status)}</strong> — ${report.counts.critical} critical, ${report.counts.high} high, ${report.counts.medium} medium, ${report.counts.low} low.</p>
          ${visible.length > 0 ? `
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:0.8rem">
              <thead>
                <tr style="text-align:left;border-bottom:1px solid #262626">
                  <th style="padding:0.4rem 0.6rem">Severity</th>
                  <th style="padding:0.4rem 0.6rem">Source</th>
                  <th style="padding:0.4rem 0.6rem">ID</th>
                  <th style="padding:0.4rem 0.6rem">Package / location</th>
                  <th style="padding:0.4rem 0.6rem">Fixed in</th>
                  <th style="padding:0.4rem 0.6rem">Title</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          ${more}` : `<p style="color:#4ade80;margin-bottom:0.5rem">&#10003; No findings at or above the effective threshold.</p>`}
          ${belowSummary}
          ${imageHint}
        `;
      }
    } catch {
      reportHtml = '<p class="meta">Scan report could not be parsed.</p>';
    }
  }

  return `
    <div class="card" id="scan">
      <h2>Security scan</h2>
      <p class="hint" style="margin:0.5rem 0 1rem">
        Every deploy is scanned with Trivy for image vulnerabilities, secrets
        in source, and Dockerfile misconfigurations. Pick the severity at
        which a deploy should be blocked. The scan still runs when set to
        None — you'll just see findings instead of having the deploy halted.
      </p>
      <form method="POST" action="/apps/${encodeURIComponent(app.id)}/scan-threshold" style="margin-bottom:0.5rem">
        <div class="flex">
          <select name="threshold" style="flex:1">${thresholdOptions}</select>
          <button type="submit">Save</button>
        </div>
      </form>
      ${floorNote}
      ${exemptToggle}
      ${reportHtml}
    </div>
  `;
}

function renderScanBadge(app: ReturnType<typeof listApps>[number]): string {
  const latest = getLatestDeployWithScan(app.id);
  if (!latest || !latest.scan_summary) return "";
  let summary: { status?: string; counts?: Record<string, number> };
  try {
    summary = JSON.parse(latest.scan_summary);
  } catch {
    return "";
  }
  const status = summary.status ?? "";
  const c = summary.counts ?? {};
  const crit = c.critical ?? 0;
  const high = c.high ?? 0;
  let label: string;
  let color: string;
  const med = c.medium ?? 0;
  const low = (c.low ?? 0) + (c.unknown ?? 0);
  const other = med + low;
  const otherSuffix = other > 0 ? ` <span style="opacity:0.6">(+${other} other)</span>` : "";
  if (status === "passed") {
    label = "&#10003; secure";
    color = "#14532d;color:#4ade80";
  } else if (status === "blocked") {
    label = `&#10007; blocked: ${crit} crit, ${high} high`;
    color = "#7f1d1d;color:#fca5a5";
  } else if (status === "warned") {
    const serious = crit + high;
    label = serious > 0
      ? `&#9888; ${serious} issue${serious !== 1 ? "s" : ""}${otherSuffix}`
      : `&#9888; ${other} low`;
    color = serious > 0
      ? "#713f12;color:#fbbf24"
      : "#262626;color:#a3a3a3";
  } else {
    label = "scan skipped";
    color = "#262626;color:#737373";
  }
  return `<a href="/apps/${encodeURIComponent(app.id)}#scan" class="badge" style="background:${color};text-decoration:none;font-size:0.7rem">${label}</a>`;
}

function renderAppCard(
  app: ReturnType<typeof listApps>[number],
  dashboardDomain: string
): string {
  const configured = !!(app.name && app.runtime);
  const title = configured
    ? escapeHtml(app.name!)
    : '<span class="meta">Unconfigured</span>';

  const domain = app.custom_domain ?? app.domain;
  const domainLink = domain
    ? `<a href="https://${encodeURI(domain)}" target="_blank" rel="noopener noreferrer" style="color:var(--brand);text-decoration:none;font-size:0.95rem;font-weight:500;display:block;margin-bottom:0.5rem">${escapeHtml(domain)} &#8599;</a>`
    : "";

  const llmsTxtUrl = dashboardDomain
    ? `https://${dashboardDomain}/llms.txt`
    : "/llms.txt";
  const claudeInstruction = `Fetch ${llmsTxtUrl} and deploy this project using API key ${app.api_key}`;

  const statsPlaceholder = configured
    ? `<div hx-get="/apps/${encodeURIComponent(app.id)}/stats" hx-trigger="load" hx-swap="outerHTML">
        <div class="stats" style="grid-template-columns:repeat(4,1fr);gap:0.5rem;padding:0.5rem;margin-top:0.5rem">
          <div><div class="stat-label">Runtime</div><div class="stat-value" style="font-size:0.8rem">${escapeHtml(app.runtime!)}</div></div>
          <div><div class="stat-label">Image</div><div class="stat-value meta" style="font-size:0.8rem">...</div></div>
          <div><div class="stat-label">Memory</div><div class="stat-value meta" style="font-size:0.8rem">...</div></div>
          <div><div class="stat-label">Uptime</div><div class="stat-value meta" style="font-size:0.8rem">...</div></div>
        </div>
      </div>`
    : "";

  const initials = app.created_by
    ? app.created_by.slice(0, 2).toUpperCase()
    : "";
  const avatar = initials
    ? `<span title="${escapeHtml(app.created_by ?? "")}" style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--border);color:var(--text-muted);font-size:0.6rem;font-weight:600;flex-shrink:0">${escapeHtml(initials)}</span>`
    : "";

  const overflowMenu = `
    <details class="overflow-menu">
      <summary>&#8943;</summary>
      <div class="overflow-dropdown">
        ${configured ? `<a href="/apps/${encodeURIComponent(app.id)}" class="overflow-item" style="text-decoration:none">Settings</a>` : ""}
        <button type="button" data-copy="${escapeHtml(claudeInstruction)}" onclick="copyText(this)">Copy deploy instruction</button>
        <button type="button" data-copy="${escapeHtml(app.api_key)}" onclick="copyText(this)">Copy API key</button>
        <form method="POST" action="/apps/${encodeURIComponent(app.id)}/delete" style="margin:0" data-app-name="${escapeHtml(configured ? app.name! : app.id)}" onsubmit="return confirmDelete(this)">
          <button type="submit" class="overflow-danger">Delete app</button>
        </form>
      </div>
    </details>`;

  const unconfiguredBlock = !configured
    ? `<div style="margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--border)">
        <p style="font-size:0.8rem;margin:0 0 0.5rem;color:var(--text-muted)">
          Paste this in <a href="https://claude.ai/code" target="_blank" rel="noopener" style="color:var(--brand)">Claude Code</a>:
        </p>
        <pre style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:0.4rem 0.6rem;margin:0 0 0.5rem;font-size:0.65rem;white-space:pre-wrap;word-break:break-all;color:#d4d4d4;user-select:all">${escapeHtml(claudeInstruction)}</pre>
        <button type="button" style="padding:0.25rem 0.6rem;font-size:0.75rem;width:auto" data-copy="${escapeHtml(claudeInstruction)}" onclick="copyText(this)">Copy</button>
      </div>`
    : "";

  return `
    <div class="card app-card status-${escapeHtml(app.status)}" data-name="${escapeHtml(app.name ?? app.id)}" data-domain="${escapeHtml(domain ?? "")}" data-status="${escapeHtml(app.status)}"${!configured ? ' style="border-color:var(--status-info-bg)"' : ""}>
      <div class="flex between" style="margin-bottom:0.25rem">
        <div style="display:flex;align-items:center;gap:0.5rem;min-width:0">
          ${avatar}
          <h2 style="font-size:1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title}</h2>
          <span class="badge badge-${escapeHtml(app.status)}" hx-get="/apps/${encodeURIComponent(app.id)}/badge" hx-trigger="load" hx-swap="outerHTML">${escapeHtml(app.status)}</span>
          ${configured ? renderScanBadge(app) : ""}
        </div>
        ${overflowMenu}
      </div>
      ${domainLink}
      ${statsPlaceholder}
      ${unconfiguredBlock}
    </div>
  `;
}

webRoutes.get("/apps/:id/stats", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app || !app.runtime) return c.text("");
  const stats = await getAppStats(app);
  return c.html(`
    <div class="stats">
      <div><div class="stat-label">Runtime</div><div class="stat-value">${escapeHtml(app.runtime)}</div></div>
      <div><div class="stat-label">Image</div><div class="stat-value">${formatBytes(stats.imageBytes)}</div></div>
      <div><div class="stat-label">Memory</div><div class="stat-value">${formatBytes(stats.memoryBytes)}</div></div>
      <div><div class="stat-label">Uptime</div><div class="stat-value">${escapeHtml(formatRelative(stats.startedAt))}</div></div>
    </div>
  `);
});

webRoutes.get("/apps/:id/badge", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.text("");
  const stats = await getAppStats(app);
  const state = stats.containerState ?? app.status;
  return c.html(
    `<span class="badge badge-${escapeHtml(state)}">${escapeHtml(state)}</span>`
  );
});

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
  const rollbackError = c.req.query("rollback_error");
  const domainError = c.req.query("domain_error");
  const domainErrorMessage =
    domainError === "conflict"
      ? "That domain is already used by another app."
      : domainError === "reserved"
        ? "That domain is reserved for the control plane or for automatic subdomains."
        : domainError === "format"
          ? "That isn't a valid domain name."
          : null;

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
      ${rollbackError ? `<div class="card" style="border-color:#7f1d1d;color:#fca5a5"><strong>Rollback failed:</strong> ${escapeHtml(rollbackError)}</div>` : ""}

      <div class="tabs">
        <input type="radio" name="app-tab" id="tab-deploys" checked />
        <label for="tab-deploys">Deploys</label>
        <input type="radio" name="app-tab" id="tab-access" />
        <label for="tab-access">Access</label>
        <input type="radio" name="app-tab" id="tab-config" />
        <label for="tab-config">Config</label>

        <div class="tab-panels" style="width:100%">
          <!-- ── Deploys tab ────────────────────────── -->
          <div class="tab-panel panel-deploys">
            ${renderDeployHistory(app)}
            ${renderScanSection(app, isAdmin(user))}
          </div>

          <!-- ── Access tab ─────────────────────────── -->
          <div class="tab-panel panel-access">
            <div class="card">
              <h2>Custom domain</h2>
              <p class="hint" style="margin:0.5rem 0 1rem">
                Point a CNAME or A record to the Runway server, then enter the domain here.
                Traefik will issue a Let's Encrypt certificate automatically.
              </p>
              ${domainErrorMessage ? `<div class="error" style="margin-bottom:0.75rem">${escapeHtml(domainErrorMessage)}</div>` : ""}
              <form method="POST" action="/apps/${encodeURIComponent(app.id)}/domain">
                <div class="flex">
                  <input type="text" name="custom_domain" value="${escapeHtml(app.custom_domain ?? "")}" placeholder="app.example.com" style="flex:1" />
                  <button type="submit">Save</button>
                </div>
              </form>
            </div>

            <div class="card">
              <h2>Basic auth</h2>
              <p class="hint" style="margin:0.5rem 0 1rem">
                Put HTTP basic auth in front of this app at the gateway.
              </p>
              <form method="POST" action="/apps/${encodeURIComponent(app.id)}/basic-auth">
                <label style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem">
                  <input type="checkbox" name="enabled" value="1"${app.basic_auth_enabled ? " checked" : ""} onchange="featureToggle(this)" />
                  Require basic auth
                </label>
                <div class="feature-body${app.basic_auth_enabled ? "" : " disabled"}">
                  <div class="flex" style="margin-bottom:0.5rem">
                    <input type="text" name="username" value="${escapeHtml(app.basic_auth_username ?? "")}" placeholder="username" autocomplete="off" style="flex:1" />
                    <input type="password" name="password" placeholder="${app.basic_auth_enabled ? "leave blank to keep" : "password"}" autocomplete="new-password" style="flex:1" />
                  </div>
                </div>
                <button type="submit" style="margin-top:0.5rem">Save</button>
              </form>
            </div>

            <div class="card" id="sso">
              <h2>SSO protection</h2>
              <p class="hint" style="margin:0.5rem 0 1rem">
                Protect this app with Single Sign-On via the subdomain.${app.sso_enabled && app.basic_auth_enabled ? ' <strong style="color:var(--status-warn)">SSO takes precedence over basic auth.</strong>' : ""}
              </p>
              <form method="POST" action="/apps/${encodeURIComponent(app.id)}/sso">
                <label style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.75rem">
                  <input type="checkbox" name="enabled" value="1"${app.sso_enabled ? " checked" : ""} onchange="featureToggle(this)" />
                  Enable SSO
                </label>
                <div class="feature-body${app.sso_enabled ? "" : " disabled"}">
                  <h3 style="margin:0 0 0.5rem;font-size:0.85rem">Allowed emails</h3>
                  ${(() => {
                    const emails = getAppAllowedEmails(app.id);
                    return emails.length > 0
                      ? `<div style="margin-bottom:0.5rem">${emails.map((e) =>
                          `<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem">
                            <code style="flex:1;font-size:0.8rem">${escapeHtml(e)}</code>
                            <button type="submit" class="ghost" formaction="/apps/${encodeURIComponent(app.id)}/sso/email/delete" formmethod="post" name="email" value="${escapeHtml(e)}" style="font-size:0.7rem;padding:0.15rem 0.4rem;color:var(--status-error)">&times;</button>
                          </div>`
                        ).join("")}</div>`
                      : '<p class="meta" style="margin-bottom:0.5rem;font-size:0.8rem">No emails in allow list.</p>';
                  })()}
                  <div class="flex">
                    <input type="email" name="new_email" placeholder="user@example.com" style="flex:1" />
                  </div>
                </div>
                <button type="submit" style="margin-top:0.5rem">Save</button>
              </form>
            </div>
          </div>

          <!-- ── Config tab ─────────────────────────── -->
          <div class="tab-panel panel-config">
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
          </div>
        </div>
      </div>
    `,
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
    )
  );
});

webRoutes.post("/apps/:id/domain", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const raw = (body["custom_domain"] as string | undefined) ?? "";
  const validation = validateCustomDomain(raw, app.id);
  if (!validation.ok) {
    return c.redirect(
      `/apps/${encodeURIComponent(app.id)}?domain_error=${validation.error}`
    );
  }
  const updated = updateApp(app.id, { custom_domain: validation.domain });
  if (updated?.domain) {
    await writeAppRoute({
      appId: updated.id,
      containerName: appContainerName(updated.id),
      domain: updated.domain,
      customDomain: updated.custom_domain,
      port: updated.port,
      basicAuth: appBasicAuth(updated),
      ssoEnabled: !!updated.sso_enabled,
    });
  }
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1`);
});

webRoutes.post("/apps/:id/rollback/:deployId", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const deployId = parseInt(c.req.param("deployId"), 10);
  if (Number.isNaN(deployId)) {
    return c.redirect(`/apps/${encodeURIComponent(app.id)}?error=bad_deploy_id#deploys`);
  }
  try {
    await rollbackApp(app, deployId);
    return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#deploys`);
  } catch (err: any) {
    const msg = encodeURIComponent(err?.message ?? "rollback failed");
    return c.redirect(
      `/apps/${encodeURIComponent(app.id)}?rollback_error=${msg}#deploys`
    );
  }
});

webRoutes.post("/apps/:id/basic-auth", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const enabled = body["enabled"] === "1";
  const username = ((body["username"] as string | undefined) ?? "").trim();
  const password = (body["password"] as string | undefined) ?? "";

  let patch: Parameters<typeof updateApp>[1];
  if (!enabled) {
    patch = {
      basic_auth_enabled: 0,
      basic_auth_username: null,
      basic_auth_htpasswd: null,
    };
  } else {
    if (!username || !/^[A-Za-z0-9._\-@]+$/.test(username)) {
      return c.redirect(
        `/apps/${encodeURIComponent(app.id)}?error=basic_auth_username#basic-auth`
      );
    }
    // Empty password while already enabled keeps the existing hash
    // (lets users rename or leave untouched without re-entering it).
    const keepExisting =
      password.length === 0 && app.basic_auth_enabled && app.basic_auth_htpasswd;
    if (!keepExisting && password.length < 6) {
      return c.redirect(
        `/apps/${encodeURIComponent(app.id)}?error=basic_auth_password#basic-auth`
      );
    }
    patch = {
      basic_auth_enabled: 1,
      basic_auth_username: username,
      basic_auth_htpasswd: keepExisting
        ? app.basic_auth_htpasswd
        : buildHtpasswd(username, password),
    };
  }

  const updated = updateApp(app.id, patch);
  if (updated?.domain) {
    await writeAppRoute({
      appId: updated.id,
      containerName: appContainerName(updated.id),
      domain: updated.domain,
      customDomain: updated.custom_domain,
      port: updated.port,
      basicAuth: appBasicAuth(updated),
      ssoEnabled: !!updated.sso_enabled,
    });
  }
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1`);
});

webRoutes.post("/apps/:id/scan-threshold", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const threshold = body["threshold"] as string | undefined;
  if (isValidThreshold(threshold)) {
    updateApp(app.id, { scan_threshold: threshold });
  }
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#scan`);
});

webRoutes.post("/apps/:id/scan-floor-exempt", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.redirect("/");
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const exempt = body["exempt"] === "1" ? 1 : 0;
  updateApp(app.id, { scan_floor_exempt: exempt });
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#scan`);
});

webRoutes.post("/apps/:id/sso", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const enabled = body["enabled"] === "1" ? 1 : 0;
  const newEmail = ((body["new_email"] as string | undefined) ?? "").trim().toLowerCase();

  updateApp(app.id, { sso_enabled: enabled });
  if (newEmail && newEmail.includes("@")) {
    addAppAllowedEmail(app.id, newEmail);
  }

  const updated = getApp(app.id);
  if (updated?.domain) {
    await writeAppRoute({
      appId: updated.id,
      containerName: appContainerName(updated.id),
      domain: updated.domain,
      customDomain: updated.custom_domain,
      port: updated.port,
      basicAuth: appBasicAuth(updated),
      ssoEnabled: !!updated.sso_enabled,
    });
  }
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#sso`);
});

webRoutes.post("/apps/:id/sso/email/delete", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const email = (body["email"] as string | undefined) ?? "";
  removeAppAllowedEmail(app.id, email);
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#sso`);
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
  const adminCount = countAdmins();

  const rows = users
    .map((u) => {
      const twofa = isTotpEnabled(u)
        ? '<span class="badge badge-running">2FA on</span>'
        : '<span class="badge badge-stopped">2FA off</span>';
      const roleBadge =
        u.role === "admin"
          ? '<span class="badge badge-running">admin</span>'
          : '<span class="badge badge-stopped">member</span>';
      // Never let the current admin demote themselves or the last
      // remaining admin — doing so would lock user management out.
      const isLastAdmin = u.role === "admin" && adminCount <= 1;
      const canToggleRole = u.id !== current.id && !isLastAdmin;
      const roleToggle = canToggleRole
        ? `<form method="POST" action="/users/${encodeURIComponent(u.id)}/role" style="margin:0">
             <input type="hidden" name="role" value="${u.role === "admin" ? "member" : "admin"}" />
             <button type="submit" class="ghost">${u.role === "admin" ? "Demote to member" : "Promote to admin"}</button>
           </form>`
        : "";
      const actions =
        u.id === current.id
          ? '<span class="meta">you</span>'
          : `<div class="flex" style="gap:0.5rem;margin:0;flex-wrap:wrap">
               ${roleToggle}
               ${
                 isTotpEnabled(u)
                   ? `<form method="POST" action="/users/${encodeURIComponent(u.id)}/2fa/reset" style="margin:0" class="flex">
                        <input type="text" name="code" inputmode="numeric" placeholder="Your code" style="width:9rem" required />
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
          <div class="flex" style="gap:0.75rem;flex-wrap:wrap">
            <h2>${escapeHtml(u.username)}</h2>
            ${roleBadge}
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
      ${
        error === "last_admin"
          ? '<div class="error">Refused: that would leave zero admins. Promote another user first.</div>'
          : error === "needs_2fa"
            ? '<div class="error">Enable 2FA on your own account before resetting it for others.</div>'
            : error
              ? '<div class="error">Invalid 2FA code. Please try again.</div>'
              : ""
      }
      <form method="POST" action="/users">
        <div class="flex">
          <input type="text" name="username" placeholder="Username" required />
          <input type="password" name="password" placeholder="Password (min 8)" minlength="8" required />
          <button type="submit">Add user</button>
        </div>
      </form>
      ${rows}
    `,
      { username: current.username, csrf: csrfField(c), isAdmin: isAdmin(current) }
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
  // Refuse to delete the last remaining admin — otherwise nobody
  // can manage users or server settings afterwards.
  if (target.role === "admin" && countAdmins() <= 1) {
    return c.redirect("/users?error=last_admin");
  }
  deleteUser(id);
  logAudit(current.id, current.username, "user_deleted", {
    targetUserId: target.id,
    targetUsername: target.username,
  });
  return c.redirect("/users");
});

webRoutes.post("/users/:id/role", async (c) => {
  const current = c.get("user");
  const id = c.req.param("id");
  if (id === current.id) return c.redirect("/users");
  const target = getUser(id);
  if (!target) return c.redirect("/users");

  const body = await c.req.parseBody();
  const nextRole = body["role"] as string | undefined;
  if (nextRole !== "admin" && nextRole !== "member") {
    return c.redirect("/users");
  }
  // Never demote the last admin.
  if (target.role === "admin" && nextRole === "member" && countAdmins() <= 1) {
    return c.redirect("/users?error=last_admin");
  }

  setUserRole(target.id, nextRole as Role);
  logAudit(current.id, current.username, "role_changed", {
    targetUserId: target.id,
    targetUsername: target.username,
    detail: `${target.role} -> ${nextRole}`,
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

  // Resetting another user's 2FA is a privileged destructive action: it
  // downgrades that user back to password-only. Require the acting admin
  // to have their own 2FA enabled AND provide a current code, so a freshly
  // created admin account cannot be used to strip 2FA from existing users.
  if (!isTotpEnabled(current)) {
    return c.redirect("/users?error=needs_2fa");
  }
  const body = await c.req.parseBody();
  const code = ((body["code"] as string | undefined) ?? "").trim();
  if (!verifyTotp(current.totp_secret!, code)) {
    return c.redirect("/users?error=1");
  }

  clearTotp(target.id);
  deleteBackupCodes(target.id);
  // Invalidate any active sessions for the target so a stale session
  // cannot continue to act with the pre-reset 2FA trust level.
  deleteAllUserSessions(target.id);
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
  const webhookUrl = getSetting("webhook_url") ?? "";
  const minScanThreshold = getSetting("min_scan_threshold") ?? "none";
  const googleClientId = getSetting("oauth_google_client_id") ?? "";
  const microsoftClientId = getSetting("oauth_microsoft_client_id") ?? "";
  const saved = c.req.query("saved");
  const dnsWarning = c.req.query("dns_warning");
  const error = c.req.query("error");
  const webhookError =
    error === "webhook_bad_scheme"
      ? "Webhook URL must use https://."
      : error === "webhook_private"
        ? "Webhook hostname resolves to an internal or loopback address and was rejected."
        : error === "webhook_dns"
          ? "Could not resolve webhook hostname via DNS."
          : error === "webhook_invalid"
            ? "Webhook URL is not valid."
            : null;

  return c.html(
    layout(
      "Settings",
      `
      <h1>Settings</h1>
      ${saved ? '<div class="card" style="border-color:#14532d;color:#4ade80">Settings saved.</div>' : ""}
      ${dnsWarning ? `<div class="error">${escapeHtml(dnsWarning)}</div>` : ""}
      ${webhookError ? `<div class="error">${escapeHtml(webhookError)}</div>` : ""}

      <div class="settings-layout">
        <nav class="settings-nav">
          <a href="#domain">Base domain</a>
          <a href="#notifications">Notifications</a>
          <a href="#scan-floor">Scan floor</a>
          <a href="#sso">Single Sign-On</a>
        </nav>
        <div>
          <div class="card" id="domain">
            <h2>Base domain</h2>
            <p class="hint" style="margin:0.5rem 0 1rem">
              Wildcard domain for app subdomains. Point <span class="key">*.your-domain</span> to this server.
            </p>
            <form method="POST" action="/settings">
              <div class="flex">
                <input type="text" name="base_domain" value="${escapeHtml(baseDomain)}" placeholder="runway.example.com" style="flex:1" />
                <button type="submit">Save</button>
              </div>
            </form>
          </div>

          <div class="card" id="notifications">
            <h2>Deploy notifications</h2>
            <p class="hint" style="margin:0.5rem 0 1rem">
              Webhook URL called on deploy failure. Works with Slack, Discord, ntfy.
            </p>
            <form method="POST" action="/settings/webhook">
              <div class="flex">
                <input type="url" name="webhook_url" value="${escapeHtml(webhookUrl)}" placeholder="https://hooks.slack.com/..." style="flex:1" />
                <button type="submit">Save</button>
              </div>
            </form>
          </div>

          <div class="card" id="scan-floor">
            <h2>Scan floor</h2>
            <p class="hint" style="margin:0.5rem 0 1rem">
              Server-wide minimum severity at which deploys are blocked.
              Apps can be stricter but not looser. Admins can exempt individual apps.
            </p>
            <form method="POST" action="/settings/scan-floor">
              <div class="flex">
                <select name="threshold" style="flex:1">
                  ${THRESHOLDS.map((t) => {
                    const sel = t === minScanThreshold ? " selected" : "";
                    const labels: Record<string, string> = {
                      none: "None — no server-wide floor",
                      low: "Low — block on any finding",
                      medium: "Medium — block on medium+",
                      high: "High — block on high/critical",
                      critical: "Critical — block only on critical",
                    };
                    return `<option value="${t}"${sel}>${escapeHtml(labels[t] ?? t)}</option>`;
                  }).join("")}
                </select>
                <button type="submit">Save</button>
              </div>
            </form>
          </div>

          <div class="card" id="sso">
            <h2>Single Sign-On</h2>
            <p class="hint" style="margin:0.5rem 0 1rem">
              OAuth2 providers for dashboard login and per-app SSO.
            </p>

            <details style="margin-bottom:1rem;background:var(--bg-inset);padding:0.75rem 1rem;border-radius:6px;border:1px solid var(--border)">
              <summary style="cursor:pointer;font-size:0.85rem;font-weight:500;color:var(--brand)">
                ${googleClientId ? "&#9679; Google — Connected" : "&#9675; Google — Not configured"}
              </summary>
              <div style="margin-top:0.75rem;font-size:0.8rem;line-height:1.6;color:var(--text-muted)">
                <ol style="margin:0 0 0.75rem 1.25rem">
                  <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener" style="color:var(--brand)">Google Cloud Console</a></li>
                  <li>Create OAuth client ID (type: Web application)</li>
                  <li>Redirect URI: <code style="font-size:0.75rem">${escapeHtml(baseDomain ? `https://${baseDomain}/auth/google/callback` : "(set base domain first)")}</code></li>
                </ol>
                <form method="POST" action="/settings/oauth/google">
                  <div style="display:grid;gap:0.5rem">
                    <input type="text" name="client_id" value="${escapeHtml(googleClientId)}" placeholder="Client ID" />
                    <input type="password" name="client_secret" value="" placeholder="${googleClientId ? "Secret (leave blank to keep)" : "Client secret"}" autocomplete="new-password" />
                    <div><button type="submit" style="width:auto">Save Google</button></div>
                  </div>
                </form>
              </div>
            </details>

            <details style="background:var(--bg-inset);padding:0.75rem 1rem;border-radius:6px;border:1px solid var(--border)">
              <summary style="cursor:pointer;font-size:0.85rem;font-weight:500;color:var(--brand)">
                ${microsoftClientId ? "&#9679; Microsoft — Connected" : "&#9675; Microsoft — Not configured"}
              </summary>
              <div style="margin-top:0.75rem;font-size:0.8rem;line-height:1.6;color:var(--text-muted)">
                <ol style="margin:0 0 0.75rem 1.25rem">
                  <li>Open <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener" style="color:var(--brand)">Azure Portal</a></li>
                  <li>Register app, add redirect URI (type: Web):<br/><code style="font-size:0.75rem">${escapeHtml(baseDomain ? `https://${baseDomain}/auth/microsoft/callback` : "(set base domain first)")}</code></li>
                  <li>Under Certificates &amp; secrets, create a client secret</li>
                </ol>
                <form method="POST" action="/settings/oauth/microsoft">
                  <div style="display:grid;gap:0.5rem">
                    <input type="text" name="client_id" value="${escapeHtml(microsoftClientId)}" placeholder="Client ID" />
                    <input type="password" name="client_secret" value="" placeholder="${microsoftClientId ? "Secret (leave blank to keep)" : "Client secret"}" autocomplete="new-password" />
                    <div><button type="submit" style="width:auto">Save Microsoft</button></div>
                  </div>
                </form>
              </div>
            </details>
          </div>
        </div>
      </div>
    `,
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
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

  const dns = await checkWildcardDns(normalized);
  if (!dns.ok) {
    return c.redirect(`/settings?saved=1&dns_warning=${encodeURIComponent(dns.message)}`);
  }
  return c.redirect("/settings?saved=1");
});

webRoutes.post("/settings/scan-floor", async (c) => {
  const body = await c.req.parseBody();
  const threshold = body["threshold"] as string | undefined;
  if (isValidThreshold(threshold)) {
    setSetting("min_scan_threshold", threshold);
  }
  return c.redirect("/settings?saved=1");
});

webRoutes.post("/settings/oauth/google", async (c) => {
  const body = await c.req.parseBody();
  const clientId = ((body["client_id"] as string | undefined) ?? "").trim();
  const clientSecret = ((body["client_secret"] as string | undefined) ?? "").trim();
  if (clientId) setSetting("oauth_google_client_id", clientId);
  else deleteSetting("oauth_google_client_id");
  if (clientSecret) setSetting("oauth_google_client_secret", clientSecret);
  // Empty secret keeps existing value (don't wipe on blank)
  return c.redirect("/settings?saved=1");
});

webRoutes.post("/settings/oauth/microsoft", async (c) => {
  const body = await c.req.parseBody();
  const clientId = ((body["client_id"] as string | undefined) ?? "").trim();
  const clientSecret = ((body["client_secret"] as string | undefined) ?? "").trim();
  if (clientId) setSetting("oauth_microsoft_client_id", clientId);
  else deleteSetting("oauth_microsoft_client_id");
  if (clientSecret) setSetting("oauth_microsoft_client_secret", clientSecret);
  return c.redirect("/settings?saved=1");
});

webRoutes.post("/settings/webhook", async (c) => {
  const body = await c.req.parseBody();
  const url = ((body["webhook_url"] as string | undefined) ?? "").trim();
  if (!url) {
    setSetting("webhook_url", "");
    return c.redirect("/settings?saved=1#notifications");
  }
  const check = await assertSafeOutboundUrl(url);
  if (!check.ok) {
    const reason =
      check.error === "bad_scheme"
        ? "webhook_bad_scheme"
        : check.error === "private_target"
          ? "webhook_private"
          : check.error === "dns_failure"
            ? "webhook_dns"
            : "webhook_invalid";
    return c.redirect(`/settings?error=${reason}#notifications`);
  }
  setSetting("webhook_url", url);
  return c.redirect("/settings?saved=1#notifications");
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
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
    )
  );
});

// ── Health check ────────────────────────────────────────

webRoutes.get("/health", async (c) => {
  const user = c.get("user");
  const baseDomain = getSetting("base_domain");

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Docker socket
  try {
    await docker.ping();
    checks.push({ name: "Docker", ok: true, detail: "Socket reachable" });
  } catch {
    checks.push({ name: "Docker", ok: false, detail: "Cannot reach Docker socket" });
  }

  // BuildKit
  try {
    const bk = docker.getContainer("runway-buildkit");
    const info = await bk.inspect();
    const running = info.State.Status === "running";
    checks.push({
      name: "BuildKit",
      ok: running,
      detail: running ? "Running" : `Status: ${info.State.Status}`,
    });
  } catch {
    checks.push({ name: "BuildKit", ok: false, detail: "Container not found" });
  }

  // DNS
  if (baseDomain) {
    const dns = await checkWildcardDns(baseDomain);
    checks.push({ name: "Wildcard DNS", ok: dns.ok, detail: dns.message });
  } else {
    checks.push({ name: "Wildcard DNS", ok: false, detail: "No base domain configured" });
  }

  // Traefik
  try {
    const gw = docker.getContainer("runway-gateway");
    const info = await gw.inspect();
    const running = info.State.Status === "running";
    checks.push({
      name: "Traefik",
      ok: running,
      detail: running ? "Running" : `Status: ${info.State.Status}`,
    });
  } catch {
    checks.push({ name: "Traefik", ok: false, detail: "Container not found" });
  }

  // Security scanner (Trivy). Three checks: binary present, cache volume
  // writable, vulnerability DB present and fresh. Each one can fail
  // independently, so they're separate rows.
  const scanner = await getScannerHealth();
  checks.push({
    name: "Scanner binary",
    ok: scanner.binary.ok,
    detail: scanner.binary.detail,
  });
  checks.push({
    name: "Scanner cache",
    ok: scanner.cache.ok,
    detail: scanner.cache.detail,
  });
  checks.push({
    name: "Vulnerability DB",
    ok: scanner.db.ok,
    detail: scanner.db.detail,
  });

  const allOk = checks.every((ch) => ch.ok);
  const failCount = checks.filter((ch) => !ch.ok).length;
  const summaryText = allOk
    ? `All ${checks.length} components healthy`
    : `${failCount} issue${failCount !== 1 ? "s" : ""} detected`;
  const summaryColor = allOk ? "var(--status-success)" : "var(--status-error)";

  const tiles = checks
    .map(
      (ch) => `
      <div class="health-tile"${!ch.ok ? ' style="border-color:var(--status-error-bg)"' : ""}>
        <div class="health-dot ${ch.ok ? "ok" : "fail"}"></div>
        <div>
          <div style="font-weight:600;font-size:0.9rem;margin-bottom:0.2rem">${escapeHtml(ch.name)}</div>
          <div class="meta" style="font-size:0.8rem">${escapeHtml(ch.detail)}</div>
        </div>
      </div>`
    )
    .join("");

  return c.html(
    layout(
      "Health",
      `
      <div class="flex between" style="margin-bottom:1.5rem">
        <h1 style="margin-bottom:0">System health</h1>
        <span style="color:${summaryColor};font-size:0.85rem;font-weight:500">${summaryText}</span>
      </div>
      <div class="health-grid">${tiles}</div>
    `,
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
    )
  );
});

// ── Account (self-service 2FA) ───────────────────────────

webRoutes.get("/account", (c) => {
  const user = c.get("user");
  const enabled = isTotpEnabled(user);
  const backup = enabled ? getBackupCodeStatus(user.id) : null;
  const error = c.req.query("error");
  const pwError = c.req.query("pw_error");
  const pwSaved = c.req.query("pw_saved");

  const passwordCard = `
    <div class="card">
      <h2>Password</h2>
      <p class="meta" style="margin-top:0.5rem;margin-bottom:0.75rem">
        Changing your password signs you out of other devices.
      </p>
      ${pwSaved ? '<p style="color:#4ade80;margin:0 0 0.75rem">Password updated.</p>' : ""}
      ${pwError === "wrong" ? '<div class="error" style="margin-bottom:0.75rem">Current password is incorrect.</div>' : ""}
      ${pwError === "short" ? '<div class="error" style="margin-bottom:0.75rem">New password must be at least 8 characters.</div>' : ""}
      ${pwError === "mismatch" ? '<div class="error" style="margin-bottom:0.75rem">New passwords do not match.</div>' : ""}
      <form method="POST" action="/account/password">
        <div class="flex" style="flex-direction:column;gap:0.5rem;align-items:stretch">
          <input type="password" name="current_password" placeholder="Current password" autocomplete="current-password" required />
          <input type="password" name="new_password" placeholder="New password (min 8)" autocomplete="new-password" minlength="8" required />
          <input type="password" name="confirm_password" placeholder="Confirm new password" autocomplete="new-password" minlength="8" required />
          <button type="submit" style="align-self:flex-start">Change password</button>
        </div>
      </form>
    </div>
  `;

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
      ${passwordCard}
      ${twofaCard}
    `,
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
    )
  );
});

webRoutes.post("/account/password", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const current = (body["current_password"] as string | undefined) ?? "";
  const next = (body["new_password"] as string | undefined) ?? "";
  const confirm = (body["confirm_password"] as string | undefined) ?? "";

  const ok = await verifyPassword(current, user.password_hash);
  if (!ok) {
    return c.redirect("/account?pw_error=wrong");
  }
  if (next.length < 8) {
    return c.redirect("/account?pw_error=short");
  }
  if (next !== confirm) {
    return c.redirect("/account?pw_error=mismatch");
  }

  await setPassword(user.id, next);

  // Invalidate every existing session (including this one) and mint a
  // fresh one so the current tab stays signed in. Other devices are
  // logged out on their next request.
  deleteAllUserSessions(user.id);
  const oldToken = getCookieValue(c, SESSION_COOKIE);
  if (oldToken) deleteSession(oldToken);
  const session = createSession(user.id);
  setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(c));

  logAudit(user.id, user.username, "password_changed", {
    targetUserId: user.id,
    targetUsername: user.username,
  });

  return c.redirect("/account?pw_saved=1");
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
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
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
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
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
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
    )
  );
});
