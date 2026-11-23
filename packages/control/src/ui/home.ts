/**
 * Pure helpers for the home page: the filter chips above the apps table
 * and the "does this app need attention" rule. No database, no Docker.
 *
 * The client script (ui/client.ts) filters rows by two attributes the
 * server puts on every row: `data-status` (one of the five states, or
 * "new" for an app that was never configured) and `data-attn`
 * ("1" or "0"). The chip keys below are exactly those values.
 */
import { APP_STATES, stateLabel, type AppState, type AppStatus, type StateCounts } from "./status.js";

export type ChipKey = "all" | "attention" | AppState;

export interface Chip {
  key: ChipKey;
  label: string;
  count: number;
}

/**
 * An app needs attention when it is failed or offline, or when its
 * security chip is not green (exploited-vulnerability countdown, a
 * blocked deploy, critical findings). A Live app with a neutral or ok
 * chip does not.
 */
export function needsAttention(s: Pick<AppStatus, "state" | "security">): boolean {
  if (s.state === "failed" || s.state === "offline") return true;
  const tone = s.security?.tone;
  return tone === "warn" || tone === "err";
}

/**
 * Chips for the filter row: All, Needs attention (only when there is
 * something), then each state that has at least one app, in a fixed
 * order so the row does not jump around between refreshes. Nothing at
 * all when there are no apps.
 */
export function homeChips(counts: StateCounts, attention: number, unconfigured = 0): Chip[] {
  const total = APP_STATES.reduce((n, s) => n + counts[s], 0) + unconfigured;
  if (total === 0) return [];
  const chips: Chip[] = [{ key: "all", label: "All", count: total }];
  if (attention > 0) chips.push({ key: "attention", label: "Needs attention", count: attention });
  for (const s of APP_STATES) {
    if (counts[s] > 0) chips.push({ key: s, label: stateLabel(s), count: counts[s] });
  }
  return chips;
}

function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The chip row. All buttons start unpressed; the client script marks the
 * active one (and keeps it marked after every poll swap).
 */
export function renderChips(chips: Chip[]): string {
  if (chips.length === 0) return "";
  const buttons = chips
    .map(
      (c) =>
        `<button type="button" class="chip" data-chip="${esc(c.key)}" aria-pressed="${c.key === "all" ? "true" : "false"}">${esc(c.label)} <span class="chip-n">${c.count}</span></button>`
    )
    .join("");
  return `<div class="chips" role="group" aria-label="Filter apps by status">${buttons}</div>`;
}
