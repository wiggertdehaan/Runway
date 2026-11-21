import { db } from "./index.js";

export type RebuildOutcome =
  | "rebuilt"
  | "rolled_back"
  | "blocked"
  | "failed"
  | "skipped";

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

export interface RebuildAppResult {
  app_id: string;
  app_name: string | null;
  outcome: RebuildOutcome;
  /** null when no earlier scan exists to compare against. */
  before: { counts: SeverityCounts; kev: number } | null;
  after: { counts: SeverityCounts; kev: number } | null;
  /** Why it was picked (auto) or why it was skipped/failed. */
  detail?: string;
  /** Base images (tag + digest) the new build used. */
  base_images?: Array<{ image: string; digest: string; auto_patched_from?: string; auto_minor_from?: string }>;
  /** Exact patch pins that were automatically raised for this build. */
  patched?: Array<{ from: string; to: string; kind?: "patch" | "minor" | "major" }>;
  /** Minor-line escalation attempts and major-available probes. */
  escalation?: Array<{
    kind: "minor" | "major";
    from: string;
    to: string;
    outcome: "applied" | "blocked" | "unhealthy" | "failed" | "notice";
    detail: string;
  }>;
  duration_s?: number;
}

export interface RebuildRun {
  id: number;
  trigger: "manual" | "scheduled";
  status: "running" | "done";
  started_at: string;
  finished_at: string | null;
  results: RebuildAppResult[];
}

interface Row {
  id: number;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  results: string;
}

function toRun(r: Row): RebuildRun {
  let results: RebuildAppResult[] = [];
  try {
    results = JSON.parse(r.results) as RebuildAppResult[];
  } catch {
    /* corrupt row: show it as empty rather than crash the page */
  }
  return {
    id: r.id,
    trigger: r.trigger as RebuildRun["trigger"],
    status: r.status as RebuildRun["status"],
    started_at: r.started_at,
    finished_at: r.finished_at,
    results,
  };
}

export function createRebuildRun(trigger: RebuildRun["trigger"]): number {
  const res = db
    .prepare(`INSERT INTO rebuild_runs (trigger) VALUES (?)`)
    .run(trigger);
  return Number(res.lastInsertRowid);
}

export function saveRebuildResults(id: number, results: RebuildAppResult[]): void {
  db.prepare(`UPDATE rebuild_runs SET results = ? WHERE id = ?`).run(
    JSON.stringify(results),
    id
  );
}

export function finishRebuildRun(id: number): void {
  db.prepare(
    `UPDATE rebuild_runs SET status = 'done', finished_at = datetime('now') WHERE id = ?`
  ).run(id);
}

export function getRebuildRun(id: number): RebuildRun | undefined {
  const row = db.prepare(`SELECT * FROM rebuild_runs WHERE id = ?`).get(id) as
    | unknown as Row
    | undefined;
  return row ? toRun(row) : undefined;
}

export function listRebuildRuns(limit = 10): RebuildRun[] {
  return (
    db
      .prepare(`SELECT * FROM rebuild_runs ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as Row[]
  ).map(toRun);
}

/**
 * A server restart mid-run leaves a row stuck on 'running'. Called at
 * startup: close those rows so the UI doesn't show a run forever.
 */
export function closeOrphanedRebuildRuns(): number {
  const res = db
    .prepare(
      `UPDATE rebuild_runs SET status = 'done', finished_at = datetime('now')
       WHERE status = 'running'`
    )
    .run();
  return Number(res.changes);
}
