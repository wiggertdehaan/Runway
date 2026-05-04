/**
 * Tiny formatters shared by the dashboard renderer. Deliberately
 * dependency-free so the web package stays cheap to test.
 */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

/**
 * Format a duration in a short "3d 4h" or "5m 12s" style.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}

/**
 * Format an absolute instant as a short relative "2h ago" / "3 days ago".
 * Returns "—" for nullish / unparseable inputs.
 */
export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const ms = now - then;
  if (ms < 0) return "just now";
  return `${formatDuration(ms)} ago`;
}

export type ActivityTone = "active" | "recent" | "idle" | "none";

/**
 * Map an app's last_request_at to a human label + tone for the
 * dashboard activity row. Tone drives the color so the card scans
 * at a glance: green for fresh traffic, muted for stale or absent.
 */
export function formatActivity(
  iso: string | null | undefined,
  now = Date.now()
): { label: string; tone: ActivityTone } {
  if (!iso) return { label: "No traffic yet", tone: "none" };
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return { label: "No traffic yet", tone: "none" };
  const ms = Math.max(0, now - then);
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  if (sec < 60) return { label: "Active just now", tone: "active" };
  if (min < 60) return { label: `Active ${min}m ago`, tone: "active" };
  if (hr < 24) return { label: `Active ${hr}h ago`, tone: "recent" };
  if (day < 7) return { label: `Idle ${day}d`, tone: "idle" };
  return { label: "Idle 7d+", tone: "idle" };
}
