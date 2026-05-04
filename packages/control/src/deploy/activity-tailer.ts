import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { getAppByDomain } from "../db/apps.js";
import { bumpRequest, pruneOldBuckets } from "../db/activity.js";
import { getSetting, setSetting } from "../db/settings.js";

/**
 * Polls Traefik's JSON access log and records per-app request counts
 * so the dashboard can show idle/active labels and a 7-day sparkline.
 *
 * State machine:
 *   - The byte offset of the last successful read is persisted in the
 *     `activity_log_offset` setting so restarts pick up where we left
 *     off without double-counting.
 *   - File rotation is detected by comparing the current file size to
 *     the persisted offset: if the file shrank, we assume it was
 *     rotated/truncated and reset offset to 0.
 *   - Buckets older than RETENTION_HOURS are pruned every hour.
 *
 * The tailer is a no-op when the access log file does not exist (dev
 * environments without a Traefik in front, or first boot before the
 * gateway has served any requests).
 */

const POLL_INTERVAL_MS = 30 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
// Retain a bit more than the 7-day sparkline window so an in-flight
// read never deletes a hour we're still about to render.
const RETENTION_HOURS = 7 * 24 + 6;
// Cap a single read so a runaway log file doesn't lock the event loop.
const MAX_READ_BYTES = 8 * 1024 * 1024;

const LOG_PATH = process.env.GATEWAY_LOG_PATH || "/gateway-logs/access.log";

interface AccessLogEntry {
  time?: string;
  StartUTC?: string;
  RequestHost?: string;
  RequestPath?: string;
}

let buffer = "";

function parseOffset(): number {
  const raw = getSetting("activity_log_offset");
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function saveOffset(offset: number): void {
  setSetting("activity_log_offset", String(offset));
}

function shouldSkip(host: string, path: string, dashboardDomain: string): boolean {
  if (!host) return true;
  if (dashboardDomain && host === dashboardDomain) return true;
  // ACME HTTP-01 challenges are bursty around cert renewal and never
  // represent real users.
  if (path && path.startsWith("/.well-known/acme-challenge/")) return true;
  return false;
}

function processLine(line: string, dashboardDomain: string) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let entry: AccessLogEntry;
  try {
    entry = JSON.parse(trimmed) as AccessLogEntry;
  } catch {
    return;
  }
  const host = (entry.RequestHost ?? "").toLowerCase();
  const path = entry.RequestPath ?? "";
  if (shouldSkip(host, path, dashboardDomain)) return;

  const app = getAppByDomain(host);
  if (!app) return;

  const tsRaw = entry.time ?? entry.StartUTC;
  const ts = tsRaw ? new Date(tsRaw) : new Date();
  if (Number.isNaN(ts.getTime())) return;
  bumpRequest(app.id, ts);
}

async function pollOnce(dashboardDomain: string) {
  if (!existsSync(LOG_PATH)) return;
  const stat = statSync(LOG_PATH);
  let offset = parseOffset();

  // Rotation / truncation: file shrank since last read.
  if (stat.size < offset) {
    offset = 0;
    buffer = "";
  }

  if (stat.size === offset) return;

  const toRead = Math.min(stat.size - offset, MAX_READ_BYTES);
  const fh = await open(LOG_PATH, "r");
  try {
    const chunk = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(chunk, 0, toRead, offset);
    if (bytesRead === 0) return;

    buffer += chunk.subarray(0, bytesRead).toString("utf8");
    const newlineIdx = buffer.lastIndexOf("\n");
    if (newlineIdx === -1) {
      // No complete line yet; keep buffer for next poll.
      saveOffset(offset + bytesRead);
      return;
    }

    const complete = buffer.slice(0, newlineIdx);
    buffer = buffer.slice(newlineIdx + 1);

    for (const line of complete.split("\n")) {
      processLine(line, dashboardDomain);
    }
    saveOffset(offset + bytesRead);
  } finally {
    await fh.close();
  }
}

let started = false;

export function startActivityTailer(): void {
  if (started) return;
  started = true;
  const dashboardDomain = (process.env.DASHBOARD_DOMAIN ?? "").toLowerCase();

  const tick = () => {
    pollOnce(dashboardDomain).catch((err) => {
      console.error("[activity-tailer] poll failed:", err?.message ?? err);
    });
  };
  // First tick immediately so a freshly-started container picks up
  // any backlog without waiting 30s.
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
  setInterval(() => {
    try {
      pruneOldBuckets(RETENTION_HOURS);
    } catch (err: any) {
      console.error("[activity-tailer] prune failed:", err?.message ?? err);
    }
  }, PRUNE_INTERVAL_MS);
}
