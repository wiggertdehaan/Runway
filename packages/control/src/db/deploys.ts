import { db } from "./index.js";

export interface Deploy {
  id: number;
  app_id: string;
  image_tag: string | null;
  status: string;
  log: string | null;
  scan_status: string | null;
  scan_summary: string | null;
  scan_report: string | null;
  created_at: string;
}

export interface RecordDeployOptions {
  log?: string;
  scanStatus?: string;
  scanSummary?: unknown;
  scanReport?: unknown;
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
    `INSERT INTO deploys (app_id, image_tag, status, log, scan_status, scan_summary, scan_report)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    appId,
    imageTag,
    status,
    resolved.log ?? null,
    resolved.scanStatus ?? null,
    resolved.scanSummary !== undefined ? JSON.stringify(resolved.scanSummary) : null,
    resolved.scanReport !== undefined ? JSON.stringify(resolved.scanReport) : null
  );
  return db
    .prepare(
      `SELECT * FROM deploys WHERE app_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(appId) as unknown as Deploy;
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
