/**
 * One status model for an app, shared by every dashboard view.
 *
 * The database and Docker know many words for "what is this app doing"
 * (created, building, scanning, starting, running, failed, stopped,
 * quarantined; plus the container's own running/exited/restarting/...).
 * An owner needs five: Live, Building, Failed, Stopped, Offline. How
 * safe the app is (actively exploited CVE countdown, last scan) is a
 * separate, single "security" chip, so a Live app can still say
 * "Offline in 3d".
 *
 * Pure functions over plain data: no database, no Docker, no network.
 * The caller gathers the inputs.
 */
import { fmtCountdown, offlineAt, URGENT_MS, type AtRiskApp } from "../routes/security-view.js";

export type AppState = "live" | "building" | "failed" | "stopped" | "offline";

export const APP_STATES: readonly AppState[] = ["live", "building", "failed", "stopped", "offline"];

export type ChipTone = "ok" | "warn" | "err" | "neutral";

export interface SecurityChip {
  tone: ChipTone;
  label: string;
  /** Second line / tooltip: the CVE ids, "Last deploy blocked", ... */
  detail: string | null;
  /** Dashboard anchor on the app page where the details live. */
  target: "quarantine" | "scan";
}

export interface AppStatus {
  state: AppState;
  /** The one word shown to the user. Usually the state, sometimes more precise ("Not deployed"). */
  label: string;
  /** Why, in a sentence, for a tooltip. null when the state explains itself. */
  reason: string | null;
  /** The single most important security fact, or null when there is nothing to say. */
  security: SecurityChip | null;
}

export interface AppStatusInput {
  /** apps.status from the database. */
  dbStatus: string;
  /**
   * Docker's view of the container. undefined/null = unknown (Docker
   * unreachable or no container): the database status is then trusted.
   */
  containerState?: string | null;
  /** The app's KEV term, when it has one. */
  kev?: AtRiskApp;
  /** Raw JSON of the latest deploy's scan_summary, when there is one. */
  scanSummary?: string | null;
  /** Epoch ms. */
  now: number;
}

const WORD: Record<AppState, string> = {
  live: "Live",
  building: "Building",
  failed: "Failed",
  stopped: "Stopped",
  offline: "Offline",
};

export function stateLabel(state: AppState): string {
  return WORD[state];
}

interface Resolved {
  state: AppState;
  label: string;
  reason: string | null;
}

function resolve(dbStatus: string, containerState: string | null | undefined): Resolved {
  const done = (state: AppState, reason: string | null = null, label = WORD[state]): Resolved => ({
    state,
    label,
    reason,
  });

  switch (dbStatus) {
    // A pipeline step is in flight: that wins over whatever the old
    // container is still doing.
    case "building":
      return done("building", "Building the image");
    case "scanning":
      return done("building", "Scanning the image for vulnerabilities");
    case "starting":
      return done("building", "Starting the new version");
    case "quarantined":
      return done("offline", "Taken offline: an actively exploited vulnerability was not fixed in time");
    case "failed":
      return done("failed", "The last deploy or rebuild failed and nothing is serving");
    case "created":
      return done("stopped", "No version has been deployed yet", "Not deployed");
    case "stopped":
      return done("stopped");
    case "running":
      break;
    default:
      return done("stopped", `Unknown state "${dbStatus}"`, dbStatus || WORD.stopped);
  }

  switch (containerState) {
    case undefined:
    case null:
    case "running":
      return done("live");
    case "restarting":
      return done("failed", "The container keeps crashing and restarting", "Crash loop");
    case "exited":
    case "dead":
    case "removing":
      return done("failed", "The container has exited", "Crashed");
    case "paused":
    case "created":
      return done("stopped", `The container is ${containerState}`);
    default:
      return done("failed", `Unexpected container state "${containerState}"`);
  }
}

interface ScanSummary {
  status?: string;
  counts?: Record<string, number>;
}

function parseScan(raw: string | null | undefined): ScanSummary | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as ScanSummary) : null;
  } catch {
    return null;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function kevChip(kev: AtRiskApp, now: number): SecurityChip {
  const cves = kev.cves.length > 0 ? kev.cves.join(", ") : null;
  if (kev.state === "quarantined") {
    return { tone: "err", label: "Exploited vulnerability", detail: cves, target: "quarantine" };
  }
  const at = offlineAt(kev);
  if (at === null) {
    return { tone: "warn", label: "Goes offline unless fixed", detail: cves, target: "quarantine" };
  }
  const left = at - now;
  return {
    tone: left < URGENT_MS ? "err" : "warn",
    label: `Offline ${fmtCountdown(left)}`,
    detail: cves,
    target: "quarantine",
  };
}

function scanChip(scan: ScanSummary): SecurityChip | null {
  const c = scan.counts ?? {};
  const crit = c.critical ?? 0;
  const high = c.high ?? 0;
  const other = (c.medium ?? 0) + (c.low ?? 0) + (c.unknown ?? 0);
  const otherNote = other > 0 ? `+${other} other` : null;
  switch (scan.status) {
    case "passed":
      return { tone: "ok", label: "Secure", detail: null, target: "scan" };
    case "blocked":
      return {
        tone: "err",
        label: `${crit} critical, ${high} high`,
        detail: "Last deploy blocked",
        target: "scan",
      };
    case "warned": {
      const serious = crit + high;
      if (serious > 0) {
        return { tone: "warn", label: plural(serious, "issue"), detail: otherNote, target: "scan" };
      }
      return { tone: "neutral", label: `${other} low`, detail: null, target: "scan" };
    }
    default:
      return { tone: "neutral", label: "Scan skipped", detail: null, target: "scan" };
  }
}

/**
 * The most important security fact: an exploited-vulnerability term
 * outranks everything, then the last scan.
 */
export function securityChip(input: Pick<AppStatusInput, "kev" | "scanSummary" | "now">): SecurityChip | null {
  if (input.kev) return kevChip(input.kev, input.now);
  const scan = parseScan(input.scanSummary);
  return scan ? scanChip(scan) : null;
}

export function appStatus(input: AppStatusInput): AppStatus {
  const r = resolve(input.dbStatus, input.containerState);
  return { ...r, security: securityChip(input) };
}

export type StateCounts = Record<AppState, number>;

export function countStates(statuses: Iterable<Pick<AppStatus, "state">>): StateCounts {
  const out: StateCounts = { live: 0, building: 0, failed: 0, stopped: 0, offline: 0 };
  for (const s of statuses) out[s.state]++;
  return out;
}

/**
 * "6 apps", "4 live", "1 failed", ...: the summary line above the app
 * list. States with no apps are left out; the order is fixed so the
 * line does not jump around between refreshes.
 */
export function summaryParts(counts: StateCounts): Array<{ state: AppState | null; text: string }> {
  const total = APP_STATES.reduce((n, s) => n + counts[s], 0);
  if (total === 0) return [];
  const parts: Array<{ state: AppState | null; text: string }> = [
    { state: null, text: plural(total, "app") },
  ];
  for (const s of APP_STATES) {
    if (counts[s] > 0) parts.push({ state: s, text: `${counts[s]} ${s}` });
  }
  return parts;
}
