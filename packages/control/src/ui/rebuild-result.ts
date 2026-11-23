/**
 * The result of a rebuild run, in words.
 *
 * The old table had a column of "1C / 4H / 9M . 1 KEV" and a "Note" cell
 * that stacked badges, base-image digests and raw error text. This turns
 * one run into: four tiles (how it went), and per app one outcome word,
 * a sentence about what changed, and one before/after scan line.
 *
 * Pure functions over a stored run (no database, no Docker, no network).
 * Two rules matter for safety:
 *  - the viewer is always an admin (the page is admin-only), but the text
 *    is still written for an owner to read: failure reasons are
 *    classified into plain sentences, never the raw build or Docker
 *    output, and anything free-form passes through {@link redact};
 *  - everything that reaches the HTML goes through {@link esc}.
 */
import type { RebuildAppResult, RebuildOutcome, RebuildRun, SeverityCounts } from "../db/rebuild-runs.js";

export type Tone = "ok" | "warn" | "err" | "neutral";

export interface OutcomeView {
  label: string;
  tone: Tone;
}

const OUTCOMES: Record<RebuildOutcome, OutcomeView> = {
  rebuilt: { label: "Rebuilt", tone: "ok" },
  rolled_back: { label: "Rolled back", tone: "warn" },
  blocked: { label: "Not deployed", tone: "warn" },
  failed: { label: "Failed", tone: "err" },
  skipped: { label: "Skipped", tone: "neutral" },
};

export function outcomeView(o: string): OutcomeView {
  return OUTCOMES[o as RebuildOutcome] ?? { label: o.replace(/_/g, " "), tone: "neutral" };
}

function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip what must never reach a page: credentials, tokens, file paths. */
export function redact(s: string): string {
  return s
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[redacted]")
    .replace(
      /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|authorization|credential)[A-Za-z0-9_.-]*)\s*[=:]\s*\S+/gi,
      "$1=[redacted]"
    )
    .replace(/\b(?:sk|ghp|gho|ghs|glpat|xox[bap])[-_A-Za-z0-9]{12,}/g, "[redacted]")
    .replace(/\bAKIA[A-Z0-9]{12,}/g, "[redacted]")
    .replace(/(?:^|(?<=[\s("'=]))\/(?:Users|home|root|var|opt|data|tmp|app|exchange|gateway-config)\/[^\s'")]+/g, "[path]");
}

/** First line, redacted, capped. For free text that is ours but not fixed. */
export function shortText(s: string, max = 200): string {
  const first = redact(s.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

const FAILED_WORDS: Array<[RegExp, string]> = [
  [/health/i, "The new container did not pass its health check."],
  [/time(?:d)?[ -]?out/i, "The rebuild timed out."],
  [/preflight|rejected/i, "The source was rejected before the build started."],
  [/build|exit(?:ed)?\b.*code|\bnpm\b|\bpip\b|\bRUN\b|\bstep\b|dockerfile/i, "A build step failed."],
];

const SKIPPED_WORDS: Array<[RegExp, string]> = [
  [/^app no longer exists/i, "The app no longer exists."],
  [/^never deployed/i, "Never deployed, so there is nothing to rebuild."],
  [/^a deploy is in progress/i, "A deploy was in progress, so the rebuild left the app alone."],
  [/^no stored source/i, "There is no stored source to rebuild from."],
  [/^trivy not available/i, "The scanner was not available, so Runway did not rebuild without its safety check."],
  [/^the uploaded source could not be kept/i, "The source could not be saved as a snapshot first."],
];

/**
 * Why an app did not end up rebuilt, as one plain sentence; null when the
 * outcome explains itself. Raw error text is never shown: a failed build's
 * message is Docker or build output, which can carry paths and secrets.
 */
export function reasonFor(r: Pick<RebuildAppResult, "outcome" | "detail">): string | null {
  const d = (r.detail ?? "").trim();
  switch (r.outcome) {
    case "rebuilt":
      return null;
    case "rolled_back":
      return "The new version failed its health check, so the previous version was put back.";
    case "blocked": {
      const base = "The new version was worse than the running one, so it was not deployed.";
      const why = shortText(d, 160);
      if (!why) return base;
      const sentence = why.charAt(0).toUpperCase() + why.slice(1);
      return `${base} ${/[.!?\u2026]$/.test(sentence) ? sentence : `${sentence}.`}`;
    }
    case "failed": {
      if (/^run crashed/i.test(d)) return "The run stopped unexpectedly. Details are in the control log.";
      const hit = FAILED_WORDS.find(([re]) => re.test(d));
      return `${hit ? hit[1] : "The rebuild failed."} Details are in the control log.`;
    }
    case "skipped": {
      if (!d) return "Nothing to do.";
      const hit = SKIPPED_WORDS.find(([re]) => re.test(d));
      return hit ? hit[1] : shortText(d, 160);
    }
    default:
      return d ? shortText(d, 160) : null;
  }
}

export interface RunTile {
  key: "rebuilt" | "held" | "failed" | "skipped";
  label: string;
  n: number;
  tone: Tone;
}

/** Four tiles. Rolled back and not deployed both mean "the old version stayed". */
export function runTiles(results: RebuildAppResult[]): RunTile[] {
  const n = (...o: RebuildOutcome[]) => results.filter((r) => o.includes(r.outcome)).length;
  return [
    { key: "rebuilt", label: "Rebuilt", n: n("rebuilt"), tone: "ok" },
    { key: "held", label: "Old version kept", n: n("rolled_back", "blocked"), tone: "warn" },
    { key: "failed", label: "Failed", n: n("failed"), tone: "err" },
    { key: "skipped", label: "Skipped", n: n("skipped"), tone: "neutral" },
  ];
}

function pair(c: SeverityCounts | undefined): string {
  return c ? `${c.critical}C ${c.high}H` : "";
}

export interface ScanLine {
  /** "0C 2H -> 0C 0H", or "n/a". */
  text: string;
  /** Actively exploited (KEV) vulnerabilities, only when there is something to say. */
  kev: string | null;
  trend: "better" | "worse" | "same" | "unknown";
}

/** Critical and high findings before and after, plus KEV when it matters. */
export function scanLine(r: Pick<RebuildAppResult, "before" | "after">): ScanLine {
  const b = r.before;
  const a = r.after;
  if (!b && !a) return { text: "n/a", kev: null, trend: "unknown" };
  const text = `${b ? pair(b.counts) : "?"} → ${a ? pair(a.counts) : "n/a"}`;
  let kev: string | null = null;
  if ((b && b.kev > 0) || (a && a.kev > 0)) kev = `KEV ${b ? b.kev : "?"} → ${a ? a.kev : "n/a"}`;
  let trend: ScanLine["trend"] = "unknown";
  if (b && a) {
    const w = (x: { counts: SeverityCounts; kev: number }) => x.kev * 1000 + x.counts.critical * 100 + x.counts.high;
    trend = w(a) < w(b) ? "better" : w(a) > w(b) ? "worse" : "same";
  }
  return { text, kev, trend };
}

function minorLine(tag: string): string {
  const m = tag.match(/(\d+(?:\.\d+)?)/);
  return m ? m[1] : tag;
}

/** One sentence per thing that changed or was held back. Plain text, not HTML. */
export function changeSentences(r: RebuildAppResult): string[] {
  const out: string[] = [];

  for (const p of r.patched ?? []) {
    if (r.outcome !== "rebuilt") continue;
    out.push(`Base image ${p.from} to ${p.to}.`);
  }
  // A base image that was raised but is not in `patched` (older rows).
  if (out.length === 0) {
    for (const b of r.base_images ?? []) {
      if (r.outcome !== "rebuilt") break;
      if (b.auto_patched_from) out.push(`Patched base image (from ${b.auto_patched_from}).`);
      else if (b.auto_minor_from) out.push(`Moved the base image to a newer minor line (from ${b.auto_minor_from}).`);
    }
  }

  for (const e of r.escalation ?? []) {
    if (e.kind === "minor" && e.outcome === "applied") {
      out.push(`Moved to the newer minor line ${minorLine(e.from)} to ${minorLine(e.to)} to fix a vulnerability.`);
    } else if (e.kind === "major") {
      out.push(`A major base image update is available (${e.from} to ${e.to}). Not applied.`);
    } else if (e.outcome !== "notice") {
      out.push(`Tried the newer minor line ${minorLine(e.to)}: ${e.outcome}.`);
    }
  }

  const applied = (r.deps ?? []).filter((d) => d.outcome === "applied");
  if (applied.length) {
    out.push(`Updated ${applied.map((d) => `${d.pkg} ${d.from} to ${d.to}`).join(", ")}.`);
  }
  for (const d of r.deps ?? []) {
    if (d.outcome === "applied") continue;
    if (d.outcome === "skipped") {
      if (d.kind === "major" || /major/i.test(d.detail ?? "")) {
        out.push(`Major update${d.to ? ` ${d.pkg} ${d.from || "?"} to ${d.to}` : ` of ${d.pkg}`} available. Not applied, because major updates are off for this app.`);
      }
      continue;
    }
    if (d.outcome === "ineffective") {
      out.push(`Raised ${d.pkg} ${d.from} to ${d.to}, but the finding is still there.`);
    } else {
      out.push(`Tried ${d.pkg} ${d.from} to ${d.to}: ${d.outcome}. The old version was kept.`);
    }
  }

  if (r.outcome === "rebuilt" && out.length === 0) {
    out.push("Rebuilt from source on fresh base layers. Nothing needed updating.");
  }
  return out.map((s) => redact(s));
}

/** "Sunday 05:00 server time"-style tallies for an earlier run's one-liner. */
export function tallyText(results: RebuildAppResult[]): string {
  if (results.length === 0) return "nothing to rebuild";
  const parts = runTiles(results)
    .filter((t) => t.n > 0)
    .map((t) => `${t.n} ${t.label.toLowerCase()}`);
  return parts.join(", ");
}

/** SQLite's datetime('now') is UTC without a zone marker. */
export function parseUtc(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** "9m 41s", "42s"; null when the run has not finished. */
export function durationText(run: Pick<RebuildRun, "started_at" | "finished_at">): string | null {
  const a = parseUtc(run.started_at);
  const b = parseUtc(run.finished_at);
  if (a === null || b === null || b < a) return null;
  const s = Math.round((b - a) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

export function triggerText(t: RebuildRun["trigger"]): string {
  return t === "scheduled" ? "Weekly schedule" : "Started by an admin";
}

export interface RunRenderOptions {
  /** "17h ago". The caller owns the clock and the wording. */
  relative: (iso: string) => string;
}

function renderTiles(tiles: RunTile[]): string {
  return `<div class="sec-tiles rr-tiles">${tiles
    .map((t) => `<div class="sec-tile sec-${t.tone}" data-tile="${t.key}"><b>${t.n}</b><span>${esc(t.label)}</span></div>`)
    .join("")}</div>`;
}

function baseLines(r: RebuildAppResult): string {
  const rows = (r.base_images ?? []).map((b) => {
    const short = b.image.replace(/^docker\.io\/(library\/)?/, "");
    const dg = b.digest.replace(/^sha256:/, "").slice(0, 12);
    const note = b.auto_minor_from ? ` (auto-minor from ${b.auto_minor_from})` : b.auto_patched_from ? ` (auto-patched from ${b.auto_patched_from})` : "";
    return `<li><code>${esc(short)}</code> <span class="meta">@${esc(dg)}${esc(note)}</span></li>`;
  });
  return rows.length ? `<details class="rr-more"><summary>Base images</summary><ul>${rows.join("")}</ul></details>` : "";
}

function renderRow(r: RebuildAppResult): string {
  const o = outcomeView(r.outcome);
  const reason = reasonFor(r);
  const changes = changeSentences(r);
  const scan = scanLine(r);
  const id = encodeURIComponent(r.app_id);
  const rowTone = o.tone === "err" ? " sec-row-err" : o.tone === "warn" ? " sec-row-warn" : "";
  const what = [
    ...changes.map((c) => `<span class="rr-line">${esc(c)}</span>`),
    reason ? `<span class="rr-line rr-why">${esc(reason)}</span>` : "",
  ].join("");
  const dur = r.duration_s !== undefined ? `<span class="meta sec-sub">${esc(String(r.duration_s))}s</span>` : "";
  const kev = scan.kev ? `<span class="meta sec-sub">${esc(scan.kev)}</span>` : "";
  return `<tr class="sec-row rr-row${rowTone}" data-outcome="${esc(r.outcome)}">
    <td class="sc-app" data-label="App"><a class="app-name" href="/apps/${id}">${esc(r.app_name ?? r.app_id)}</a>${dur}</td>
    <td class="sc-state" data-label="Result"><span class="tag tag-${o.tone}">${esc(o.label)}</span></td>
    <td class="rr-what" data-label="What happened">${what || '<span class="meta">&mdash;</span>'}${baseLines(r)}</td>
    <td class="rr-scan" data-label="Critical and high"><span class="mono rr-scan-${scan.trend}">${esc(scan.text)}</span>${kev}</td>
  </tr>`;
}

/** One run: tiles and the per-app table (cards under 700 px). */
export function renderRunResult(run: RebuildRun, _o?: RunRenderOptions): string {
  if (run.results.length === 0) {
    return `<p class="meta">${run.status === "running" ? "Starting&hellip;" : "No apps needed a rebuild."}</p>`;
  }
  return `${renderTiles(runTiles(run.results))}
    <table class="apps-tbl sec-tbl rr-tbl" aria-label="Rebuild result per app">
      <thead><tr><th>App</th><th>Result</th><th>What happened</th><th>Critical and high</th></tr></thead>
      <tbody>${run.results.map(renderRow).join("")}</tbody>
    </table>`;
}

/** The heading block above a run's result. */
export function runHeading(run: RebuildRun, o: RunRenderOptions): string {
  const dur = durationText(run);
  const state = run.status === "running" ? "<strong>running</strong>" : `finished ${esc(o.relative(run.finished_at ?? run.started_at))}`;
  return `<p class="meta">${esc(triggerText(run.trigger))} &middot; started ${esc(o.relative(run.started_at))} &middot; ${state}${dur ? ` &middot; ${esc(dur)}` : ""}.</p>`;
}

/** An earlier run: a one-line summary that opens into the same result. */
export function renderEarlierRun(run: RebuildRun, o: RunRenderOptions): string {
  const dur = durationText(run);
  return `<details class="rr-earlier"><summary><span class="mono">#${run.id}</span> ${esc(triggerText(run.trigger))} &middot; ${esc(tallyText(run.results))} &middot; <span class="meta">${esc(o.relative(run.started_at))}${dur ? `, ${esc(dur)}` : ""}</span></summary>${renderRunResult(run, o)}</details>`;
}
