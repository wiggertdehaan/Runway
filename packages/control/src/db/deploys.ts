import { db } from "./index.js";

export interface Deploy {
  id: number;
  app_id: string;
  image_tag: string | null;
  status: string;
  log: string | null;
  created_at: string;
}

export function recordDeploy(
  appId: string,
  imageTag: string,
  status: string,
  log?: string
): Deploy {
  db.prepare(
    `INSERT INTO deploys (app_id, image_tag, status, log) VALUES (?, ?, ?, ?)`
  ).run(appId, imageTag, status, log ?? null);
  return db
    .prepare(
      `SELECT * FROM deploys WHERE app_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(appId) as unknown as Deploy;
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

export function getLatestDeploys(appId: string, limit = 5): Deploy[] {
  return db
    .prepare(
      `SELECT * FROM deploys WHERE app_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(appId, limit) as unknown as Deploy[];
}
