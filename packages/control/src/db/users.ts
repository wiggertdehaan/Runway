import { nanoid } from "nanoid";
import { db } from "./index.js";
import { hashPassword, verifyPassword } from "../auth/password.js";

export type Role = "admin" | "member";

export const ROLES: Role[] = ["admin", "member"];

export interface User {
  id: string;
  username: string;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number; // 0 | 1 from SQLite
  role: Role;
  created_at: string;
}

export function isTotpEnabled(user: User): boolean {
  return user.totp_enabled === 1 && !!user.totp_secret;
}

export function isAdmin(user: User): boolean {
  return user.role === "admin";
}

export function setTotpPending(userId: string, secret: string): void {
  db.prepare(
    `UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?`
  ).run(secret, userId);
}

export function commitTotp(userId: string): void {
  db.prepare(`UPDATE users SET totp_enabled = 1 WHERE id = ?`).run(userId);
}

export function clearTotp(userId: string): void {
  db.prepare(
    `UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?`
  ).run(userId);
}

export async function createUser(
  username: string,
  password: string,
  role: Role = "member"
): Promise<User> {
  const id = nanoid(12);
  const password_hash = await hashPassword(password);

  db.prepare(
    `INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)`
  ).run(id, username, password_hash, role);

  return getUser(id)!;
}

export function setUserRole(id: string, role: Role): void {
  db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, id);
}

export function countAdmins(): number {
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'admin'`)
    .get() as { count: number };
  return row.count;
}

export function getUser(id: string): User | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
    | unknown
    | undefined as User | undefined;
}

export function getUserByUsername(username: string): User | undefined {
  return db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as
    | unknown
    | undefined as User | undefined;
}

export function listUsers(): User[] {
  return db
    .prepare(`SELECT * FROM users ORDER BY created_at ASC`)
    .all() as unknown as User[];
}

export function countUsers(): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM users`).get() as {
    count: number;
  };
  return row.count;
}

export function deleteUser(id: string): boolean {
  const result = db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  return result.changes > 0;
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const password_hash = await hashPassword(password);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(
    password_hash,
    userId
  );
}

export async function authenticate(
  username: string,
  password: string
): Promise<User | null> {
  const user = getUserByUsername(username);
  if (!user) {
    // Still hash to avoid timing attacks revealing user existence
    await verifyPassword(password, "scrypt$00$00");
    return null;
  }
  const ok = await verifyPassword(password, user.password_hash);
  return ok ? user : null;
}
