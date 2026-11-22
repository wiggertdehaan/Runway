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

function statusCell(app: AtRiskApp, now: number): string {
  if (app.state === "quarantined") {
    const since = parse(app.quarantinedAt);
    return `<strong style="color:var(--status-error)">Offline</strong>${
      since !== null ? ` since ${esc(utc(since))}` : ""
    }<div class="meta">Comes back by itself once a rebuild or deploy fixes it.</div>`;
  }
  const at = offlineAt(app);
  if (at === null) return `<strong style="color:var(--status-warn)">Goes offline</strong> unless fixed`;
  const left = at - now;
  const colour = left < URGENT_MS ? "var(--status-error)" : "var(--status-warn)";
  const exempt = parse(app.exemptUntil);
  const note =
    exempt !== null && exempt > now
      ? `<div class="meta">Exemption until ${esc(utc(exempt))}</div>`
      : "";
  return `<strong style="color:${colour}">Goes offline ${esc(fmtCountdown(left))}</strong><div class="meta">${esc(utc(at))}</div>${note}`;
}

/**
 * Banner listing every app that is offline or will go offline. Empty
 * string when there is nothing to show.
 */
export function renderSecurityAttention(apps: AtRiskApp[], now: number): string {
  if (apps.length === 0) return "";
  const sorted = sortAtRisk(apps);
  const offline = sorted.filter((a) => a.state === "quarantined").length;
  const pending = sorted.length - offline;
  const counts: string[] = [];
  if (offline > 0) counts.push(`${offline} offline`);
  if (pending > 0) counts.push(`${pending} will go offline if nothing is done`);
  const rows = sorted
    .map(
      (a) => `<tr>
        <td><a href="/apps/${encodeURIComponent(a.id)}#quarantine">${esc(a.name)}</a></td>
        <td class="meta">${a.owner ? esc(a.owner) : "&mdash;"}</td>
        <td>${statusCell(a, now)}</td>
        <td class="meta">${esc(a.cves.join(", "))}</td>
      </tr>`
    )
    .join("");
  return `<div class="card" style="border-color:var(--status-error);margin-bottom:1rem">
    <strong>Security attention</strong> <span class="meta">&middot; ${esc(counts.join(", "))}</span>
    <p class="meta" style="margin:0.25rem 0 0.5rem">These apps contain a vulnerability that is being actively exploited (CISA KEV). The owner fixes it with a rebuild or a new deploy. If nothing happens, one last automatic rebuild is tried at the time shown and the app is taken offline when that does not fix it.</p>
    <table><thead><tr><th>App</th><th>Owner</th><th>What happens</th><th>Actively exploited</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;
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
