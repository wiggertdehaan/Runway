import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * One-time recovery codes for users who lose their authenticator.
 * Stored hashed with scrypt, just like passwords. Format is
 * "XXXX-XXXX-XXXX" hex for easy typing.
 */

export interface BackupCodeStatus {
  total: number;
  unused: number;
}

export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const hex = randomBytes(6).toString("hex").toUpperCase();
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
  });
}

export async function storeBackupCodes(
  userId: string,
  codes: string[]
): Promise<void> {
  db.prepare(`DELETE FROM user_backup_codes WHERE user_id = ?`).run(userId);
  const insert = db.prepare(
    `INSERT INTO user_backup_codes (user_id, code_hash) VALUES (?, ?)`
  );
  for (const code of codes) {
    const hash = await hashPassword(code);
    insert.run(userId, hash);
  }
}

/**
 * Look up an unused backup code for a user and verify it. Returns
 * true on success and marks the code as used so it can't be replayed.
 */
export async function consumeBackupCode(
  userId: string,
  code: string
): Promise<boolean> {
  const normalized = code.trim().toUpperCase();
  const rows = db
    .prepare(
      `SELECT id, code_hash FROM user_backup_codes
       WHERE user_id = ? AND used_at IS NULL`
    )
    .all(userId) as unknown as Array<{ id: number; code_hash: string }>;

  for (const row of rows) {
    if (await verifyPassword(normalized, row.code_hash)) {
      db.prepare(
        `UPDATE user_backup_codes SET used_at = datetime('now') WHERE id = ?`
      ).run(row.id);
      return true;
    }
  }
  return false;
}

export function getBackupCodeStatus(userId: string): BackupCodeStatus {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) as unused
       FROM user_backup_codes
       WHERE user_id = ?`
    )
    .get(userId) as { total: number; unused: number };
  return { total: row.total, unused: row.unused ?? 0 };
}

export function deleteBackupCodes(userId: string): void {
  db.prepare(`DELETE FROM user_backup_codes WHERE user_id = ?`).run(userId);
}
