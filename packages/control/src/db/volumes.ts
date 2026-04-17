import { db } from "./index.js";

export interface Volume {
  mount_path: string;
  created_at: string;
}

export function getVolumes(appId: string): Volume[] {
  return db
    .prepare(
      `SELECT mount_path, created_at FROM volumes WHERE app_id = ? ORDER BY created_at`
    )
    .all(appId) as unknown as Volume[];
}

export function setVolumes(appId: string, mountPaths: string[]): void {
  db.prepare(`DELETE FROM volumes WHERE app_id = ?`).run(appId);
  const insert = db.prepare(
    `INSERT INTO volumes (app_id, mount_path) VALUES (?, ?)`
  );
  for (const path of mountPaths) {
    insert.run(appId, path);
  }
}

export function deleteVolume(appId: string, mountPath: string): boolean {
  const result = db
    .prepare(`DELETE FROM volumes WHERE app_id = ? AND mount_path = ?`)
    .run(appId, mountPath);
  return result.changes > 0;
}
