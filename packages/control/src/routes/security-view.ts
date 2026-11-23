/**
 * Dashboard security overview: which apps go offline if nobody acts, and
 * whether the exploited-vulnerability check itself is working.
 *
 * Pure functions over plain data, so ordering and wording are testable
 * without a database; web.ts gathers the data. Nothing here may touch the
 * network: the dashboard re-renders this every few seconds per viewer.
 */

export interface AtRiskApp {
  id: string;
  name: string;
  /** Username of the app's owner, if known. */
  owner: string | null;
  state: "grace" | "quarantined";
  /** Actively exploited CVE ids found in the running app. */
  cves: string[];
  /** When the grace term ends (ISO), or null when unknown. */
  deadline: string | null;
  quarantinedAt: string | null;
  /** End of an admin exemption that is active right now (ISO), else null. */
  exemptUntil: string | null;
}

export interface KevCacheInfo {
  /** ISO time the KEV list was last fetched. */
  fetchedAt: string;
  /** Number of CVEs on the list. */
  count: number;
}

export interface ScanCoverage {
  /** Apps that are running and therefore should be checked. */
  running: number;
  /** How many of those have a vulnerability scan on record. */
  scanned: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The list refreshes daily; past this age something is wrong. */
export const KEV_STALE_MS = 2 * DAY;
/** Less than this left: show it as urgent. */
export const URGENT_MS = DAY;

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function utc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function parse(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * When the app is taken offline if nothing changes (epoch ms), or null
 * when it is already offline or the moment is unknown. An active
 * exemption postpones it to the end of the exemption. The platform tries
 * one last rebuild at this moment, so the real cut-off is a few minutes
 * later and only happens when that rebuild does not fix it.
 */
export function offlineAt(app: AtRiskApp): number | null {
  if (app.state === "quarantined") return null;
  const deadline = parse(app.deadline);
  if (deadline === null) return null;
  const exempt = parse(app.exemptUntil);
  return exempt !== null && exempt > deadline ? exempt : deadline;
}

/** "in 3d 4h", "in 5h 12m", "in 12m", "any moment now". */
export function fmtCountdown(msLeft: number): string {
  if (msLeft < 60_000) return "any moment now";
  const days = Math.floor(msLeft / DAY);
  const hours = Math.floor((msLeft % DAY) / HOUR);
  const minutes = Math.floor((msLeft % HOUR) / 60_000);
  if (days >= 1) return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
  if (hours >= 1) return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  return `in ${minutes}m`;
}

/** "3 days", "5 hours", "12 minutes": how old something is. */
function fmtAge(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (ms >= DAY) return plural(Math.floor(ms / DAY), "day");
  if (ms >= HOUR) return plural(Math.floor(ms / HOUR), "hour");
  return plural(Math.max(0, Math.floor(ms / 60_000)), "minute");
}

/** Offline apps first, then whoever goes offline soonest; unknown last. */
export function sortAtRisk(apps: AtRiskApp[]): AtRiskApp[] {
  const rank = (a: AtRiskApp): [number, number] => {
    if (a.state === "quarantined") return [0, parse(a.quarantinedAt) ?? 0];
    return [1, offlineAt(a) ?? Number.POSITIVE_INFINITY];
  };
  return [...apps].sort((a, b) => {
    const [ga, ta] = rank(a);
    const [gb, tb] = rank(b);
    return ga - gb || ta - tb || a.name.localeCompare(b.name);
  });
}

/**
 * What happens to one app, as a short headline plus an optional detail
 * line. The countdown is the headline: it is the one thing that decides
 * how soon somebody has to act.
 */
export function attentionWhen(app: AtRiskApp, now: number): { headline: string; tone: "err" | "warn"; detail: string | null } {
  if (app.state === "quarantined") {
    const since = parse(app.quarantinedAt);
    return {
      headline: since !== null ? `Offline since ${utc(since)}` : "Offline",
      tone: "err",
      detail: "Comes back by itself once a rebuild or deploy fixes it.",
    };
  }
  const at = offlineAt(app);
  if (at === null) return { headline: "Goes offline unless fixed", tone: "warn", detail: null };
  const left = at - now;
  const exempt = parse(app.exemptUntil);
  return {
    headline: `Goes offline ${fmtCountdown(left)}`,
    tone: left < URGENT_MS ? "err" : "warn",
    detail:
      exempt !== null && exempt > now ? `Exemption until ${utc(exempt)}` : utc(at),
  };
}

/**
 * Strip above the apps listing every app that is offline or will go
 * offline. One row per app: name, the countdown, the CVE ids, and what
 * you can do about it. The long policy text sits behind a disclosure so
 * the app comes first. Empty string when there is nothing to show.
 *
 * `admin` only decides what else is shown (the owner name). Everybody
 * who sees a row may rebuild that app: an owner is only ever given their
 * own apps, an administrator all of them. The server enforces the same
 * rule on the rebuild route.
 */
export function renderSecurityAttention(apps: AtRiskApp[], now: number, admin = false): string {
  if (apps.length === 0) return "";
  const sorted = sortAtRisk(apps);
  const offline = sorted.filter((a) => a.state === "quarantined").length;
  const pending = sorted.length - offline;
  const title = `${sorted.length} app${sorted.length === 1 ? "" : "s"} need${sorted.length === 1 ? "s" : ""} attention`;
  const counts: string[] = [];
  if (offline > 0) counts.push(`${offline} offline`);
  if (pending > 0) counts.push(`${pending} will go offline if nothing is done`);
  const rows = sorted
    .map((a) => {
      const w = attentionWhen(a, now);
      const id = encodeURIComponent(a.id);
      const rebuild = `<form method="POST" action="/apps/${id}/rebuild" class="attn-form"><button type="submit" class="ghost">Rebuild</button></form>`;
      return `<li class="attn-row">
        <div class="attn-main">
          <div class="attn-top"><a class="app-name" href="/apps/${id}#quarantine">${esc(a.name)}</a> <strong class="attn-when attn-${w.tone}">${esc(w.headline)}</strong></div>
          <div class="meta">${esc(a.cves.join(", "))}${a.owner && admin ? ` &middot; owner ${esc(a.owner)}` : ""}${w.detail ? ` &middot; ${esc(w.detail)}` : ""}</div>
        </div>
        <div class="attn-acts"><a class="btn-link" href="/apps/${id}#quarantine">Open</a>${rebuild}</div>
      </li>`;
    })
    .join("");
  const how =
    "Each of these apps contains a vulnerability that is being actively exploited (CISA KEV). A rebuild or a new deploy with fixed dependencies clears it, and your agent can do the second. Open an app for the steps. If nothing happens, one last automatic rebuild is tried at the time shown and the app is taken offline when that does not fix it.";
  return `<section class="attn" aria-label="Security attention">
    <div class="attn-head"><strong>${esc(title)}</strong> <span class="meta">&middot; ${esc(counts.join(", "))}</span></div>
    <ul class="attn-list">${rows}</ul>
    <details class="attn-how"><summary>What happens next?</summary><p class="meta">${esc(how)}</p></details>
  </section>`;
}

/** Small badge for an app card; empty unless the app is counting down. */
export function renderRiskBadge(app: AtRiskApp | undefined, now: number): string {
  if (!app || app.state === "quarantined") return "";
  const at = offlineAt(app);
  const label = at === null ? "goes offline" : `offline ${fmtCountdown(at - now)}`;
  const cls = at !== null && at - now < URGENT_MS ? "badge-quarantined" : "badge-building";
  const title = `Actively exploited: ${app.cves.join(", ")}. Rebuild or deploy to fix it${
    at === null ? "" : ` before ${utc(at)}`
  }.`;
  return `<span class="badge ${cls}" title="${esc(title)}">${esc(label)}</span>`;
}

/**
 * One always-visible line saying whether the exploited-vulnerability
 * check works. Without it, "no banner" cannot be told apart from "the
 * check is broken".
 */
export function renderKevStatus(
  kev: KevCacheInfo | null,
  coverage: ScanCoverage,
  atRisk: number,
  now: number,
  admin: boolean
): string {
  const line = (colour: string, text: string) =>
    `<p class="meta" style="margin:0 0 0.75rem"><span style="color:${colour}">&#9679;</span> ${text}</p>`;

  const fetched = kev ? parse(kev.fetchedAt) : null;
  if (!kev || fetched === null) {
    return line(
      "var(--status-error)",
      `<strong style="color:var(--status-error)">Exploited-vulnerability check is off:</strong> the CISA KEV list could not be loaded, so no app is being checked.${
        admin ? " Look for <code>[kev]</code> in the control log." : ""
      }`
    );
  }

  const age = now - fetched;
  const list = `KEV list of ${esc(utc(fetched))} (${kev.count} CVEs)`;
  if (age > KEV_STALE_MS) {
    return line(
      "var(--status-warn)",
      `<strong style="color:var(--status-warn)">Exploited-vulnerability check is running on an old list:</strong> ${list} is ${esc(fmtAge(age))} old; newer exploited vulnerabilities are not detected.${
        admin ? " Look for <code>[kev]</code> in the control log." : ""
      }`
    );
  }

  const parts = [`Exploited-vulnerability check active`, list];
  const missing = coverage.running - coverage.scanned;
  if (coverage.running > 0) {
    parts.push(
      missing > 0
        ? `<span style="color:var(--status-warn)">${coverage.scanned} of ${coverage.running} running apps scanned, ${missing} not yet</span>`
        : `${coverage.running} running app${coverage.running === 1 ? "" : "s"} scanned`
    );
  }
  parts.push(
    atRisk > 0
      ? `<span style="color:var(--status-error)">${atRisk} need${atRisk === 1 ? "s" : ""} attention</span>`
      : "none at risk"
  );
  return line(
    missing > 0 || atRisk > 0 ? "var(--status-warn)" : "var(--status-success)",
    parts.join(" &middot; ")
  );
}
