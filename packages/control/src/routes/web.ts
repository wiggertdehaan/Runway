import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { HTMX_INTEGRITY, HTMX_PATH } from "./assets.js";
import { APP_CSS } from "../ui/styles.js";
import { CLIENT_JS, PREPAINT_JS } from "../ui/client.js";
import { appStatus, countStates, type AppStatus } from "../ui/status.js";
import { homeChips, needsAttention, renderChips } from "../ui/home.js";
import {
  deployReason,
  mayRebuild,
  rebuildBlockedReason,
  rebuildLine,
  renderKevBlock,
  renderRebuildLine,
} from "../ui/app-page.js";
import { renderMaintenance } from "../ui/maintenance.js";

const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
})();
import { listApps, createApp, deleteApp, getApp, type App } from "../db/apps.js";
import { getEnvVars, setEnvVars, deleteEnvVar } from "../db/env.js";
import { getVolumes, setVolumes, deleteVolume } from "../db/volumes.js";
import {
  createDevToken,
  deleteDevToken,
  listDevTokens,
} from "../db/dev-tokens.js";
import { getAppSkillIds, setAppSkillIds } from "../db/app-skills.js";
import {
  deleteCustomSkill,
  deleteSkillFiles,
  getSkill,
  listAllSkills,
  listEnabledSkills,
  putSkillFile,
  setSkillEnabled,
  upsertSkill,
} from "../db/skills.js";
import {
  bundleSha256,
  fetchSkillBundle,
  isTrustedSource,
  listTrustedOrgs,
  mimeForPath,
  parseSkillSource,
  sourceUrl,
} from "../skills/registry.js";
import yaml from "js-yaml";
import { getAppStats, getAppStatsBulk, type AppStats } from "../deploy/stats.js";
import { formatActivity, formatBytes, formatRelative, type ActivityTone } from "../util/format.js";
import { getBucketsBulk } from "../db/activity.js";

const SPARKLINE_HOURS = 7 * 24;
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
  type User,
  ROLES,
} from "../db/users.js";
import { createSession, deleteAllUserSessions, deleteSession, getSessionUser } from "../db/sessions.js";
import {
  createPreauthSession,
  deletePreauthSession,
  getPreauthUserId,
} from "../db/preauth.js";
import { generateTotpSecret, totpUri } from "../auth/totp.js";
import { verifyAndConsumeTotp } from "../db/totp-history.js";
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
  slugify,
  getMaxUploadMb,
  clampUploadMb,
  MAX_UPLOAD_MB_CEILING,
  getKeepImageVersions,
  clampKeepImageVersions,
  KEEP_IMAGE_VERSIONS_FLOOR,
  KEEP_IMAGE_VERSIONS_CEILING,
} from "../db/settings.js";
import { runCachePrune } from "../deploy/cache-pruner.js";
import {
  RebuildBusyError,
  activeRebuildRun,
  activeRebuildRunId,
  startRebuildRun,
} from "../deploy/rebuild.js";
import {
  SCHEDULE_TZ,
  normalizeTime,
  readSchedule,
  saveSchedule,
} from "../deploy/rebuild-scheduler.js";
import {
  getRebuildRun,
  listRebuildRuns,
  type RebuildAppResult,
  type RebuildRun,
} from "../db/rebuild-runs.js";
import {
  SESSION_COOKIE,
  requireAdmin,
  requireAppAccess,
  requireSession,
  type WebEnv,
} from "../middleware/session.js";
import { logAudit, getRecentAuditEntries } from "../db/audit.js";
import { updateApp } from "../db/apps.js";
import { getLatestDeployWithScan, getLatestDeploys, parseBaseImages } from "../db/deploys.js";
import { describeBaseImage, lineOf, parseImageRef } from "../deploy/base-images.js";
import {
  addNotice,
  deleteExemption,
  getActiveExemption,
  getExemption,
  getQuarantine,
  listNotices,
  listQuarantine,
  setExemption,
} from "../db/quarantine.js";
import { deadlineOf, evaluateAppQuarantine } from "../deploy/quarantine.js";
import { getKevList, kevCacheInfo } from "../deploy/kev.js";
import { notifyAdminWebhook } from "../util/webhook.js";
import { clampQuarantineTermDays, getQuarantineTermDays } from "../db/settings.js";
import { getLatestPeriodicScan, listPeriodicScanAppIds } from "../db/periodic-scans.js";
import {
  renderKevStatus,
  renderSecurityAttention,
  type AtRiskApp,
} from "./security-view.js";
import { rescanApp } from "../deploy/periodic-scanner.js";
import { THRESHOLDS, isValidThreshold, effectiveThreshold, getScannerHealth, type Threshold, type ScanResult, type Finding } from "../deploy/scan.js";
import { appBasicAuth, buildHtpasswd, writeAppRoute } from "../deploy/gateway.js";
import { getAppAllowedEmails, addAppAllowedEmail, removeAppAllowedEmail } from "../db/app-emails.js";
import { appContainerName, destroyApp, rollbackApp } from "../deploy/index.js";
import {
  latestSource,
  sourceForDeploy,
  hasSourceForDeploy,
  SOURCE_RETENTION,
} from "../deploy/source.js";
import { readFile } from "node:fs/promises";
import { docker } from "../deploy/docker.js";
import { csrfField, injectCsrfFields } from "../middleware/csrf.js";
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
    // Same regex as injectCsrfFields(); kept inline because layout
    // already has the rendered csrf string and doesn't need a Context.
    body = body.replace(
      /(<form\s[^>]*method="POST"[^>]*>)/gi,
      `$1${csrf}`
    );
  }
  const icon = (d: string) =>
    `<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const link = (href: string, label: string, d: string) =>
    `<a class="nav-link" href="${href}" title="${label}">${icon(d)}<span class="lb">${label}</span></a>`;
  const adminLinks = admin
    ? [
        link("/rebuild", "Rebuild", '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>'),
        link("/audit", "Audit", '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
        link("/health", "Health", '<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
        link("/users", "Users", '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.5-3.5 3.2-5.5 6.5-5.5s6 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .6 3.3 2.4 3.5 5.2"/>'),
        link("/skills", "Skills", '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
        link("/settings", "Settings", '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
      ].join("")
    : "";
  const themeBtn = (cls: string) =>
    `<button type="button" class="${cls}" data-act="theme" aria-pressed="false" title="Toggle light/dark theme">
       <span class="theme-ic-light">${icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>')}</span>
       <span class="theme-ic-dark">${icon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>')}</span>
       <span class="lb">Theme</span>
     </button>`;
  const mark = `<span class="mark"><svg class="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12 21 4l-5 16-4-6.5z"/><path d="m12 13.5 9-9.5"/></svg></span>`;
  const shell = username
    ? `<div class="shell">
         <aside class="side" aria-label="Sidebar">
           <div class="side-head">
             <a class="brand" href="/">${mark}<span class="lb">Runway</span></a>
             <button type="button" class="menu-btn" id="menubtn" aria-label="Menu" aria-expanded="false" aria-controls="side-body">${icon('<path d="M4 7h16M4 12h16M4 17h16"/>')}</button>
           </div>
           <div class="side-body" id="side-body">
             <nav class="side-nav" aria-label="Main">
               ${link("/", "Apps", '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>')}
               ${adminLinks}
             </nav>
             <div class="side-foot">
               <div class="side-meta">v${escapeHtml(APP_VERSION)} &middot; <a href="https://github.com/wiggertdehaan/Runway" target="_blank" rel="noopener noreferrer" title="Documentation">Docs</a></div>
               ${themeBtn("side-btn")}
               <button type="button" class="side-btn collapse-btn" data-act="collapse" aria-expanded="true" title="Collapse sidebar">${icon('<path class="collapse-ic" d="m15 6-6 6 6 6"/>')}<span class="lb">Collapse</span></button>
               <a class="side-user" href="/account" title="Account"><span class="av" aria-hidden="true">${escapeHtml(username.slice(0, 1).toUpperCase())}</span><span class="lb">${escapeHtml(username)}</span></a>
               <form method="POST" action="/logout">
                 ${csrf ?? ""}
                 <button type="submit" class="side-btn" title="Log out">${icon('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>')}<span class="lb">Logout</span></button>
               </form>
             </div>
           </div>
         </aside>
         <main class="main" id="main"><div class="page">${body}</div></main>
       </div>`
    : `<div class="bare-top">${themeBtn("side-btn")}</div>
       <main class="page" id="main">${body}</main>`;

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light dark" />
        <title>${title} - Runway</title>
        <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230a0a0a'/%3E%3Cpath d='M7 16 25 8l-5 17-4-7z' fill='none' stroke='%23fff' stroke-width='2' stroke-linejoin='round'/%3E%3C/svg%3E" />
        <script>${raw(PREPAINT_JS)}</script>
        <script src="${HTMX_PATH}" integrity="${HTMX_INTEGRITY}"></script>
        <style>${raw(APP_CSS)}</style>
      </head>
      <body>
        <a class="skip" href="#main">Skip to content</a>
        ${raw(shell)}
        <script>${raw(CLIENT_JS)}</script>
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
    ? `<div style="margin-top:1rem;border-top:1px solid var(--line2);padding-top:1rem">
        ${hasGoogle ? `<a href="/auth/google${returnParam}" style="display:block;text-align:center;padding:0.6rem;margin-bottom:0.5rem;background:#1a73e8;color:#fff;text-decoration:none;border-radius:4px;font-size:0.9rem">Sign in with Google</a>` : ""}
        ${hasMicrosoft ? `<a href="/auth/microsoft${returnParam}" style="display:block;text-align:center;padding:0.6rem;background:#0078d4;color:#fff;text-decoration:none;border-radius:4px;font-size:0.9rem">Sign in with Microsoft</a>` : ""}
      </div>`
    : "";

  const oauthError = error === "oauth_state" || error === "oauth_no_code" || error === "oauth_exchange" || error === "oauth_no_email" || error === "oauth_nonce"
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
    ok = verifyAndConsumeTotp(user.id, user.totp_secret!, code);
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
webRoutes.use("/partials/*", requireSession);
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
webRoutes.use("/skills", requireSession);
webRoutes.use("/skills/*", requireSession);
webRoutes.use("/skills", requireAdmin);
webRoutes.use("/skills/*", requireAdmin);
webRoutes.use("/account", requireSession);
webRoutes.use("/account/*", requireSession);
webRoutes.use("/rebuild", requireSession);
webRoutes.use("/rebuild", requireAdmin);
webRoutes.use("/rebuild/*", requireSession);
webRoutes.use("/rebuild/*", requireAdmin);
webRoutes.use("/health", requireSession);
webRoutes.use("/health", requireAdmin);

/** "auto-patched" / "auto-minor 1.29→1.30" badge for a used base image, or "". */
function baseBadge(b: { image: string; auto_patched_from?: string; auto_minor_from?: string }): string {
  if (b.auto_minor_from) {
    const to = lineOf(parseImageRef(b.image)?.tag ?? "") ?? "?";
    return ` <span class="badge badge-running" title="Escalated to a newer minor line because a vulnerability could not be fixed in ${escapeHtml(b.auto_minor_from)}">auto-minor ${escapeHtml(b.auto_minor_from)}&rarr;${escapeHtml(to)}</span>`;
  }
  if (b.auto_patched_from) {
    return ` <span class="badge badge-running" title="Raised automatically from ${escapeHtml(b.auto_patched_from)}">auto-patched</span>`;
  }
  return "";
}

function fmtUtc(iso: string | null | undefined): string {
  if (!iso) return "?";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?";
}

/**
 * Apps (out of the given ones) that are in a KEV grace term or
 * quarantined, keyed by app id, in the shape the dashboard views take.
 */
function collectAtRisk(apps: App[]): Map<string, AtRiskApp> {
  const rows = new Map(listQuarantine().map((r) => [r.app_id, r]));
  const termMs = getQuarantineTermDays() * 86_400_000;
  const out = new Map<string, AtRiskApp>();
  for (const a of apps) {
    const q = rows.get(a.id);
    if (!q) continue;
    out.set(a.id, {
      id: a.id,
      name: a.name ?? a.id,
      owner: a.created_by,
      state: q.state,
      cves: Object.keys(q.kev_first_seen),
      deadline: deadlineOf(q, termMs),
      quarantinedAt: q.quarantined_at,
      exemptUntil: getActiveExemption(a.id)?.until ?? null,
    });
  }
  return out;
}

/** App-page section: quarantine status, exemption, owner notices. */
function renderQuarantineSection(app: App, admin: boolean): string {
  const q = getQuarantine(app.id);
  const ex = getExemption(app.id);
  const exActive = !!getActiveExemption(app.id);
  const notices = listNotices(app.id, 10);
  if (!q && !ex && notices.length === 0) return "";
  const termMs = getQuarantineTermDays() * 86_400_000;

  const status = q
    ? q.state === "quarantined"
      ? `<p><span class="badge badge-quarantined">quarantined</span> since ${escapeHtml(fmtUtc(q.quarantined_at))}. Visitors see a maintenance page; the container is stopped, data and volumes are kept. It comes back online automatically when a rebuild or deploy resolves ${escapeHtml(Object.keys(q.kev_first_seen).join(", "))}.</p>`
      : `<p><span class="badge badge-building">term running</span> Actively exploited: ${escapeHtml(Object.keys(q.kev_first_seen).join(", "))}. Fix it before ${escapeHtml(fmtUtc(deadlineOf(q, termMs)))} or the app is taken offline.</p>`
    : "";
  const exemption = ex
    ? `<p class="meta">Exemption ${exActive ? "active" : "expired"}: until ${escapeHtml(fmtUtc(ex.until))}, by ${escapeHtml(ex.granted_by)}. Reason: ${escapeHtml(ex.reason)}</p>`
    : "";
  const forms =
    admin && (q || ex)
      ? `<details class="exempt"${ex && exActive ? " open" : ""}>
          <summary>${exActive ? "Change or remove the exemption" : "Give this app more time (exemption)"}</summary>
          <p class="hint">An exemption postpones taking the app offline until the date you pick. It needs a reason and is kept in the audit log.</p>
          <form method="POST" action="/apps/${encodeURIComponent(app.id)}/quarantine-exception" style="display:grid;gap:0.5rem;max-width:32rem;margin:0.5rem 0">
            <input type="text" name="reason" required minlength="5" maxlength="500" placeholder="Reason (required, kept in the audit log)" />
            <label class="meta">Until <input type="date" name="until" required /></label>
            <div><button type="submit" style="width:auto">${exActive ? "Update" : "Grant"} exemption</button></div>
          </form>
          ${ex ? `<form method="POST" action="/apps/${encodeURIComponent(app.id)}/quarantine-exception/remove" style="margin:0"><button type="submit" class="ghost" style="width:auto">Remove exemption</button></form>` : ""}
        </details>`
      : "";
  const list = notices.length
    ? `<ul style="margin:0.5rem 0 0 1.25rem">${notices
        .map((n) => `<li><span class="meta">${escapeHtml(formatRelative(n.created_at))}</span> ${escapeHtml(n.message)}</li>`)
        .join("")}</ul>`
    : "";
  return `<div class="card" id="quarantine">
    <h2>Security notices</h2>
    ${status}${exemption}${forms}${list}
  </div>`;
}

/**
 * HTML for the apps area of the dashboard. Rendered inline on first
 * page load and swapped in every few seconds via
 * `GET /partials/apps` so new deploys, status transitions, and
 * memory/cpu changes surface without a manual refresh.
 *
 * The search input is marked with `hx-preserve` so its value and
 * focus survive every swap. After each swap the dashboard script
 * re-runs `filterApps()` against the fresh cards.
 */
async function renderAppsLive(
  user: User,
  dashboardDomain: string
): Promise<string> {
  const admin = isAdmin(user);
  const apps = admin
    ? listApps()
    : listApps().filter((a) => a.created_by === user.username);
  // Pre-fetch live container state + memory + image size for every
  // app so each card renders with real values inline. Without this
  // the outer swap would paint "..." placeholders that a second
  // round-trip then fills in — visible flicker on every 5s refresh.
  const allStats = await getAppStatsBulk(apps);
  const buckets = getBucketsBulk(
    apps.map((a) => a.id),
    SPARKLINE_HOURS
  );
  const now = Date.now();
  const atRisk = collectAtRisk(apps);
  const statuses = apps.map((app, i) =>
    statusOf(app, allStats[i] ?? null, atRisk.get(app.id), now)
  );
  const appRows = apps
    .map((app, i) =>
      renderAppRow(
        app,
        dashboardDomain,
        allStats[i] ?? null,
        {
          lastRequestAt: app.last_request_at,
          buckets: buckets.get(app.id) ?? [],
        },
        statuses[i],
        admin
      )
    )
    .join("");

  // Unconfigured apps (no name or runtime yet) have no state: they count
  // in "All" and in nothing else.
  const configuredIdx = apps.map((a, i) => (a.name && a.runtime ? i : -1)).filter((i) => i >= 0);
  const chips = homeChips(
    countStates(configuredIdx.map((i) => statuses[i])),
    configuredIdx.filter((i) => needsAttention(statuses[i])).length,
    apps.length - configuredIdx.length
  );

  // The search input is rendered (and preserved) whenever there are
  // any apps, not only past the old >=4 threshold, so its value
  // survives live updates even if the app count briefly dips.
  const filterBlock =
    apps.length > 0
      ? `<div class="dashboard-filter" id="app-search-wrap" hx-preserve="true">
          <input type="search" id="app-search" placeholder="Search apps..." oninput="filterApps()" style="font-size:0.85rem" />
        </div>`
      : "";

  const header =
    apps.length > 0
      ? `<div class="apps-bar">
          ${renderChips(chips)}
          ${filterBlock}
        </div>`
      : "";

  const body =
    apps.length === 0
      ? `<div class="card" style="text-align:center;padding:3rem 2rem">
          <h2 style="margin-bottom:1rem">Get started</h2>
          <p class="hint" style="max-width:500px;margin:0 auto 1.5rem">
            Create your first app to get an API key. Then open your project in
            <a href="https://claude.ai/code" target="_blank" style="color:var(--tx)">Claude Code</a>
            and paste the deploy instruction — Runway handles the rest.
          </p>
          <p style="margin-bottom:1.5rem">
            <strong>1.</strong> Click <em>"+ New app"</em> above<br/>
            <strong>2.</strong> Copy the deploy instruction<br/>
            <strong>3.</strong> Paste it in Claude Code
          </p>
          <p class="meta">
            Need help? Check the <a href="https://github.com/wiggertdehaan/Runway#deploying-an-app" target="_blank" style="color:var(--tx)">deploy guide</a>
            or the <a href="${escapeHtml(dashboardDomain ? "https://" + dashboardDomain + "/llms.txt" : "/llms.txt")}" target="_blank" style="color:var(--tx)">API docs</a>.
          </p>
        </div>`
      : `<table class="apps-tbl">
          <thead><tr><th>App</th><th>Status</th><th>Address</th><th>Runtime</th><th>Traffic, 7 days</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${appRows}</tbody>
        </table>
         <p id="no-match" class="meta" style="display:none;text-align:center;padding:2rem 0">No apps match your filter.</p>`;

  const scannedIds = listPeriodicScanAppIds();
  const runningApps = apps.filter((a) => a.status === "running");
  const kevStatus = renderKevStatus(
    kevCacheInfo(),
    {
      running: runningApps.length,
      scanned: runningApps.filter((a) => scannedIds.has(a.id)).length,
    },
    atRisk.size,
    now,
    admin
  );

  return `${renderSecurityAttention([...atRisk.values()], now, admin)}${header}${kevStatus}${body}`;
}

webRoutes.get("/", async (c) => {
  const user = c.get("user");
  const baseDomain = getSetting("base_domain");
  const dashboardDomain = process.env.DASHBOARD_DOMAIN ?? "";
  const appsHtml = await renderAppsLive(user, dashboardDomain);

  return c.html(
    layout(
      "Dashboard",
      `
      ${c.req.query("forbidden") ? '<div class="card" style="border-color:var(--err);color:var(--err);margin-bottom:1.5rem"><strong>Not allowed.</strong> That page is admin-only. Ask an administrator if you need access.</div>' : ""}
      ${c.req.query("welcome") ? `
        <div class="card" style="border-color:var(--ok);color:var(--ok);margin-bottom:1.5rem">
          <strong>Welcome to Runway!</strong> Your admin account is ready.
          Create your first app below to get started.
        </div>
      ` : ""}
      ${c.req.query("new") ? `
        <div class="card" style="border-color:var(--line2);margin-bottom:1.5rem">
          <strong style="color:var(--tx)">New app created.</strong>
          <p style="margin:0.5rem 0 0;font-size:0.9rem;color:var(--tx)">
            Scroll down to the highlighted card, click
            <em>Copy deploy instruction</em>, and paste it into
            <a href="https://claude.ai/code" target="_blank" rel="noopener noreferrer" style="color:var(--tx)">Claude Code</a>
            inside your project directory. Claude reads your Dockerfile (or generates one),
            packages the project, uploads it, and the server builds &amp; runs the container.
            The app's URL appears on the card once it's live.
          </p>
        </div>
      ` : ""}
      <div class="flex between" style="margin-bottom:1rem;align-items:flex-start;flex-wrap:wrap;gap:0.75rem">
        <h1 style="margin:0">Apps</h1>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.5rem">
          <div class="flex" style="gap:0.5rem;flex-wrap:wrap;justify-content:flex-end">
            <form method="POST" action="/apps" style="margin:0">
              ${csrfField(c)}
              <button type="submit" style="width:auto">+ New app</button>
            </form>
            <details style="margin:0">
              <summary class="ghost" style="cursor:pointer;display:inline-block;padding:0.5rem 0.85rem;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:0.85rem;list-style:none">+ with skills&hellip;</summary>
            </details>
          </div>
          <form method="POST" action="/apps" id="new-app-with-skills" style="display:none;margin:0;padding:1rem 1.25rem;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;min-width:360px;max-width:480px">
            ${csrfField(c)}
            ${renderCreateAppSkillPicker(listEnabledSkills())}
            <div class="flex" style="gap:0.5rem;margin-top:0.85rem;justify-content:flex-end">
              <button type="submit" style="width:auto">Create with selected skills</button>
            </div>
            <p class="meta" style="font-size:0.7rem;margin:0.6rem 0 0;line-height:1.4">
              You can revisit this list anytime on the app's detail
              page. Built-in skills are reachable over MCP for every
              app — this list only prioritises which skills the agent
              reads first for this app.
            </p>
          </form>
        </div>
      </div>
      <script>
        // Show the skill-picker panel when "with skills…" is opened.
        // Uses native <details> as the trigger; the actual form lives
        // outside <details> so the panel renders inline (no absolute
        // overlay) and stays full width on narrow screens.
        document.querySelectorAll('details > summary').forEach((s) => {
          if (s.textContent && s.textContent.includes('with skills')) {
            const det = s.parentElement;
            const form = document.getElementById('new-app-with-skills');
            if (det && form) {
              det.addEventListener('toggle', () => {
                form.style.display = det.open ? 'block' : 'none';
              });
            }
          }
        });
      </script>
      ${!baseDomain && isAdmin(user) ? '<p class="hint">No base domain configured. <a href="/settings" style="color:var(--brand)">Set one in settings</a> to get automatic subdomains.</p>' : ""}
      <div id="apps-live" hx-get="/partials/apps" hx-trigger="every 5s" hx-swap="innerHTML">
        ${appsHtml}
      </div>
    `,
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
    )
  );
});

webRoutes.get("/partials/apps", async (c) => {
  const user = c.get("user");
  const dashboardDomain = process.env.DASHBOARD_DOMAIN ?? "";
  const html = await renderAppsLive(user, dashboardDomain);
  // Partials don't go through layout(), so inject CSRF tokens here
  // ourselves — the dashboard refresh swaps these cards in every 5s
  // and their delete forms need a fresh hidden _csrf input.
  return c.html(injectCsrfFields(html, c));
});

webRoutes.post("/apps", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody({ all: true });
  const raw = body["skill_ids"];
  const requested = Array.isArray(raw)
    ? (raw.filter((v) => typeof v === "string") as string[])
    : typeof raw === "string"
      ? [raw]
      : [];
  const enabled = new Set(listEnabledSkills().map((s) => s.id));
  const valid = requested.filter((id) => enabled.has(id));

  const app = createApp(user.username);
  if (valid.length > 0) {
    setAppSkillIds(app.id, valid);
  }
  return c.redirect(`/?new=${encodeURIComponent(app.id)}`);
});

/**
 * Skill multiselect rendered into the "+ with skills…" panel on the
 * dashboard. Built-in skills (lifecycle helpers like runway-bootstrap
 * and runway-deploy) are pre-checked because they apply to every
 * app; curated and custom skills start unchecked so the admin can
 * opt them in deliberately. Each row is one line with a small (i)
 * tooltip carrying the SKILL.md description, so the panel stays
 * compact even with a dozen skills enabled.
 */
function renderCreateAppSkillPicker(skills: ReturnType<typeof listEnabledSkills>): string {
  if (skills.length === 0) {
    return `<p class="meta" style="margin:0;font-size:0.8rem">No skills configured yet — create the app and configure them later.</p>`;
  }
  const rows = skills
    .map((s) => {
      const tooltip = s.description
        ? `<span title="${escapeHtml(s.description)}" style="display:inline-block;width:1rem;height:1rem;line-height:1rem;text-align:center;font-size:0.7rem;border:1px solid var(--border);border-radius:50%;color:var(--text-muted);cursor:help;flex-shrink:0">i</span>`
        : "";
      return `
        <label style="display:flex;gap:0.5rem;align-items:center;font-size:0.85rem;cursor:pointer;padding:0.2rem 0">
          <input type="checkbox" name="skill_ids" value="${escapeHtml(s.id)}" ${s.layer === "builtin" ? "checked" : ""} />
          <strong style="flex-shrink:0">${escapeHtml(s.name)}</strong>
          <span class="meta" style="font-size:0.65rem;text-transform:uppercase;letter-spacing:0.04em;flex-shrink:0">${escapeHtml(s.layer)}</span>
          ${tooltip}
        </label>`;
    })
    .join("");
  return `
    <strong style="font-size:0.85rem">Skills for this app</strong>
    <div style="display:flex;flex-direction:column;gap:0.15rem;margin-top:0.5rem;max-height:280px;overflow-y:auto">
      ${rows}
    </div>
  `;
}

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
          ? "var(--ok)"
          : d.status === "blocked"
          ? "var(--err)"
          : d.status === "warned"
          ? "var(--warn)"
          : d.status === "failed"
          ? "var(--err)"
          : "var(--mu)";
      const statusLabel = escapeHtml(d.status);
      const when = escapeHtml(formatRelative(d.created_at));
      const tagShort = d.image_tag
        ? escapeHtml(d.image_tag.split(":").pop() ?? d.image_tag)
        : '<span class="meta">—</span>';
      const bases = parseBaseImages(d);
      const baseCell = bases.length
        ? bases
            .map((b) => {
              const short = b.image.replace(/^docker\.io\/(library\/)?/, "");
              return `<div style="font-family:monospace;font-size:0.72rem" title="${escapeHtml(describeBaseImage(b))} — ${escapeHtml(b.digest)}">${escapeHtml(short)}${baseBadge(b)}</div>`;
            })
            .join("")
        : '<span class="meta" style="font-size:0.75rem">—</span>';
      const sourceCell = hasSourceForDeploy(app.id, d.id)
        ? `<a href="/apps/${encodeURIComponent(app.id)}/source?deploy=${d.id}" class="ghost" style="font-size:0.75rem;padding:0.25rem 0.5rem;text-decoration:none">Download</a>`
        : '<span class="meta" style="font-size:0.75rem">—</span>';
      const canRollback =
        d.status === "success" && !!d.image_tag && !isCurrent;
      const action = isCurrent
        ? '<span class="meta" style="font-size:0.75rem">current</span>'
        : canRollback
        ? `<form method="POST" action="/apps/${encodeURIComponent(app.id)}/rollback/${d.id}" style="margin:0" onsubmit="return confirm('Restore deploy #${d.id}? The current container will be replaced.');">
             <button type="submit" class="ghost" style="font-size:0.75rem;padding:0.25rem 0.5rem">Restore</button>
           </form>`
        : "";
      const reason = deployReason(d);
      return `
        <tr style="border-bottom:1px solid var(--line)">
          <td style="padding:0.4rem 0.75rem;font-family:monospace;font-size:0.8rem">#${d.id}</td>
          <td style="padding:0.4rem 0.75rem"><span style="color:${statusColor};font-size:0.8rem">${statusLabel}</span>${reason ? `<div class="meta deploy-reason">${escapeHtml(reason)}${d.status === "blocked" ? ' <a href="#scan">See findings</a>' : ""}</div>` : ""}</td>
          <td style="padding:0.4rem 0.75rem;font-family:monospace;font-size:0.75rem" title="${escapeHtml(d.image_tag ?? "")}">${tagShort}</td>
          <td style="padding:0.4rem 0.75rem">${baseCell}</td>
          <td style="padding:0.4rem 0.75rem;font-size:0.8rem" class="meta">${when}</td>
          <td style="padding:0.4rem 0.75rem">${sourceCell}</td>
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
        config are preserved. Download pulls that deploy's source tarball
        (the last ${SOURCE_RETENTION} snapshots are kept).
      </p>
      <div style="overflow-x:auto">
        <table class="deploys-table" style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid var(--line)">
              <th style="padding:0.5rem 0.75rem;font-size:0.8rem">Deploy</th>
              <th style="padding:0.5rem 0.75rem;font-size:0.8rem">Status</th>
              <th style="padding:0.5rem 0.75rem;font-size:0.8rem">Image</th>
              <th style="padding:0.5rem 0.75rem;font-size:0.8rem">Base image</th>
              <th style="padding:0.5rem 0.75rem;font-size:0.8rem">When</th>
              <th style="padding:0.5rem 0.75rem;font-size:0.8rem">Source</th>
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
  admin: boolean,
  canRebuild = false,
  rebuildDisabledReason: string | null = null
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
    ? `<p style="color:var(--warn);font-size:0.8rem;margin:0.5rem 0">
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

  const periodic = getLatestPeriodicScan(app.id);
  let periodicHtml = "";
  if (periodic) {
    let counts: Partial<ScanResult["counts"]> = {};
    try {
      const parsed = JSON.parse(periodic.scan_summary) as { counts?: ScanResult["counts"] };
      counts = parsed.counts ?? {};
    } catch {
      /* keep counts empty */
    }
    const when = formatRelative(periodic.created_at);
    const summary = periodic.error
      ? `error: ${escapeHtml(periodic.error)}`
      : `${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.medium ?? 0} medium, ${counts.low ?? 0} low`;
    const stale = periodic.image_tag !== app.image_tag
      ? ` <span class="meta" style="font-size:0.7rem">(against <code>${escapeHtml(periodic.image_tag)}</code>, app now on <code>${escapeHtml(app.image_tag ?? "?")}</code>)</span>`
      : "";
    periodicHtml = `
      <p class="meta" style="margin:0.5rem 0;font-size:0.8rem">
        Last background rescan ${escapeHtml(when)} — ${summary}${stale}.
      </p>`;
  } else {
    periodicHtml = `
      <p class="meta" style="margin:0.5rem 0;font-size:0.8rem">
        No background rescan yet. The scheduler reruns Trivy daily on
        every running app's current image to surface CVEs published
        after the deploy gate ran.
      </p>`;
  }
  const rescanButton =
    admin && app.image_tag && app.status === "running"
      ? `<form method="POST" action="/apps/${encodeURIComponent(app.id)}/rescan" style="margin:0 0 0.5rem">
          <button type="submit" class="ghost" style="font-size:0.8rem;padding:0.3rem 0.7rem">Rescan now</button>
        </form>`
      : "";

  // Rebuild is for the owner as well as the admin; the switches below stay admin-only.
  const rebuildButton = canRebuild
    ? `<form method="POST" action="/apps/${encodeURIComponent(app.id)}/rebuild" style="margin:0 0 0.5rem" onsubmit="return confirm('Rebuild this app from source without cache? It can take a few minutes.')">
        <button type="submit" class="ghost" style="font-size:0.8rem;padding:0.3rem 0.7rem">Rebuild (no cache)</button>
      </form>`
    : rebuildDisabledReason
      ? `<p class="meta" style="margin:0 0 0.5rem;font-size:0.8rem">${escapeHtml(rebuildDisabledReason)}</p>`
      : "";

  // Five switches, each posting to the same admin-only endpoint as before.
  // Owners see the state read-only.
  const rebuildControls = app.image_tag ? renderMaintenance(app, admin) : "";

  const latest = getLatestDeployWithScan(app.id);
  let reportHtml = '<p class="meta">No scan has run yet. Deploy the app to generate a report.</p>';
  if (latest?.scan_report) {
    try {
      const report: ScanResult = JSON.parse(latest.scan_report);
      const findings = report.findings ?? [];
      if (findings.length === 0) {
        reportHtml = `<p style="color:var(--ok)">&#10003; No findings in deploy #${latest.id} (image <code>${escapeHtml(latest.image_tag ?? "?")}</code>).</p>`;
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
                <tr style="text-align:left;border-bottom:1px solid var(--line)">
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
          ${more}` : `<p style="color:var(--ok);margin-bottom:0.5rem">&#10003; No findings at or above the effective threshold.</p>`}
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
      ${periodicHtml}
      ${rescanButton}
      ${rebuildButton}
      ${rebuildControls}
      ${reportHtml}
    </div>
  `;
}

/**
 * The app's one status, from everything the dashboard already knows:
 * the database row, Docker's live container state, the KEV term and the
 * latest deploy's scan summary.
 */
function statusOf(
  app: ReturnType<typeof listApps>[number],
  stats: AppStats | null,
  kev: AtRiskApp | undefined,
  now: number
): AppStatus {
  return appStatus({
    dbStatus: app.status,
    containerState: stats?.containerState ?? null,
    kev,
    scanSummary: getLatestDeployWithScan(app.id)?.scan_summary ?? null,
    now,
  });
}

/** The status word with a coloured dot; the reason (if any) is the tooltip. */
function renderStatusChip(s: AppStatus): string {
  const title = s.reason ? ` title="${escapeHtml(s.reason)}"` : "";
  return `<span class="st st-${s.state}"${title}><span class="dot" aria-hidden="true"></span>${escapeHtml(s.label)}</span>`;
}

/** The single security chip, linking to where the details live. Empty when there is nothing to say. */
function renderSecurityChip(appId: string, s: AppStatus): string {
  const c = s.security;
  if (!c) return "";
  const title = c.detail ? ` title="${escapeHtml(c.detail)}"` : "";
  return `<a href="/apps/${encodeURIComponent(appId)}#${c.target}" class="tag tag-${c.tone}"${title}>${escapeHtml(c.label)}</a>`;
}

function activityToneColor(tone: ActivityTone): string {
  switch (tone) {
    case "active":
      return "var(--status-success)";
    case "recent":
      return "var(--text)";
    case "idle":
    case "none":
    default:
      return "var(--text-muted)";
  }
}

/**
 * Inline SVG sparkline of hourly request counts. Bars stretch to the
 * card width via preserveAspectRatio="none" so we don't have to know
 * the column size at render time. Renders nothing when there is no
 * traffic at all — the "No traffic yet" label carries that case.
 */
function renderSparkline(buckets: number[], tone: ActivityTone): string {
  if (buckets.length === 0) return "";
  const max = buckets.reduce((m, v) => (v > m ? v : m), 0);
  if (max === 0) {
    return `<div style="height:20px;border-radius:3px;background:var(--bg);border:1px solid var(--border)" title="No requests in the last 7 days"></div>`;
  }
  const color =
    tone === "active"
      ? "var(--status-success)"
      : tone === "recent"
        ? "var(--brand)"
        : "var(--text-muted)";
  const w = buckets.length;
  const h = 24;
  const bars = buckets
    .map((c, i) => {
      if (c === 0) return "";
      const barH = Math.max(1, (c / max) * h);
      return `<rect x="${i}" y="${(h - barH).toFixed(2)}" width="0.9" height="${barH.toFixed(2)}" fill="${color}" />`;
    })
    .join("");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="20" style="display:block" aria-hidden="true">${bars}</svg>`;
}

function renderActivityCell(
  lastRequestAt: string | null,
  buckets: number[]
): string {
  const { label, tone } = formatActivity(lastRequestAt);
  const total = buckets.reduce((s, v) => s + v, 0);
  const tooltip = total > 0 ? `${total} requests in the last 7 days` : "";
  return `<div title="${escapeHtml(tooltip)}">
      <span class="act-label" style="color:${activityToneColor(tone)}">${escapeHtml(label)}</span>
      ${renderSparkline(buckets, tone)}
    </div>`;
}

/**
 * One app as a table row on desktop and as a card on a phone (same
 * markup, the stylesheet switches). The name links to the app page; the
 * row carries the attributes the client filter reads (data-status,
 * data-attn, data-name, data-domain).
 */
function renderAppRow(
  app: ReturnType<typeof listApps>[number],
  dashboardDomain: string,
  stats: AppStats | null = null,
  activity: { lastRequestAt: string | null; buckets: number[] } | null = null,
  status: AppStatus | null = null,
  admin = false
): string {
  const configured = !!(app.name && app.runtime);
  const id = encodeURIComponent(app.id);
  const displayName = app.name ?? app.id;
  const nameCell = configured
    ? `<a class="app-name" href="/apps/${id}">${escapeHtml(displayName)}</a>${
        admin && app.created_by ? `<div class="meta">${escapeHtml(app.created_by)}</div>` : ""
      }`
    : `<a class="app-name" href="/apps/${id}"><span class="meta">Unconfigured</span></a>`;

  const domain = app.custom_domain ?? app.domain;
  const domainCell = domain
    ? `<a href="https://${encodeURI(domain)}" target="_blank" rel="noopener noreferrer">${escapeHtml(domain)} &#8599;</a>`
    : `<span class="meta">&mdash;</span>`;

  const llmsTxtUrl = dashboardDomain ? `https://${dashboardDomain}/llms.txt` : "/llms.txt";
  const claudeInstruction = `Fetch ${llmsTxtUrl} and deploy this project using API key ${app.api_key}`;

  const st = status ?? statusOf(app, stats, undefined, Date.now());
  const statusCell = configured
    ? `<div class="app-status">${renderStatusChip(st)}${renderSecurityChip(app.id, st)}</div>`
    : `<span class="meta">Not deployed</span>`;

  // Runtime and memory in one cell; image size and uptime go in the tooltip.
  const resTitle = stats
    ? `Image ${formatBytes(stats.imageBytes)}, up ${formatRelative(stats.startedAt)}`
    : "";
  const resCell = configured
    ? `<span title="${escapeHtml(resTitle)}">${escapeHtml(app.runtime!)}${stats ? ` &middot; ${escapeHtml(formatBytes(stats.memoryBytes))}` : ""}</span>`
    : "";

  const activityCell =
    configured && activity ? renderActivityCell(activity.lastRequestAt, activity.buckets) : "";

  const overflowMenu = `
    <details class="overflow-menu">
      <summary aria-label="More actions for ${escapeHtml(displayName)}">&#8943;</summary>
      <div class="overflow-dropdown">
        <a href="/apps/${id}" class="overflow-item" style="text-decoration:none">${configured ? "Open app page" : "Set up"}</a>
        <button type="button" data-copy="${escapeHtml(claudeInstruction)}" onclick="copyText(this)">Copy deploy instruction</button>
        <button type="button" data-copy="${escapeHtml(app.api_key)}" onclick="copyText(this)">Copy API key</button>
        <form method="POST" action="/apps/${id}/delete" style="margin:0" data-app-name="${escapeHtml(displayName)}" onsubmit="return confirmDelete(this)">
          <button type="submit" class="overflow-danger">Delete app</button>
        </form>
      </div>
    </details>`;

  const key = configured ? st.state : "new";
  const attn = configured && needsAttention(st) ? "1" : "0";
  const attrs = `data-app-row data-name="${escapeHtml(displayName)}" data-domain="${escapeHtml(domain ?? "")}" data-status="${key}" data-attn="${attn}"`;

  if (!configured) {
    return `
    <tr class="app-row status-new" ${attrs}>
      <td colspan="6" class="c-name">
        ${nameCell}
        <div class="setup">
          <p class="meta" style="margin:0 0 0.5rem">Paste this in <a href="https://claude.ai/code" target="_blank" rel="noopener" style="color:var(--tx)">Claude Code</a> inside your project:</p>
          <pre style="background:var(--bg2);border:1px solid var(--line);border-radius:var(--r1);padding:0.4rem 0.6rem;margin:0 0 0.5rem;font-size:0.7rem;white-space:pre-wrap;word-break:break-all;color:var(--tx);user-select:all">${escapeHtml(claudeInstruction)}</pre>
          <button type="button" style="padding:0.25rem 0.75rem;font-size:0.8rem;width:auto" data-copy="${escapeHtml(claudeInstruction)}" onclick="copyText(this)">Copy</button>
        </div>
        <div class="c-menu">${overflowMenu}</div>
      </td>
    </tr>`;
  }

  return `
    <tr class="app-row status-${key}" ${attrs}>
      <td class="c-name">${nameCell}</td>
      <td class="c-status">${statusCell}</td>
      <td class="c-url">${domainCell}</td>
      <td class="c-res">${resCell}</td>
      <td class="c-act">${activityCell}</td>
      <td class="c-menu">${overflowMenu}</td>
    </tr>`;
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

webRoutes.post("/apps/:id/delete", async (c) => {
  const app = getApp(c.req.param("id"));
  if (app) {
    await destroyApp(app);
    deleteApp(app.id);
  }
  return c.redirect("/");
});

// ── App detail (env vars + volumes) ─────────────────────

webRoutes.get("/apps/:id", async (c) => {
  const user = c.get("user");
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const admin = isAdmin(user);
  const now = Date.now();
  const stats = app.runtime ? await getAppStats(app).catch(() => null) : null;
  const kev = collectAtRisk([app]).get(app.id);
  const status = statusOf(app, stats, kev, now);
  const running = activeRebuildRun();
  const blockedReason =
    rebuildBlockedReason(app) ??
    (running ? "A rebuild is already running. Only one runs at a time." : null);
  const canRebuild = mayRebuild(user, app) && blockedReason === null;
  const rebuildFlag = c.req.query("rebuild");
  const rebuildNote =
    rebuildFlag === "busy"
      ? '<div class="error">A rebuild is already running. Only one runs at a time; try again when it is done.</div>'
      : rebuildFlag === "blocked"
        ? `<div class="error">${escapeHtml(rebuildBlockedReason(app) ?? "This app cannot be rebuilt yet.")}</div>`
        : "";
  const appUrlHost = app.custom_domain || app.domain;
  const lastDeploy = getLatestDeploys(app.id, 1)[0];

  const env = getEnvVars(app.id);
  const volumes = getVolumes(app.id);
  const allSkills = listEnabledSkills();
  const selectedSkillIds = new Set(getAppSkillIds(app.id));
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
      <p class="crumb"><a href="/">&larr; Apps</a></p>
      <header class="app-head">
        <div class="app-head-top">
          <h1>${escapeHtml(app.name ?? app.id)}</h1>
          ${renderStatusChip(status)}
          ${renderSecurityChip(app.id, status)}
        </div>
        <p class="app-head-meta meta">
          ${appUrlHost ? `<a href="https://${escapeHtml(appUrlHost)}" target="_blank" rel="noopener noreferrer">${escapeHtml(appUrlHost)} &#8599;</a>` : "No domain yet"}
          ${app.runtime ? `<span>${escapeHtml(app.runtime)}</span>` : ""}
          <span>${lastDeploy ? `Last deploy ${escapeHtml(formatRelative(lastDeploy.created_at))}` : "Not deployed yet"}</span>
          ${admin && app.created_by ? `<span>Owner ${escapeHtml(app.created_by)}</span>` : ""}
        </p>
      </header>
      ${saved ? '<div class="card" style="border-color:var(--ok);color:var(--ok)">Saved.</div>' : ""}
      ${rebuildNote}
      ${
        kev
          ? renderKevBlock({
              app: { id: app.id, name: app.name ?? app.id },
              kev,
              now,
              canRebuild,
              rebuildDisabledReason: mayRebuild(user, app) ? blockedReason : "Only the app's owner or an admin can rebuild it.",
              isAdmin: admin,
            })
          : ""
      }
      ${rollbackError ? `<div class="card" style="border-color:var(--err);color:var(--err)"><strong>Rollback failed:</strong> ${escapeHtml(rollbackError)}</div>` : ""}

      <div class="tabs">
        <input type="radio" name="app-tab" id="tab-deploys" checked />
        <label for="tab-deploys">Deploys</label>
        <input type="radio" name="app-tab" id="tab-security" />
        <label for="tab-security">Security${status.security && status.security.tone !== "ok" && status.security.tone !== "neutral" ? ' <span class="tab-dot" aria-label="needs attention"></span>' : ""}</label>
        <input type="radio" name="app-tab" id="tab-config" />
        <label for="tab-config">Config</label>
        <input type="radio" name="app-tab" id="tab-access" />
        <label for="tab-access">Access</label>

        <div class="tab-panels" style="width:100%">
          <!-- ── Deploys tab ────────────────────────── -->
          <div class="tab-panel panel-deploys">
            ${renderRebuildLine(rebuildLine(listRebuildRuns(10), app.id, running), app.id, (iso) => (iso ? formatRelative(iso) : ""))}
            ${renderDeployHistory(app)}
          </div>

          <!-- ── Security tab ───────────────────────── -->
          <div class="tab-panel panel-security">
            ${renderQuarantineSection(app, admin)}
            ${renderScanSection(app, admin, canRebuild, mayRebuild(user, app) ? blockedReason : null)}
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
                          <tr style="text-align:left;border-bottom:1px solid var(--line)">
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
                          <tr style="text-align:left;border-bottom:1px solid var(--line)">
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

            <div class="card">
              <h2>Suggested skills</h2>
              <p class="hint" style="margin:0.5rem 0 1rem">
                Select the skills most relevant to this app. Suggestions only —
                Claude Code still sees every enabled skill via the MCP server,
                but the agent uses this list to prioritize what to read first
                for this app.
              </p>
              ${
                allSkills.length === 0
                  ? '<p class="meta">No skills available yet. Built-ins ship with Runway; admins can add custom ones from the Skills page.</p>'
                  : `<form method="POST" action="/apps/${encodeURIComponent(app.id)}/skills">
                      <div style="display:flex;flex-direction:column;gap:0.4rem;margin-bottom:0.75rem">
                        ${allSkills
                          .map(
                            (s) => `
                          <label style="display:flex;gap:0.6rem;align-items:flex-start;font-size:0.85rem;cursor:pointer">
                            <input type="checkbox" name="skill_ids" value="${escapeHtml(s.id)}" ${selectedSkillIds.has(s.id) ? "checked" : ""} style="margin-top:0.2rem" />
                            <span>
                              <strong>${escapeHtml(s.name)}</strong>
                              <span class="meta" style="margin-left:0.5rem;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(s.layer)}</span>
                              ${s.description ? `<br /><span class="meta" style="font-size:0.8rem">${escapeHtml(s.description)}</span>` : ""}
                            </span>
                          </label>`,
                          )
                          .join("")}
                      </div>
                      <button type="submit">Save suggestions</button>
                    </form>`
              }
            </div>
          </div>
        </div>
      </div>
    `,
      { username: user.username, csrf: csrfField(c), isAdmin: admin }
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

webRoutes.get("/apps/:id/source", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");

  const deployParam = c.req.query("deploy");
  let ref = null as ReturnType<typeof latestSource>;
  let suffix = "source";
  if (deployParam !== undefined) {
    const deployId = parseInt(deployParam, 10);
    if (!Number.isInteger(deployId) || deployId < 1) {
      return c.redirect(`/apps/${encodeURIComponent(app.id)}?error=bad_deploy_id#deploys`);
    }
    ref = sourceForDeploy(app.id, deployId);
    suffix = `deploy-${deployId}`;
  } else {
    ref = latestSource(app.id);
  }
  if (!ref) {
    return c.redirect(`/apps/${encodeURIComponent(app.id)}?error=no_source#deploys`);
  }

  let buf: Buffer;
  try {
    buf = await readFile(ref.path);
  } catch {
    return c.redirect(`/apps/${encodeURIComponent(app.id)}?error=no_source#deploys`);
  }
  const base = slugify(app.name ?? app.id) || app.id;
  c.header("Content-Type", "application/x-tar");
  c.header("Content-Length", String(ref.bytes));
  c.header("Content-Disposition", `attachment; filename="${base}-${suffix}.tar"`);
  return c.body(new Uint8Array(buf));
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

webRoutes.post("/apps/:id/rescan", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.redirect("/");
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  if (!app.image_tag) {
    return c.redirect(
      `/apps/${encodeURIComponent(app.id)}?error=no_image#scan`,
    );
  }
  // Run inline so the page reload reflects the new periodic-scan row.
  await rescanApp(app);
  logAudit(user.id, user.username, "app_rescanned", { detail: app.id });
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

webRoutes.post("/apps/:id/skills", async (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody({ all: true });
  const raw = body["skill_ids"];
  const requested = Array.isArray(raw)
    ? (raw.filter((v) => typeof v === "string") as string[])
    : typeof raw === "string"
      ? [raw]
      : [];
  // Drop ids that don't match an enabled skill — silent filter so a
  // checkbox for a since-disabled skill doesn't leave stale entries.
  const enabled = new Set(listEnabledSkills().map((s) => s.id));
  const valid = requested.filter((id) => enabled.has(id));
  setAppSkillIds(app.id, valid);
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#tab-config`);
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
  if (!verifyAndConsumeTotp(current.id, current.totp_secret!, code)) {
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
  const maxUploadMb = getMaxUploadMb();
  const keepImageVersions = getKeepImageVersions();
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
      ${saved ? '<div class="card" style="border-color:var(--ok);color:var(--ok)">Settings saved.</div>' : ""}
      ${dnsWarning ? `<div class="error">${escapeHtml(dnsWarning)}</div>` : ""}
      ${webhookError ? `<div class="error">${escapeHtml(webhookError)}</div>` : ""}

      <div class="settings-layout">
        <nav class="settings-nav">
          <a href="#domain">Base domain</a>
          <a href="#notifications">Notifications</a>
          <a href="#scan-floor">Scan floor</a>
          <a href="#upload-limit">Upload limit</a>
          <a href="#image-retention">Image retention</a>
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

          <div class="card" id="upload-limit">
            <h2>Upload limit</h2>
            <p class="hint" style="margin:0.5rem 0 1rem">
              Maximum size of a deploy tarball, in megabytes. The whole upload
              is buffered in memory, so very large values can exhaust the
              control container. Max ${MAX_UPLOAD_MB_CEILING} MB.
            </p>
            <form method="POST" action="/settings/upload-limit">
              <div class="flex">
                <input type="number" name="max_upload_mb" value="${maxUploadMb}" min="1" max="${MAX_UPLOAD_MB_CEILING}" step="1" style="flex:1" />
                <button type="submit">Save</button>
              </div>
            </form>
          </div>

          <div class="card" id="image-retention">
            <h2>Image retention</h2>
            <p class="hint" style="margin:0.5rem 0 1rem">
              How many most-recent successful image versions to keep per app.
              Older images are pruned from the local Docker cache after each
              deploy. Build cache layers are evicted weekly (older than 7d).
              Lower values save disk; higher values give more rollback history.
            </p>
            <form method="POST" action="/settings/image-retention">
              <div class="flex">
                <input type="number" name="keep_image_versions" value="${keepImageVersions}" min="${KEEP_IMAGE_VERSIONS_FLOOR}" max="${KEEP_IMAGE_VERSIONS_CEILING}" step="1" style="flex:1" />
                <button type="submit">Save</button>
              </div>
            </form>
            <form method="POST" action="/settings/prune-build-cache" style="margin-top:0.75rem">
              <button type="submit" style="width:auto">Prune build cache now</button>
              <span class="hint" style="margin-left:0.75rem">Runs <code>buildctl prune --keep-duration 168h</code>.</span>
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

webRoutes.post("/settings/upload-limit", async (c) => {
  const body = await c.req.parseBody();
  const parsed = parseInt((body["max_upload_mb"] as string | undefined) ?? "", 10);
  if (Number.isFinite(parsed)) {
    // Clamp on write so the stored value matches what getMaxUploadMb()
    // enforces on read. Ignore non-numeric input (keep current setting).
    setSetting("max_upload_mb", String(clampUploadMb(parsed)));
  }
  return c.redirect("/settings?saved=1");
});

webRoutes.post("/settings/image-retention", async (c) => {
  const body = await c.req.parseBody();
  const parsed = parseInt(
    (body["keep_image_versions"] as string | undefined) ?? "",
    10
  );
  if (Number.isFinite(parsed)) {
    setSetting("keep_image_versions", String(clampKeepImageVersions(parsed)));
  }
  return c.redirect("/settings?saved=1");
});

webRoutes.post("/settings/prune-build-cache", async (c) => {
  // Fire-and-forget: pruning can take several seconds on a large
  // cache, and we don't want the admin's POST to hang. runCachePrune
  // logs success/failure to the control container logs.
  runCachePrune();
  return c.redirect("/settings?saved=1");
});

// ── Rebuild (admin) ─────────────────────────────────────
// Rebuild apps from their stored source without the BuildKit cache so
// base-image and apt fixes actually land. See deploy/rebuild.ts.

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const OUTCOME_BADGE: Record<string, string> = {
  rebuilt: "badge-running",
  rolled_back: "badge-stopped",
  blocked: "badge-stopped",
  failed: "badge-stopped",
  skipped: "badge-stopped",
};

function renderCounts(x: RebuildAppResult["before"]): string {
  if (!x) return '<span class="meta">n/a</span>';
  const c = x.counts;
  return `${c.critical}C / ${c.high}H / ${c.medium}M &middot; <strong>${x.kev} KEV</strong>`;
}

function renderEscalation(r: RebuildAppResult): string {
  return (r.escalation ?? [])
    .map((e) => {
      const tag =
        e.kind === "minor" && e.outcome === "applied"
          ? '<span class="badge badge-running">auto-minor</span>'
          : e.kind === "major"
            ? '<span class="badge badge-building">major available</span>'
            : `<span class="badge badge-stopped">minor ${escapeHtml(e.outcome)}</span>`;
      return `<div style="margin-bottom:0.25rem">${tag} ${escapeHtml(e.detail)}</div>`;
    })
    .join("");
}

const DEP_OUTCOME_BADGE: Record<string, string> = {
  applied: "badge-running",
  ineffective: "badge-building",
  blocked: "badge-stopped",
  unhealthy: "badge-stopped",
  failed: "badge-stopped",
};

/** Dependency updates of one rebuild: what was raised, and what was not. */
function renderDeps(r: RebuildAppResult): string {
  return (r.deps ?? [])
    .map((d) => {
      if (d.outcome === "skipped") {
        const what = d.to ? `${d.pkg} ${d.to}` : d.pkg;
        return `<div style="margin-bottom:0.25rem"><span class="badge badge-stopped">dependency skipped</span> ${escapeHtml(what)}: ${escapeHtml(d.detail ?? "")}</div>`;
      }
      const label =
        d.outcome === "applied"
          ? "dependency updated"
          : d.outcome === "ineffective"
            ? "dependency raised, finding remains"
            : `dependency ${d.outcome}`;
      const move = `${escapeHtml(d.pkg)} ${escapeHtml(d.from)} &rarr; ${escapeHtml(d.to)}${d.kind === "major" ? " (major)" : ""}`;
      const why = d.outcome === "applied" || !d.detail ? "" : `: ${escapeHtml(d.detail)}`;
      return `<div style="margin-bottom:0.25rem"><span class="badge ${DEP_OUTCOME_BADGE[d.outcome] ?? ""}">${escapeHtml(label)}</span> ${move}${why}</div>`;
    })
    .join("");
}

function renderBases(r: RebuildAppResult): string {
  const lines = (r.base_images ?? []).map((b) => {
    const short = b.image.replace(/^docker\.io\/(library\/)?/, "");
    return `<div style="font-family:monospace;font-size:0.72rem" title="${escapeHtml(b.digest)}">${escapeHtml(short)}${baseBadge(b)}</div>`;
  });
  if (lines.length === 0 && r.patched?.length) {
    // Build never produced a log (e.g. failed): still say what we tried.
    return r.patched.map((p) => `<div style="font-family:monospace;font-size:0.72rem">tried ${escapeHtml(p.from)} &rarr; ${escapeHtml(p.to)}</div>`).join("");
  }
  return lines.join("") || "&mdash;";
}

function renderRebuildResults(run: RebuildRun): string {
  if (run.results.length === 0) {
    return `<p class="meta">${run.status === "running" ? "Starting&hellip;" : "No apps needed a rebuild."}</p>`;
  }
  const rows = run.results
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.app_name ?? r.app_id)}</td>
        <td><span class="badge ${OUTCOME_BADGE[r.outcome] ?? ""}">${escapeHtml(r.outcome.replace("_", " "))}</span></td>
        <td>${renderCounts(r.before)}</td>
        <td>${renderCounts(r.after)}</td>
        <td class="meta">${renderBases(r)}</td>
        <td class="meta">${renderEscalation(r)}${renderDeps(r)}${escapeHtml(r.detail ?? "")}${r.duration_s !== undefined ? ` (${r.duration_s}s)` : ""}</td>
      </tr>`
    )
    .join("");
  return `<table>
    <thead><tr><th>App</th><th>Result</th><th>Before</th><th>After</th><th>Base image</th><th>Note</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

webRoutes.get("/rebuild", async (c) => {
  const user = c.get("user");
  const schedule = readSchedule();
  const runs = listRebuildRuns(5);
  const running = activeRebuildRunId() !== null;
  const latest = runs[0];
  const flash =
    c.req.query("busy") ? '<div class="error">A rebuild run is already in progress.</div>'
    : c.req.query("saved") ? '<div class="card" style="margin-bottom:1rem">Saved.</div>'
    : c.req.query("started") ? '<div class="card" style="margin-bottom:1rem">Rebuild started. Apps are rebuilt one after another; this page refreshes while it runs.</div>'
    : "";
  const dayOptions = WEEKDAY_NAMES.map(
    (n, i) => `<option value="${i}"${i === schedule.day ? " selected" : ""}>${n}</option>`
  ).join("");
  const history = runs
    .slice(1)
    .map(
      (r) => `<details style="margin-top:0.5rem"><summary class="meta">Run #${r.id} &middot; ${escapeHtml(r.trigger)} &middot; ${escapeHtml(formatRelative(r.started_at))}</summary>${renderRebuildResults(r)}</details>`
    )
    .join("");

  const termMs = getQuarantineTermDays() * 86_400_000;
  const qRows = listQuarantine();
  const quarantineTable = qRows.length
    ? `<table style="margin-top:1rem"><thead><tr><th>App</th><th>State</th><th>Actively exploited</th><th>Term ends</th><th>Exemption</th></tr></thead><tbody>${qRows
        .map((q) => {
          const a = getApp(q.app_id);
          const ex = getActiveExemption(q.app_id);
          return `<tr>
            <td><a href="/apps/${encodeURIComponent(q.app_id)}#quarantine">${escapeHtml(a?.name ?? q.app_id)}</a></td>
            <td><span class="badge ${q.state === "quarantined" ? "badge-quarantined" : "badge-building"}">${q.state === "quarantined" ? "quarantined" : "term running"}</span></td>
            <td class="meta">${escapeHtml(Object.keys(q.kev_first_seen).join(", "))}</td>
            <td class="meta">${escapeHtml(fmtUtc(deadlineOf(q, termMs)))}</td>
            <td class="meta">${ex ? escapeHtml(`until ${fmtUtc(ex.until)}: ${ex.reason}`) : "&mdash;"}</td>
          </tr>`;
        })
        .join("")}</tbody></table>`
    : '<p class="meta" style="margin-top:1rem">No app has an actively exploited vulnerability right now.</p>';

  return c.html(
    layout(
      "Rebuild",
      `
      ${running ? '<meta http-equiv="refresh" content="10" />' : ""}
      <div class="container">
        <h1>Rebuild</h1>
        ${flash}
        <div class="card">
          <h2>Rebuild all apps</h2>
          <p class="meta">
            Rebuilds every deployed app from its stored source <strong>without the BuildKit cache</strong>,
            one after another. Exact patch pins in <code>FROM</code> (e.g. <code>nginx:1.30.6-alpine</code>) are raised to the newest
            patch of the same minor in a build-time copy (per-app opt-out). A rebuild goes live only if it is not worse than the
            running version (no new critical, no new actively exploited CVE) and the new container passes its health check;
            otherwise the old version keeps running and the reason is shown here. A container that fails its health check is
            replaced by the previous deploy automatically. Takes a few minutes per app; the live apps keep
            serving until their own swap.
          </p>
          <form method="POST" action="/rebuild/run" onsubmit="return confirm('Rebuild all apps now?')">
            <button type="submit" style="width:auto"${running ? " disabled" : ""}>${running ? "Run in progress&hellip;" : "Rebuild all apps"}</button>
          </form>
        </div>

        <div class="card">
          <h2>${latest ? `Latest run #${latest.id}` : "No runs yet"}</h2>
          ${
            latest
              ? `<p class="meta">${escapeHtml(latest.trigger)} &middot; started ${escapeHtml(formatRelative(latest.started_at))} &middot; ${latest.status === "running" ? "<strong>running</strong>" : "finished"}. Before/after = critical / high / medium findings and actively exploited (CISA KEV) CVEs; "before" is a fresh scan of the version that was running.</p>${renderRebuildResults(latest)}`
              : '<p class="meta">Nothing has been rebuilt yet.</p>'
          }
          ${history}
        </div>

        <div class="card">
          <h2>Automatic weekly rebuild</h2>
          <p class="meta">
            Rebuilds only apps whose latest scan shows an actively exploited CVE (CISA KEV) or a critical
            finding that has a fix, and that haven't opted out on their app page. The outcome is sent to the
            notification webhook. Times are ${escapeHtml(SCHEDULE_TZ)}.
          </p>
          <form method="POST" action="/rebuild/schedule">
            <label><input type="checkbox" name="enabled" value="1"${schedule.enabled ? " checked" : ""} /> Enabled</label>
            <div style="display:flex;gap:0.5rem;margin:0.75rem 0">
              <select name="day">${dayOptions}</select>
              <input type="time" name="time" value="${escapeHtml(schedule.time)}" required />
            </div>
            <button type="submit" style="width:auto">Save schedule</button>
          </form>
        </div>

        <div class="card">
          <h2>KEV quarantine</h2>
          <p class="meta">
            An actively exploited CVE (CISA KEV) in a running app's runtime packages starts a term and notifies the
            owner and the webhook on day 0. If it is still there when the term ends and one last rebuild (with minor
            escalation) did not fix it, the app is quarantined: visitors get a maintenance page and the container is
            stopped (data and volumes stay). It returns automatically once a rebuild or deploy resolves it. Admins can
            grant a time-boxed exemption on the app page. Ordinary criticals never quarantine.
          </p>
          <form method="POST" action="/rebuild/quarantine-term" style="display:flex;gap:0.5rem;align-items:center">
            <label>Term (days) <input type="number" name="days" step="any" min="0.001" max="90" value="${escapeHtml(String(getQuarantineTermDays()))}" style="width:7rem" required /></label>
            <button type="submit" style="width:auto">Save</button>
          </form>
          ${quarantineTable}
        </div>
      </div>`,
      { username: user.username, csrf: csrfField(c), isAdmin: true }
    )
  );
});

webRoutes.post("/rebuild/run", async (c) => {
  const user = c.get("user");
  try {
    const id = startRebuildRun({ trigger: "manual" });
    logAudit(user.id, user.username, "rebuild_all_started", { detail: `run ${id}` });
  } catch (err) {
    if (err instanceof RebuildBusyError) return c.redirect("/rebuild?busy=1");
    throw err;
  }
  return c.redirect("/rebuild?started=1");
});

webRoutes.post("/rebuild/schedule", async (c) => {
  const body = await c.req.parseBody();
  const time = normalizeTime(body["time"] as string | undefined);
  const day = parseInt((body["day"] as string | undefined) ?? "", 10);
  if (time && Number.isInteger(day) && day >= 0 && day <= 6) {
    saveSchedule({ enabled: body["enabled"] === "1", day, time });
  }
  return c.redirect("/rebuild?saved=1");
});

/**
 * Rebuild one app from its stored source. An admin, or the app's owner:
 * requireAppAccess already turned every other member away for
 * /apps/:id/*, and mayRebuild() says the same again here so the rule
 * survives a reordering of the middleware. Same limit for everyone: one
 * run at a time. Every run is audited when it starts and when it ends.
 */
webRoutes.post("/apps/:id/rebuild", async (c) => {
  const user = c.get("user");
  const app = getApp(c.req.param("id"));
  if (!app || !mayRebuild(user, app)) return c.redirect("/?forbidden=1");
  const admin = isAdmin(user);
  const back = (flag: string) =>
    admin && flag !== "blocked"
      ? c.redirect(flag === "busy" ? "/rebuild?busy=1" : "/rebuild?started=1")
      : c.redirect(`/apps/${encodeURIComponent(app.id)}?rebuild=${flag}#deploys`);
  if (rebuildBlockedReason(app)) return back("blocked");
  try {
    const id = startRebuildRun({
      trigger: "manual",
      appIds: [app.id],
      onFinished: (results) => {
        const r = results.find((x) => x.app_id === app.id) ?? results[0];
        logAudit(user.id, user.username, "app_rebuild_finished", {
          detail: `${app.id} run ${id}: ${r?.outcome ?? "no result"}${r?.detail ? ` (${r.detail.slice(0, 200)})` : ""}`,
        });
      },
    });
    logAudit(user.id, user.username, "app_rebuild_started", {
      detail: `${app.id} run ${id}${admin ? "" : " (by owner)"}`,
    });
  } catch (err) {
    if (err instanceof RebuildBusyError) return back("busy");
    throw err;
  }
  return back("started");
});

/** Rebuild line of one app, polled while a run is busy. Same access rule as the page. */
webRoutes.get("/apps/:id/rebuild-status", (c) => {
  const app = getApp(c.req.param("id"));
  if (!app) return c.text("", 404);
  return c.html(
    renderRebuildLine(
      rebuildLine(listRebuildRuns(10), app.id, activeRebuildRun()),
      app.id,
      (iso) => (iso ? formatRelative(iso) : "")
    )
  );
});

webRoutes.post("/apps/:id/auto-patch", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.redirect("/");
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  updateApp(app.id, { auto_patch_base: body["enabled"] === "1" ? 1 : 0 });
  logAudit(user.id, user.username, "app_auto_patch_toggled", {
    detail: `${app.id} -> ${body["enabled"] === "1" ? "on" : "off"}`,
  });
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#scan`);
});

webRoutes.post("/apps/:id/auto-rebuild", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.redirect("/");
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  updateApp(app.id, { auto_rebuild: body["enabled"] === "1" ? 1 : 0 });
  logAudit(user.id, user.username, "app_auto_rebuild_toggled", {
    detail: `${app.id} -> ${body["enabled"] === "1" ? "on" : "off"}`,
  });
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#scan`);
});

// JSON admin API for scripts. Session-authenticated (not per-app
// Bearer keys): the per-app key model is untouched. State-changing
// calls must carry `X-Requested-With: runway`, which a cross-site form
// cannot set; the session cookie is SameSite=Lax as a second layer.
async function adminApi(c: any, next: any) {
  const token = getCookieValue(c, SESSION_COOKIE);
  const user = token ? getSessionUser(token) : undefined;
  if (!user) return c.json({ error: "Not signed in" }, 401);
  if (!isAdmin(user)) return c.json({ error: "Admin only" }, 403);
  if (c.req.method !== "GET" && c.req.header("x-requested-with") !== "runway") {
    return c.json({ error: "Missing X-Requested-With: runway header" }, 400);
  }
  c.set("user", user);
  await next();
}
webRoutes.use("/admin/api/*", adminApi);

webRoutes.post("/admin/api/rebuild-all", async (c) => {
  const user = c.get("user");
  try {
    const id = startRebuildRun({ trigger: "manual" });
    logAudit(user.id, user.username, "rebuild_all_started", { detail: `run ${id} (api)` });
    return c.json({ status: "started", run_id: id }, 202);
  } catch (err) {
    if (err instanceof RebuildBusyError) {
      return c.json({ error: err.message, run_id: activeRebuildRunId() }, 409);
    }
    throw err;
  }
});

webRoutes.get("/admin/api/rebuild-runs", (c) =>
  c.json({ runs: listRebuildRuns(20) })
);

webRoutes.get("/admin/api/rebuild-runs/:id", (c) => {
  const run = getRebuildRun(parseInt(c.req.param("id"), 10));
  return run ? c.json(run) : c.json({ error: "Run not found" }, 404);
});

webRoutes.post("/rebuild/quarantine-term", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const days = parseFloat((body["days"] as string | undefined) ?? "");
  if (Number.isFinite(days)) {
    const clamped = clampQuarantineTermDays(days);
    setSetting("quarantine_term_days", String(clamped));
    logAudit(user.id, user.username, "quarantine_term_changed", { detail: `${clamped} day(s)` });
  }
  return c.redirect("/rebuild?saved=1");
});

webRoutes.post("/apps/:id/auto-minor", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.redirect("/");
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  updateApp(app.id, { auto_minor_base: body["enabled"] === "1" ? 1 : 0 });
  logAudit(user.id, user.username, "app_auto_minor_toggled", {
    detail: `${app.id} -> ${body["enabled"] === "1" ? "on" : "off"}`,
  });
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#scan`);
});

webRoutes.post("/apps/:id/auto-deps", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.redirect("/");
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  updateApp(app.id, { auto_update_deps: body["enabled"] === "1" ? 1 : 0 });
  logAudit(user.id, user.username, "app_auto_deps_toggled", {
    detail: `${app.id} -> ${body["enabled"] === "1" ? "on" : "off"}`,
  });
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#scan`);
});

webRoutes.post("/apps/:id/auto-deps-major", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.redirect("/");
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  updateApp(app.id, { auto_update_deps_major: body["enabled"] === "1" ? 1 : 0 });
  logAudit(user.id, user.username, "app_auto_deps_major_toggled", {
    detail: `${app.id} -> ${body["enabled"] === "1" ? "on" : "off"}`,
  });
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#scan`);
});

const MAX_EXEMPTION_DAYS = 90;

webRoutes.post("/apps/:id/quarantine-exception", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.redirect("/");
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  const body = await c.req.parseBody();
  const reason = ((body["reason"] as string | undefined) ?? "").trim();
  const untilRaw = ((body["until"] as string | undefined) ?? "").trim();
  // A bare date means "through the end of that day (UTC)".
  const until = /^\d{4}-\d{2}-\d{2}$/.test(untilRaw)
    ? Date.parse(`${untilRaw}T23:59:59Z`)
    : Date.parse(untilRaw);
  const now = Date.now();
  const back = `/apps/${encodeURIComponent(app.id)}`;
  if (reason.length < 5 || reason.length > 500) return c.redirect(`${back}?error=exception_reason#quarantine`);
  if (!Number.isFinite(until) || until <= now || until > now + MAX_EXEMPTION_DAYS * 86_400_000) {
    return c.redirect(`${back}?error=exception_date#quarantine`);
  }
  const untilIso = new Date(until).toISOString();
  setExemption({ app_id: app.id, reason, until: untilIso, granted_by: user.username });
  logAudit(user.id, user.username, "quarantine_exemption_granted", {
    detail: `${app.id} until ${untilIso}: ${reason}`.slice(0, 500),
  });
  const msg = `quarantine exemption granted by ${user.username} until ${fmtUtc(untilIso)}: ${reason}`;
  addNotice(app.id, "exemption", msg);
  await notifyAdminWebhook(`Runway ${app.name ?? app.id}: ${msg}`, { app_id: app.id, event: "exemption" });
  // Apply right away: lifts an existing quarantine instead of waiting for the next tick.
  const kev = await getKevList();
  if (kev.fetchedAt !== null) await evaluateAppQuarantine(app, kev.ids, false);
  return c.redirect(`${back}?saved=1#quarantine`);
});

webRoutes.post("/apps/:id/quarantine-exception/remove", async (c) => {
  const user = c.get("user");
  if (!isAdmin(user)) return c.redirect("/");
  const app = getApp(c.req.param("id"));
  if (!app) return c.redirect("/");
  deleteExemption(app.id);
  logAudit(user.id, user.username, "quarantine_exemption_removed", { detail: app.id });
  addNotice(app.id, "exemption", `quarantine exemption removed by ${user.username}`);
  return c.redirect(`/apps/${encodeURIComponent(app.id)}?saved=1#quarantine`);
});

/**
 * Public maintenance page. The gateway routes a quarantined app's hosts
 * here (path rewritten to /maintenance). Deliberately generic: no app
 * name, no reason, no CVE ids.
 */
webRoutes.get("/maintenance", (c) => {
  c.header("Retry-After", "3600");
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Temporarily offline</title>
    <style>body{font-family:system-ui,sans-serif;background:#faf7f2;color:#2b2926;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1rem}main{max-width:32rem;text-align:center}h1{font-size:1.5rem}p{color:#6b665e;line-height:1.5}@media (prefers-color-scheme:dark){body{background:#1d1b18;color:#ece8e1}p{color:#a39d93}}</style></head>
    <body><main><h1>Temporarily offline</h1><p>This site is offline for security maintenance. Please check back later.</p></main></body></html>`,
    503
  );
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
            <tr style="text-align:left;border-bottom:1px solid var(--line)">
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

// ── Skills (admin) ──────────────────────────────────────

const SKILL_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseSkillFrontmatter(source: string): {
  name?: string;
  description?: string;
  version?: string;
} {
  const match = source.match(SKILL_FRONTMATTER_RE);
  if (!match) return {};
  try {
    const parsed = yaml.load(match[1]!);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as { name?: string; description?: string; version?: string };
  } catch {
    return {};
  }
}

const MAX_SKILL_MD_BYTES = 200 * 1024;

webRoutes.get("/skills", (c) => {
  const user = c.get("user");
  const error = c.req.query("error");
  const detail = c.req.query("detail");
  const saved = c.req.query("saved");
  const skills = listAllSkills();

  const errorMessage =
    error === "no_frontmatter"
      ? "SKILL.md is missing the YAML frontmatter block (---)."
      : error === "no_name"
        ? "Frontmatter must include a `name` field."
        : error === "no_description"
          ? "Frontmatter must include a `description` field."
          : error === "bad_id"
            ? "Could not derive a valid id from the name (use letters/digits)."
            : error === "managed"
              ? "That id is reserved for a built-in skill — pick a different name."
              : error === "too_large"
                ? `SKILL.md exceeds ${MAX_SKILL_MD_BYTES / 1024} KB.`
                : error === "bad_source"
                  ? "Could not parse the source — expected `owner/repo` or `owner/repo/path`."
                  : error === "untrusted"
                    ? "That source is not in the trusted-org whitelist. Tick the override box if you really want to import it."
                    : error === "fetch_failed"
                      ? `Could not import: ${detail ? detail : "unknown error"}.`
                      : null;

  const layerBadge = (layer: string) => {
    const cls =
      layer === "custom"
        ? "badge-running"
        : layer === "curated"
          ? "badge-starting"
          : "badge-created";
    return `<span class="badge ${cls}">${escapeHtml(layer)}</span>`;
  };

  const rows = skills
    .map((s) => {
      const enabledToggle = `<form method="POST" action="/skills/${encodeURIComponent(s.id)}/toggle" style="margin:0">
        <input type="hidden" name="enabled" value="${s.enabled ? 0 : 1}" />
        <button type="submit" class="ghost" style="padding:0.25rem 0.6rem;font-size:0.75rem">${s.enabled ? "Disable" : "Enable"}</button>
      </form>`;
      const deleteBtn = s.is_managed
        ? '<span class="meta" style="font-size:0.75rem">built-in</span>'
        : `<form method="POST" action="/skills/${encodeURIComponent(s.id)}/delete" style="margin:0" onsubmit="return confirm('Delete this skill? Apps that suggest it lose the suggestion.')">
            <button type="submit" class="danger" style="padding:0.25rem 0.6rem;font-size:0.75rem">Delete</button>
          </form>`;
      const signedBadge =
        s.layer === "curated"
          ? s.signed
            ? '<span class="badge badge-running" title="Source is in the trusted-org whitelist">signed</span>'
            : '<span class="badge badge-stopped" title="Source not in whitelist; admin imported with override">unverified</span>'
          : "";
      const sourceLine = s.source_url
        ? `<p class="meta" style="margin:0.25rem 0 0;font-size:0.75rem">source: <a href="${escapeHtml(s.source_url)}" target="_blank" rel="noopener">${escapeHtml(s.source_url.replace(/^https:\/\/github\.com\//, ""))}</a>${s.bundle_sha256 ? ` · sha256 <code>${escapeHtml(s.bundle_sha256.slice(0, 12))}</code>` : ""}</p>`
        : "";
      return `
        <div class="card">
          <div class="flex between" style="gap:1rem;flex-wrap:wrap;align-items:flex-start">
            <div style="flex:1;min-width:0">
              <div class="flex" style="gap:0.6rem;flex-wrap:wrap;align-items:center">
                <h2 style="margin:0">${escapeHtml(s.name)}</h2>
                ${layerBadge(s.layer)}
                ${signedBadge}
                ${s.enabled ? "" : '<span class="badge badge-stopped">disabled</span>'}
                <span class="meta" style="font-size:0.75rem"><code>${escapeHtml(s.id)}</code> v${escapeHtml(s.version)}</span>
              </div>
              ${s.description ? `<p class="meta" style="margin:0.4rem 0 0;font-size:0.85rem">${escapeHtml(s.description)}</p>` : ""}
              ${sourceLine}
            </div>
            <div class="flex" style="gap:0.5rem;flex-wrap:wrap">
              ${enabledToggle}
              ${deleteBtn}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  const trustedList = listTrustedOrgs()
    .map((o) => `<code>${escapeHtml(o)}</code>`)
    .join(", ");

  return c.html(
    layout(
      "Skills",
      `
      <h1>Skills</h1>
      <p class="hint" style="margin-bottom:1.5rem">
        Skills served via this Runway instance's MCP endpoint
        (<code>/mcp</code>). Built-ins ship with the platform; curated
        skills are imported from a public GitHub bundle; custom skills
        are pasted in below.
      </p>
      ${saved === "added" ? '<div class="card" style="border-color:var(--ok);color:var(--ok)">Skill added.</div>' : ""}
      ${saved === "imported" ? '<div class="card" style="border-color:var(--ok);color:var(--ok)">Skill imported.</div>' : ""}
      ${saved === "toggled" ? '<div class="card" style="border-color:var(--ok);color:var(--ok)">Updated.</div>' : ""}
      ${saved === "deleted" ? '<div class="card" style="border-color:var(--ok);color:var(--ok)">Skill deleted.</div>' : ""}
      ${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ""}

      ${skills.length > 0 ? rows : '<p class="meta">No skills loaded yet.</p>'}

      <div class="card" style="margin-top:1.5rem">
        <h2>Import curated skill</h2>
        <p class="hint" style="margin:0.5rem 0 1rem">
          Pull a skill from a public GitHub repo. Paste a source like
          <code>anthropics/skills/pdf</code> or a GitHub URL such as
          <code>https://github.com/vercel-labs/agent-skills/tree/main/find-skills</code>.
          The bundle's <code>SKILL.md</code> + companion files are
          fetched, hashed, and stored under the <em>curated</em> layer.
        </p>
        <p class="hint" style="margin:0 0 1rem;font-size:0.8rem">
          Trusted publishers (signed): ${trustedList}.
        </p>
        <form method="POST" action="/skills/import">
          <input type="text" name="source" required placeholder="anthropics/skills/pdf" style="width:100%;font-family:monospace;font-size:0.9rem;padding:0.5rem;background:var(--bg2);border:1px solid var(--line);border-radius:6px;color:var(--tx)" />
          <label class="meta" style="display:block;margin-top:0.6rem;font-size:0.8rem">
            <input type="checkbox" name="allow_untrusted" value="1" style="vertical-align:middle" />
            I have reviewed this source and want to import even though
            it is not in the trusted-org whitelist.
          </label>
          <button type="submit" style="margin-top:0.75rem">Import skill</button>
        </form>
      </div>

      <div class="card" style="margin-top:1.5rem">
        <h2>Add custom skill</h2>
        <p class="hint" style="margin:0.5rem 0 1rem">
          Paste a SKILL.md file. Must start with a YAML frontmatter
          block (<code>---</code>) containing <code>name</code> and
          <code>description</code>. Max ${MAX_SKILL_MD_BYTES / 1024} KB.
        </p>
        <form method="POST" action="/skills">
          <textarea name="skill_md" rows="14" required style="width:100%;font-family:monospace;font-size:0.85rem;padding:0.6rem;background:var(--bg2);border:1px solid var(--line);border-radius:6px;color:var(--tx)" placeholder="---&#10;name: my-skill&#10;description: When and why to use this skill.&#10;---&#10;&#10;# Skill content here"></textarea>
          <button type="submit" style="margin-top:0.75rem">Add skill</button>
        </form>
      </div>
    `,
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
    )
  );
});

webRoutes.post("/skills", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const skillMd = (body["skill_md"] as string | undefined) ?? "";

  if (skillMd.length > MAX_SKILL_MD_BYTES) {
    return c.redirect("/skills?error=too_large");
  }
  if (!SKILL_FRONTMATTER_RE.test(skillMd)) {
    return c.redirect("/skills?error=no_frontmatter");
  }

  const fm = parseSkillFrontmatter(skillMd);
  const name = (fm.name ?? "").trim();
  const description = (fm.description ?? "").trim();
  if (!name) return c.redirect("/skills?error=no_name");
  if (!description) return c.redirect("/skills?error=no_description");

  const id = slugify(name);
  if (!id) return c.redirect("/skills?error=bad_id");

  const existing = getSkill(id);
  if (existing && existing.is_managed) {
    return c.redirect("/skills?error=managed");
  }

  upsertSkill({
    id,
    layer: "custom",
    name,
    description,
    version: fm.version ?? "0.1.0",
    is_managed: false,
  });
  putSkillFile(id, "SKILL.md", new TextEncoder().encode(skillMd), "text/markdown");

  logAudit(user.id, user.username, "skill_uploaded", { detail: id });
  return c.redirect("/skills?saved=added");
});

webRoutes.post("/skills/import", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const sourceInput = ((body["source"] as string | undefined) ?? "").trim();
  const allowUntrusted = body["allow_untrusted"] === "1";

  const src = parseSkillSource(sourceInput);
  if (!src) return c.redirect("/skills?error=bad_source");

  const trusted = isTrustedSource(src.owner);
  if (!trusted && !allowUntrusted) {
    return c.redirect("/skills?error=untrusted");
  }

  let files;
  try {
    files = await fetchSkillBundle(src);
  } catch (err) {
    const detail = (err as Error).message ?? "fetch failed";
    return c.redirect(
      `/skills?error=fetch_failed&detail=${encodeURIComponent(detail)}`,
    );
  }

  const skillMdFile = files.find((f) => f.path === "SKILL.md")!;
  const skillMdText = new TextDecoder().decode(skillMdFile.content);
  if (skillMdText.length > MAX_SKILL_MD_BYTES) {
    return c.redirect("/skills?error=too_large");
  }
  if (!SKILL_FRONTMATTER_RE.test(skillMdText)) {
    return c.redirect("/skills?error=no_frontmatter");
  }

  const fm = parseSkillFrontmatter(skillMdText);
  const name = (fm.name ?? "").trim();
  const description = (fm.description ?? "").trim();
  if (!name) return c.redirect("/skills?error=no_name");
  if (!description) return c.redirect("/skills?error=no_description");

  const id = slugify(name);
  if (!id) return c.redirect("/skills?error=bad_id");

  const existing = getSkill(id);
  if (existing && existing.is_managed) {
    return c.redirect("/skills?error=managed");
  }

  const sha = bundleSha256(files);

  upsertSkill({
    id,
    layer: "curated",
    name,
    description,
    version: fm.version ?? "0.1.0",
    is_managed: false,
    source_url: sourceUrl(src),
    signed: trusted,
    bundle_sha256: sha,
    approved_by: user.id,
  });

  // Re-import: drop stale files first so renamed/removed assets don't
  // linger in our copy.
  deleteSkillFiles(id);
  for (const f of files) {
    putSkillFile(id, f.path, f.content, mimeForPath(f.path));
  }

  logAudit(user.id, user.username, "skill_imported", {
    detail: `${id} ${trusted ? "signed" : "unverified"} sha256=${sha.slice(0, 12)} from ${src.owner}/${src.repo}${src.path ? "/" + src.path : ""}`,
  });
  return c.redirect("/skills?saved=imported");
});

webRoutes.post("/skills/:id/toggle", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const enabled = body["enabled"] === "1";
  const ok = setSkillEnabled(id, enabled);
  if (ok) {
    logAudit(
      user.id,
      user.username,
      enabled ? "skill_enabled" : "skill_disabled",
      { detail: id },
    );
  }
  return c.redirect("/skills?saved=toggled");
});

webRoutes.post("/skills/:id/delete", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const ok = deleteCustomSkill(id);
  if (ok) {
    logAudit(user.id, user.username, "skill_deleted", { detail: id });
  }
  return c.redirect(ok ? "/skills?saved=deleted" : "/skills?error=managed");
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

function publicBaseUrl(c: Context): string {
  if (process.env.DASHBOARD_DOMAIN) {
    return `https://${process.env.DASHBOARD_DOMAIN}`;
  }
  return new URL(c.req.url).origin;
}

webRoutes.get("/account", (c) => {
  const user = c.get("user");
  const enabled = isTotpEnabled(user);
  const backup = enabled ? getBackupCodeStatus(user.id) : null;
  const error = c.req.query("error");
  const pwError = c.req.query("pw_error");
  const pwSaved = c.req.query("pw_saved");
  const tokenRevoked = c.req.query("token_revoked");
  const tokens = listDevTokens(user.id);

  const passwordCard = `
    <div class="card">
      <h2>Password</h2>
      <p class="meta" style="margin-top:0.5rem;margin-bottom:0.75rem">
        Changing your password signs you out of other devices.
      </p>
      ${pwSaved ? '<p style="color:var(--ok);margin:0 0 0.75rem">Password updated.</p>' : ""}
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

  const tokensRows = tokens.length
    ? `<table style="width:100%;border-collapse:collapse;margin-top:0.75rem;font-size:0.9rem">
        <thead>
          <tr style="text-align:left;color:var(--text-muted);font-weight:500">
            <th style="padding:0.4rem 0.6rem 0.4rem 0">Name</th>
            <th style="padding:0.4rem 0.6rem">Last used</th>
            <th style="padding:0.4rem 0.6rem">Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${tokens
            .map(
              (t) => `
            <tr style="border-top:1px solid var(--border)">
              <td style="padding:0.5rem 0.6rem 0.5rem 0">${escapeHtml(t.name)}</td>
              <td style="padding:0.5rem 0.6rem;color:var(--text-muted)">${t.last_used_at ? escapeHtml(formatRelative(t.last_used_at)) : "never"}</td>
              <td style="padding:0.5rem 0.6rem;color:var(--text-muted)">${escapeHtml(formatRelative(t.created_at))}</td>
              <td style="padding:0.5rem 0 0.5rem 0.6rem;text-align:right">
                <form method="POST" action="/account/tokens/${escapeHtml(t.id)}/delete" style="margin:0" onsubmit="return confirm('Revoke this token? Any Claude Code session using it will lose access.')">
                  <button type="submit" class="danger" style="padding:0.25rem 0.6rem;font-size:0.75rem;width:auto">Revoke</button>
                </form>
              </td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>`
    : `<p class="meta" style="margin-top:0.75rem">You have no developer tokens yet.</p>`;

  const tokensCard = `
    <div class="card">
      <h2>Skill MCP tokens</h2>
      <p class="meta" style="margin-top:0.5rem">
        Connect Claude Code to this Runway instance's skill server.
        Each token is tied to your account; the token is shown only
        once when you generate it.
      </p>
      ${tokenRevoked ? '<p style="color:var(--ok);margin:0.75rem 0 0">Token revoked.</p>' : ""}
      ${tokensRows}
      <form method="POST" action="/account/tokens" style="margin-top:0.75rem">
        <div class="flex" style="gap:0.5rem">
          <input type="text" name="name" placeholder="Token label (e.g. laptop)" required maxlength="60" style="flex:1" />
          <button type="submit" style="width:auto">Generate token</button>
        </div>
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
      ${tokensCard}
    `,
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
    )
  );
});

webRoutes.post("/account/tokens", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const name = ((body["name"] as string | undefined) ?? "").trim();
  if (!name || name.length > 60) {
    return c.redirect("/account");
  }

  const created = createDevToken(user.id, name);
  logAudit(user.id, user.username, "dev_token_created", { detail: name });

  const base = publicBaseUrl(c);
  const mcpUrl = `${base}/mcp`;
  const installCmd = `claude mcp add runway-skills --transport http ${mcpUrl} --header "Authorization: Bearer ${created.token}"`;

  return c.html(
    layout(
      "Token created",
      `
      <h1>Developer token created</h1>
      <div class="card">
        <h2>${escapeHtml(created.name)}</h2>
        <p class="meta" style="margin-top:0.5rem">
          <strong>This is the only time the token will be shown.</strong>
          Store it in your password manager if you want to keep a copy.
        </p>
        <p style="margin-top:0.75rem;font-size:0.85rem">Token:</p>
        <pre style="background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:0.6rem 0.75rem;margin:0.25rem 0 0;font-family:monospace;font-size:0.85rem;user-select:all;word-break:break-all;white-space:pre-wrap">${escapeHtml(created.token)}</pre>
        <button type="button" style="margin-top:0.5rem;padding:0.3rem 0.7rem;font-size:0.8rem;width:auto" data-copy="${escapeHtml(created.token)}" onclick="copyText(this)">Copy token</button>

        <p style="margin-top:1.5rem;font-size:0.85rem">
          Paste this into a terminal to register the skill server with
          <a href="https://claude.ai/code" target="_blank" rel="noopener noreferrer" style="color:var(--brand)">Claude Code</a>:
        </p>
        <pre style="background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:0.6rem 0.75rem;margin:0.25rem 0 0;font-family:monospace;font-size:0.8rem;user-select:all;word-break:break-all;white-space:pre-wrap">${escapeHtml(installCmd)}</pre>
        <button type="button" style="margin-top:0.5rem;padding:0.3rem 0.7rem;font-size:0.8rem;width:auto" data-copy="${escapeHtml(installCmd)}" onclick="copyText(this)">Copy install command</button>

        <div style="margin-top:1.5rem">
          <a href="/account" style="color:var(--brand)">Back to account</a>
        </div>
      </div>
    `,
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
    )
  );
});

webRoutes.post("/account/tokens/:id/delete", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const removed = deleteDevToken(id, user.id);
  if (removed) {
    logAudit(user.id, user.username, "dev_token_revoked", { detail: id });
  }
  return c.redirect("/account?token_revoked=1");
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
  if (!verifyAndConsumeTotp(user.id, user.totp_secret, code)) {
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
        <pre style="margin-top:1rem;padding:1rem;background:var(--bg2);border:1px solid var(--line);border-radius:6px;font-family:monospace;font-size:0.95rem;line-height:1.6">${codes.map((c) => escapeHtml(c)).join("\n")}</pre>
        <div style="margin-top:1rem">
          <a href="/account" style="color:var(--tx)">I've saved them — back to account</a>
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
    verifyAndConsumeTotp(user.id, user.totp_secret!, code) ||
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
  if (!verifyAndConsumeTotp(user.id, user.totp_secret!, code)) {
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
        <pre style="margin-top:1rem;padding:1rem;background:var(--bg2);border:1px solid var(--line);border-radius:6px;font-family:monospace;font-size:0.95rem;line-height:1.6">${codes.map((c) => escapeHtml(c)).join("\n")}</pre>
        <div style="margin-top:1rem">
          <a href="/account" style="color:var(--tx)">I've saved them — back to account</a>
        </div>
      </div>
    `,
      { username: user.username, csrf: csrfField(c), isAdmin: isAdmin(user) }
    )
  );
});
