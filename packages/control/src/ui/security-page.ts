/**
 * The /security page: one place that answers "which apps are in trouble
 * with an actively exploited vulnerability (CISA KEV), and which have
 * other findings worth a look".
 *
 * Pure functions over plain data (no database, no Docker, no network), so
 * ordering, counts and wording are testable; web.ts gathers the rows.
 * The caller hands over only the apps the viewer may see: an admin gets
 * every app, an owner their own. Nothing here widens that set, so the
 * counts (tiles, sidebar) can never reveal somebody else's apps.
 */
import { attentionWhen, offlineAt, type AtRiskApp } from "../routes/security-view.js";
import type { AppStatus, SecurityChip } from "./status.js";

export interface SecurityApp {
  id: string;
  name: string;
  /** Username of the owner, or null. Only shown to admins. */
  owner: string | null;
  /** The app's KEV term or quarantine, when it has one. */
  kev: AtRiskApp | undefined;
  /** The shared status model: the chip carries the non-KEV findings. */
  status: Pick<AppStatus, "security">;
  /** A rebuild needs a built image to start from. */
  hasImage: boolean;
}

export interface SecuritySplit {
  /** In a KEV term or quarantined: offline first, then soonest deadline. */
  action: SecurityApp[];
  /** No KEV, but a scan result worth reading (warn or error chip). */
  findings: SecurityApp[];
  /** Everything else: a passed scan, a low-only scan, no scan yet. */
  clean: SecurityApp[];
}

function byName(a: SecurityApp, b: SecurityApp): number {
  return a.name.localeCompare(b.name);
}

const TONE_RANK: Record<SecurityChip["tone"], number> = { err: 0, warn: 1, neutral: 2, ok: 3 };

export function splitSecurity(apps: SecurityApp[]): SecuritySplit {
  const action: SecurityApp[] = [];
  const findings: SecurityApp[] = [];
  const clean: SecurityApp[] = [];
  for (const a of apps) {
    const tone = a.status.security?.tone;
    if (a.kev) action.push(a);
    else if (tone === "warn" || tone === "err") findings.push(a);
    else clean.push(a);
  }
  const rank = (a: SecurityApp): [number, number] => {
    const k = a.kev as AtRiskApp;
    if (k.state === "quarantined") return [0, Date.parse(k.quarantinedAt ?? "") || 0];
    return [1, offlineAt(k) ?? Number.POSITIVE_INFINITY];
  };
  action.sort((a, b) => {
    const [ga, ta] = rank(a);
    const [gb, tb] = rank(b);
    return ga - gb || ta - tb || byName(a, b);
  });
  findings.sort(
    (a, b) =>
      TONE_RANK[a.status.security?.tone ?? "neutral"] - TONE_RANK[b.status.security?.tone ?? "neutral"] ||
      byName(a, b)
  );
  clean.sort(byName);
  return { action, findings, clean };
}

export interface SecurityTile {
  key: "offline" | "term" | "findings" | "clean";
  n: number;
  label: string;
  /** Colour only when there is something to say; zero stays neutral. */
  tone: "err" | "warn" | "ok" | "none";
}

export function securityTiles(split: SecuritySplit): SecurityTile[] {
  const offline = split.action.filter((a) => a.kev?.state === "quarantined").length;
  const term = split.action.length - offline;
  return [
    { key: "offline", n: offline, label: offline === 1 ? "App offline" : "Apps offline", tone: offline > 0 ? "err" : "none" },
    { key: "term", n: term, label: "KEV term running", tone: term > 0 ? "warn" : "none" },
    { key: "findings", n: split.findings.length, label: "With findings", tone: split.findings.length > 0 ? "warn" : "none" },
    { key: "clean", n: split.clean.length, label: "Clean", tone: split.clean.length > 0 ? "ok" : "none" },
  ];
}

/**
 * The number next to "Security" in the sidebar: apps in a KEV term or
 * offline. The same number the home page's attention strip counts. Empty
 * for zero (no badge), "99+" for very large.
 */
export function navCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderTiles(tiles: SecurityTile[]): string {
  return `<div class="sec-tiles">${tiles
    .map((t) => `<div class="sec-tile sec-${t.tone}" data-tile="${t.key}"><b>${t.n}</b><span>${esc(t.label)}</span></div>`)
    .join("")}</div>`;
}

function renderActionRow(a: SecurityApp, now: number, admin: boolean): string {
  const kev = a.kev as AtRiskApp;
  const id = encodeURIComponent(a.id);
  const w = attentionWhen(kev, now);
  const state =
    kev.state === "quarantined"
      ? `<span class="tag tag-err">Offline</span>`
      : `<span class="tag tag-warn">Term running</span>`;
  const owner = admin && a.owner ? `<span class="meta sec-sub">owner ${esc(a.owner)}</span>` : "";
  const rebuild = a.hasImage
    ? `<form method="POST" action="/apps/${id}/rebuild" class="attn-form"><button type="submit" class="ghost">Rebuild</button></form>`
    : "";
  return `<tr class="sec-row sec-row-${w.tone}">
    <td class="sc-app" data-label="App"><a class="app-name" href="/apps/${id}#quarantine">${esc(a.name)}</a>${owner}</td>
    <td class="sc-state" data-label="State">${state}</td>
    <td class="sc-cve" data-label="Vulnerability"><code>${esc(kev.cves.join(", ") || "unknown")}</code></td>
    <td class="sc-when" data-label="Deadline"><strong class="attn-${w.tone}">${esc(w.headline)}</strong>${w.detail ? `<span class="meta sec-sub">${esc(w.detail)}</span>` : ""}</td>
    <td class="sc-act"><div class="attn-acts"><a class="btn-link" href="/apps/${id}#quarantine">Open</a>${rebuild}</div></td>
  </tr>`;
}

/**
 * The detail cell of a finding row. The status chip carries terse
 * fragments ("+4 other", "Last deploy blocked"); "+4 other" alone does not
 * say what the four are, so it is spelled out.
 */
export function findingDetail(chip: Pick<SecurityChip, "detail">): string {
  const d = chip.detail;
  if (!d) return "Below the blocking threshold.";
  const m = d.match(/^\+(\d+) other$/);
  if (m) {
    const n = Number(m[1]);
    return `Plus ${n} lower-severity finding${n === 1 ? "" : "s"}.`;
  }
  return d;
}

function renderFindingRow(a: SecurityApp, admin: boolean): string {
  const id = encodeURIComponent(a.id);
  const chip = a.status.security as SecurityChip;
  const owner = admin && a.owner ? `<span class="meta sec-sub">owner ${esc(a.owner)}</span>` : "";
  return `<tr class="sec-row">
    <td class="sc-app" data-label="App"><a class="app-name" href="/apps/${id}#scan">${esc(a.name)}</a>${owner}</td>
    <td class="sc-state" data-label="Result"><span class="tag tag-${chip.tone}">${esc(chip.label)}</span></td>
    <td class="sc-cve" data-label="Detail"><span class="meta">${esc(findingDetail(chip))}</span></td>
    <td class="sc-act"><div class="attn-acts"><a class="btn-link" href="/apps/${id}#scan">View</a></div></td>
  </tr>`;
}

export interface SecurityPageInput {
  apps: SecurityApp[];
  now: number;
  admin: boolean;
  /** Pre-rendered "is the KEV check working" line (renderKevStatus). */
  kevStatusHtml: string;
  /** Grace term in days, for the policy text. */
  termDays: number;
}

/** The body of the /security page (without the layout). */
export function renderSecurityPage(i: SecurityPageInput): string {
  const split = splitSecurity(i.apps);
  const tiles = renderTiles(securityTiles(split));

  const action =
    split.action.length === 0
      ? `<p class="sec-ok">No app is in a KEV term or offline. Nothing needs action.</p>`
      : `<table class="apps-tbl sec-tbl" aria-label="Apps that need action">
          <thead><tr><th>App</th><th>State</th><th>Vulnerability</th><th>Deadline</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${split.action.map((a) => renderActionRow(a, i.now, i.admin)).join("")}</tbody>
        </table>`;

  const findings =
    split.findings.length === 0
      ? ""
      : `<h2 class="sec-h">With findings</h2>
        <p class="hint">Not actively exploited, but the last scan found something worth reading.</p>
        <table class="apps-tbl sec-tbl" aria-label="Apps with findings">
          <thead><tr><th>App</th><th>Result</th><th>Detail</th><th><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${split.findings.map((a) => renderFindingRow(a, i.admin)).join("")}</tbody>
        </table>`;

  const clean =
    split.clean.length === 0
      ? ""
      : `<h2 class="sec-h">Clean</h2>
        <div class="sec-pills">${split.clean
          .map((a) => `<a class="sec-pill" href="/apps/${encodeURIComponent(a.id)}#scan">${esc(a.name)}</a>`)
          .join("")}</div>`;

  const empty =
    i.apps.length === 0
      ? `<p class="meta">No apps yet. Security results show up here after the first deploy.</p>`
      : "";

  const how = `When a flaw from the CISA Known Exploited Vulnerabilities list is found in an app, its owner is notified and a term of ${i.termDays} day${i.termDays === 1 ? "" : "s"} starts. If the flaw is still there when the term ends and one last automatic rebuild did not fix it, the app is taken offline until a rebuild or deploy that does. Data and volumes are kept. An administrator can pause the term with an exemption.`;

  return `<h1>Security</h1>
    <p class="meta sec-lead">Actively exploited vulnerabilities (CISA KEV) and what Runway does about them.</p>
    ${i.kevStatusHtml}
    ${tiles}
    <h2 class="sec-h">Needs action</h2>
    ${action}
    ${findings}
    ${clean}
    ${empty}
    <details class="attn-how sec-how"><summary>How the KEV policy works</summary><p class="meta">${esc(how)}</p></details>`;
}
