/**
 * Pure pieces of the app page: who may rebuild, the KEV block (countdown,
 * plain-language explanation, the three ways out), the prompt an owner can
 * hand to their coding agent, the one-line reason behind a deploy status and
 * the rebuild line for one app.
 *
 * No database, no Docker, no network: the caller gathers the inputs.
 */
import { attentionWhen, offlineAt, type AtRiskApp } from "../routes/security-view.js";
import type { RebuildAppResult, RebuildRun } from "../db/rebuild-runs.js";

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tab ids of the app page, in the order they are shown. */
export const APP_TABS = ["deploys", "security", "config", "access"] as const;
export type AppTab = (typeof APP_TABS)[number];

/**
 * Who may start a rebuild of an app: an admin, or the app's owner (by user id).
 * The route also sits behind requireAppAccess, which enforces the same rule
 * for every /apps/:id/* path; this is the second, explicit check so the
 * rebuild route stays safe if that middleware is ever reordered.
 */
export function mayRebuild(
  user: { id: string; role: string },
  app: { owner_user_id: string | null }
): boolean {
  if (user.role === "admin") return true;
  return app.owner_user_id !== null && app.owner_user_id === user.id;
}

/** Why a rebuild cannot start for this app right now, or null when it can. */
export function rebuildBlockedReason(app: { image_tag: string | null }): string | null {
  return app.image_tag ? null : "Deploy the app once first: a rebuild needs a built image to start from.";
}

/**
 * Who may start a rescan of an app: the same people as for a rebuild, an
 * admin or the user who created the app; an app without an owner is
 * admin-only. Kept as its own function so the two rights can diverge
 * without a hidden coupling.
 */
export function mayRescan(
  user: { id: string; role: string },
  app: { owner_user_id: string | null }
): boolean {
  return mayRebuild(user, app);
}

/** Why a rescan cannot start for this app right now, or null when it can. */
export function rescanBlockedReason(app: { image_tag: string | null; status: string }): string | null {
  if (!app.image_tag) return "Deploy the app once first: a rescan needs a built image.";
  if (app.status !== "running") return "A rescan needs a running app.";
  return null;
}

/**
 * Text an owner can paste into their coding agent. It names the app and
 * the CVEs and tells the agent what "fixed" means, so the owner does not
 * have to understand the vulnerability to act on it.
 */
export function agentPrompt(app: { id: string; name: string }, cves: string[]): string {
  const list = cves.length > 0 ? cves.join(", ") : "an actively exploited vulnerability";
  return [
    `Runway reports that my app "${app.name}" (id ${app.id}) contains ${list}, which is being exploited in the wild (CISA KEV).`,
    "Find which package or base image brings it in (check the Dockerfile FROM line and requirements.txt / package.json),",
    "update it to a version that fixes it, then redeploy with Runway and check that the scan no longer lists it.",
    "If no fixed version exists yet, tell me what is blocking you instead of guessing.",
  ].join(" ");
}

export interface DeployReasonInput {
  status: string;
  scan_summary: string | null;
  log: string | null;
}

/**
 * One line that says why a deploy ended the way it did, for the Deploys
 * table. Null for a plain success. Counts come from the scan summary;
 * a failed deploy shows the last non-empty line of its log.
 */
export function deployReason(d: DeployReasonInput): string | null {
  if (d.status === "success") return null;
  let counts: Record<string, number> = {};
  try {
    const parsed = d.scan_summary ? (JSON.parse(d.scan_summary) as { counts?: Record<string, number> }) : null;
    counts = parsed?.counts ?? {};
  } catch {
    /* an unreadable summary is no reason to hide the deploy */
  }
  const crit = counts.critical ?? 0;
  const high = counts.high ?? 0;
  if (d.status === "blocked") {
    return crit + high > 0
      ? `Blocked by the scan: ${crit} critical, ${high} high`
      : "Blocked by the scan";
  }
  if (d.status === "warned") {
    return crit + high > 0 ? `Went live with ${crit} critical, ${high} high` : "Went live with scan warnings";
  }
  if (d.status === "failed") {
    const last = (d.log ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    return last ? `Failed: ${last.slice(0, 160)}` : "Failed";
  }
  return null;
}

export type RebuildLine =
  | { state: "none" }
  | { state: "running"; scope: "app" | "all" }
  | { state: "done"; outcome: RebuildAppResult["outcome"]; detail: string | null; at: string | null; runId: number };

/**
 * What to say about rebuilds on one app's page. A run that is busy now
 * wins; otherwise the newest finished run that touched this app. An owner
 * only ever sees their own app's entry, never the rest of a run.
 */
export function rebuildLine(
  runs: RebuildRun[],
  appId: string,
  active: { runId: number; appIds: string[] | null } | null
): RebuildLine {
  if (active && (active.appIds === null || active.appIds.includes(appId))) {
    return { state: "running", scope: active.appIds === null ? "all" : "app" };
  }
  for (const run of runs) {
    if (run.status !== "done") continue;
    const r = run.results.find((x) => x.app_id === appId);
    if (r) {
      return { state: "done", outcome: r.outcome, detail: r.detail ?? null, at: run.finished_at, runId: run.id };
    }
    // A run that stopped before it got to any app (Trivy missing, crash) is
    // recorded under app_id "-". It is the newest word on this app too: do
    // not fall through to an older, happier run. Its message stays out of an
    // owner's page (it can name internals); the admin has it on /rebuild.
    if (run.results.some((x) => x.app_id === "-")) {
      return {
        state: "done",
        outcome: "failed",
        detail: "The rebuild run stopped before it reached this app. An admin can see why on the Rebuild page.",
        at: run.finished_at,
        runId: run.id,
      };
    }
  }
  return { state: "none" };
}

const OUTCOME_WORDS: Record<RebuildAppResult["outcome"], string> = {
  rebuilt: "Rebuilt and live",
  rolled_back: "Rebuilt, but the new version did not start; the old one is running",
  blocked: "Rebuilt, but the scan blocked the new version; the old one is running",
  failed: "Rebuild failed",
  skipped: "Skipped",
};

/** The rebuild line as HTML. While a run is busy it re-polls itself. */
export function renderRebuildLine(line: RebuildLine, appId: string, fmtWhen: (iso: string | null) => string): string {
  const url = `/apps/${encodeURIComponent(appId)}/rebuild-status`;
  if (line.state === "running") {
    return `<div class="rb-line rb-running" id="rebuild-line" role="status" hx-get="${url}" hx-trigger="every 5s" hx-swap="outerHTML">
      <span class="dot" aria-hidden="true"></span> Rebuild running${line.scope === "all" ? " (all apps, this one is in the queue)" : ""}. A build takes a few minutes; this updates by itself.
    </div>`;
  }
  if (line.state === "done") {
    const tone = line.outcome === "rebuilt" ? "ok" : line.outcome === "skipped" ? "neutral" : "err";
    return `<div class="rb-line rb-${tone}" id="rebuild-line" role="status">
      <strong>${esc(OUTCOME_WORDS[line.outcome])}</strong>${line.detail ? ` <span class="meta">${esc(line.detail)}</span>` : ""}
      <span class="meta">${esc(fmtWhen(line.at))}</span>
    </div>`;
  }
  return `<div id="rebuild-line"></div>`;
}

export interface KevBlockInput {
  app: { id: string; name: string };
  kev: AtRiskApp;
  now: number;
  /** May this user start a rebuild right now (rights + image present + none running)? */
  canRebuild: boolean;
  /** Why not, shown instead of the button. */
  rebuildDisabledReason: string | null;
  /** May this user start a rescan right now? Omitted = no button. */
  canRescan?: boolean;
  /** Admins can grant more time; everybody else is told who to ask. */
  isAdmin: boolean;
  csrf?: string;
}

/**
 * The block above the tabs when an app has an exploited vulnerability.
 * The countdown is the headline; below it, in plain words, what is going
 * on and the three ways out: rebuild, ask the agent, or get more time.
 */
export function renderKevBlock(i: KevBlockInput): string {
  const when = attentionWhen(i.kev, i.now);
  const cves = i.kev.cves.length > 0 ? i.kev.cves.map((c) => `<code>${esc(c)}</code>`).join(" ") : "an actively exploited vulnerability";
  const offline = i.kev.state === "quarantined";
  const explain = offline
    ? `This app was taken offline because it still contained ${cves}, which attackers are using right now. Visitors see a maintenance page. Your data and volumes are kept, and the app comes back by itself as soon as a rebuild or deploy removes the vulnerability.`
    : `This app contains ${cves}, which attackers are using right now (CISA's list of known exploited vulnerabilities). If it is not fixed in time the app is taken offline. Nothing is lost when that happens: data and volumes are kept and it returns once it is fixed.`;

  const rebuild = i.canRebuild
    ? `<form method="POST" action="/apps/${encodeURIComponent(i.app.id)}/rebuild" onsubmit="return confirm('Rebuild this app from source without cache? It can take a few minutes.')"><button type="submit">Rebuild now</button></form>`
    : `<p class="meta">${esc(i.rebuildDisabledReason ?? "You cannot rebuild this app.")}</p>`;
  const rescan = i.canRescan
    ? `<form method="POST" action="/apps/${encodeURIComponent(i.app.id)}/rescan" class="kev-rescan"><span class="meta">Already deployed a fix? Check it now instead of waiting for the daily scan.</span> <button type="submit" class="ghost">Rescan now</button></form>`
    : "";
  const prompt = agentPrompt(i.app, i.kev.cves);
  const more = i.isAdmin
    ? `Grant an exemption under <a href="#quarantine">Security</a>. It needs a reason, is kept in the audit log and has an end date.`
    : `Only an admin can extend the term. Ask them, and name the reason (for example that the fix needs a change you are still testing).`;

  return `<section class="kev kev-${when.tone}" id="kev" aria-labelledby="kev-h">
    <div class="kev-head">
      <h2 id="kev-h" class="kev-count">${esc(when.headline)}</h2>
      ${when.detail ? `<span class="meta">${esc(when.detail)}</span>` : ""}
    </div>
    <p class="kev-why">${explain}</p>
    <ol class="kev-steps">
      <li><strong>Rebuild it.</strong> A rebuild fetches newer base images and, if this app has automatic updates on, newer packages. If the new build is not worse, it goes live.${rebuild}</li>
      <li><strong>Ask your agent to fix it.</strong> Paste this into Claude Code or the agent you use for this app.
        <div class="kev-prompt"><textarea readonly rows="6" aria-label="Prompt for your agent">${esc(prompt)}</textarea>
        <button type="button" class="ghost" data-copy="${esc(prompt)}" onclick="copyText(this)">Copy prompt</button></div></li>
      <li><strong>Get more time.</strong> ${more}</li>
    </ol>
    ${rescan}
  </section>`;
}

/** Is there anything on the page that needs the owner right now? */
export function kevSeconds(kev: AtRiskApp, now: number): number | null {
  const at = offlineAt(kev);
  return at === null ? null : Math.max(0, Math.floor((at - now) / 1000));
}
