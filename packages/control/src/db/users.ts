import { nanoid } from "nanoid";
import { db } from "./index.js";
import { hashPassword, verifyPassword } from "../auth/password.js";

export interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}

export async function createUser(
  username: string,
  password: string
): Promise<User> {
  const id = nanoid(12);
  const password_hash = await hashPassword(password);

  db.prepare(
    `INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`
  ).run(id, username, password_hash);

  return getUser(id)!;
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
