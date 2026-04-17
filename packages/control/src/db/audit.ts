import { db } from "./index.js";

export interface AuditEntry {
  id: number;
  user_id: string;
  username: string;
  action: string;
  target_user_id: string | null;
  target_username: string | null;
  detail: string | null;
  created_at: string;
}

export function logAudit(
  userId: string,
  username: string,
  action: string,
  opts?: {
    targetUserId?: string;
    targetUsername?: string;
    detail?: string;
  }
): void {
  db.prepare(
    `INSERT INTO audit_log (user_id, username, action, target_user_id, target_username, detail)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    username,
    action,
    opts?.targetUserId ?? null,
    opts?.targetUsername ?? null,
    opts?.detail ?? null
  );
}

export function getRecentAuditEntries(limit = 50): AuditEntry[] {
  return db
    .prepare(
      `SELECT id, user_id, username, action, target_user_id, target_username, detail, created_at
       FROM audit_log ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as unknown as AuditEntry[];
}
