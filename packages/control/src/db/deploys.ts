import { db } from "./index.js";
import { emitEvent } from "./events.js";
import { deployEventCode } from "../util/events.js";

export interface Deploy {
  id: number;
  app_id: string;
  image_tag: string | null;
  status: string;
  log: string | null;
  scan_status: string | null;
  scan_summary: string | null;
  scan_report: string | null;
  base_images: string | null;
  created_at: string;
}

export interface RecordDeployOptions {
  log?: string;
  scanStatus?: string;
  scanSummary?: unknown;
  scanReport?: unknown;
  /** Base images (tag + digest) the build used; see deploy/base-images.ts. */
  baseImages?: unknown;
  /** This record is a rollback to an earlier image (reported as such in the event log). */
  rollback?: boolean;
  /**
   * Do not write an event for it. A rebuild decides its own outcome and reports
   * it as one rebuild_* event; the deploys inside it must not say it twice.
   */
  silentEvent?: boolean;
}

export function recordDeploy(
  appId: string,
  imageTag: string,
  status: string,
  opts: string | RecordDeployOptions = {}
): Deploy {
  const resolved: RecordDeployOptions =
    typeof opts === "string" ? { log: opts } : opts;
  db.prepare(
    `INSERT INTO deploys (app_id, image_tag, status, log, scan_status, scan_summary, scan_report, base_images)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    appId,
    imageTag,
    status,
    resolved.log ?? null,
    resolved.scanStatus ?? null,
    resolved.scanSummary !== undefined ? JSON.stringify(resolved.scanSummary) : null,
    resolved.scanReport !== undefined ? JSON.stringify(resolved.scanReport) : null,
    resolved.baseImages !== undefined ? JSON.stringify(resolved.baseImages) : null
  );
  const row = db
    .prepare(
      `SELECT * FROM deploys WHERE app_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(appId) as unknown as Deploy;
  if (!resolved.silentEvent) {
    emitEvent({
      appId,
      code: deployEventCode(status, resolved.rollback === true),
      facts: { deploy_id: row.id },
    });
  }
  return row;
}

export function getDeploy(appId: string, deployId: number): Deploy | undefined {
  return db
    .prepare(`SELECT * FROM deploys WHERE app_id = ? AND id = ?`)
    .get(appId, deployId) as unknown as Deploy | undefined;
}

export function getLatestDeployWithScan(appId: string): Deploy | undefined {
  return db
    .prepare(
      `SELECT * FROM deploys WHERE app_id = ? AND scan_status IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(appId) as unknown as Deploy | undefined;
}

export function getPreviousSuccessfulDeploy(
  appId: string,
  excludeImageTag?: string
): Deploy | undefined {
  if (excludeImageTag) {
    return db
      .prepare(
        `SELECT * FROM deploys WHERE app_id = ? AND status = 'success' AND image_tag != ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(appId, excludeImageTag) as unknown as Deploy | undefined;
  }
  return db
    .prepare(
      `SELECT * FROM deploys WHERE app_id = ? AND status = 'success'
       ORDER BY id DESC LIMIT 1`
    )
    .get(appId) as unknown as Deploy | undefined;
}

/**
 * Unique successful image tags for an app, most recent first. Used
 * for retention — anything after the keep-window is a candidate for
 * image pruning.
 */
export function getSuccessfulImageTags(appId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT image_tag FROM deploys
       WHERE app_id = ? AND status = 'success' AND image_tag IS NOT NULL
       ORDER BY id DESC`
    )
    .all(appId) as Array<{ image_tag: string }>;
  return rows.map((r) => r.image_tag);
}

export function getLatestDeploys(appId: string, limit = 5): Deploy[] {
  return db
    .prepare(
      `SELECT * FROM deploys WHERE app_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(appId, limit) as unknown as Deploy[];
}

/** Parse a deploy's stored base_images JSON (empty list when absent/corrupt). */
export function parseBaseImages(
  d: Pick<Deploy, "base_images">
): Array<{ image: string; digest: string; auto_patched_from?: string; auto_minor_from?: string }> {
  if (!d.base_images) return [];
  try {
    const v = JSON.parse(d.base_images);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
