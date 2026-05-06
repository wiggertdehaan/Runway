import { customAlphabet, nanoid } from "nanoid";
import { db } from "./index.js";

export interface DevToken {
  id: string;
  user_id: string;
  token: string;
  name: string;
  last_used_at: string | null;
  created_at: string;
}

const generateTokenId = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyz",
  12,
);

export interface CreatedDevToken {
  id: string;
  token: string;
  name: string;
}

export function createDevToken(userId: string, name: string): CreatedDevToken {
  const id = generateTokenId();
  const token = `rwd_${nanoid(32)}`;
  db.prepare(
    `INSERT INTO dev_tokens (id, user_id, token, name) VALUES (?, ?, ?, ?)`,
  ).run(id, userId, token, name.trim());
  return { id, token, name: name.trim() };
}

export function listDevTokens(userId: string): Omit<DevToken, "token">[] {
  return db
    .prepare(
      `SELECT id, user_id, name, last_used_at, created_at
       FROM dev_tokens
       WHERE user_id = ?
       ORDER BY created_at DESC`,
    )
    .all(userId) as unknown as Omit<DevToken, "token">[];
}

export function getDevTokenByToken(token: string): DevToken | undefined {
  return db
    .prepare(`SELECT * FROM dev_tokens WHERE token = ?`)
    .get(token) as unknown as DevToken | undefined;
}

export function touchDevToken(id: string): void {
  db.prepare(
    `UPDATE dev_tokens SET last_used_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

export function deleteDevToken(id: string, userId: string): boolean {
  const result = db
    .prepare(`DELETE FROM dev_tokens WHERE id = ? AND user_id = ?`)
    .run(id, userId);
  return result.changes > 0;
}
