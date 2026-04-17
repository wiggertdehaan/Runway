import { db } from "./index.js";

export function getAppAllowedEmails(appId: string): string[] {
  const rows = db
    .prepare(
      `SELECT email FROM app_allowed_emails WHERE app_id = ? ORDER BY email`
    )
    .all(appId) as Array<{ email: string }>;
  return rows.map((r) => r.email);
}

export function setAppAllowedEmails(
  appId: string,
  emails: string[]
): void {
  db.prepare(`DELETE FROM app_allowed_emails WHERE app_id = ?`).run(appId);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO app_allowed_emails (app_id, email) VALUES (?, ?)`
  );
  for (const email of emails) {
    insert.run(appId, email.toLowerCase().trim());
  }
}

export function addAppAllowedEmail(appId: string, email: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO app_allowed_emails (app_id, email) VALUES (?, ?)`
  ).run(appId, email.toLowerCase().trim());
}

export function removeAppAllowedEmail(
  appId: string,
  email: string
): boolean {
  const result = db
    .prepare(
      `DELETE FROM app_allowed_emails WHERE app_id = ? AND email = ?`
    )
    .run(appId, email.toLowerCase().trim());
  return result.changes > 0;
}

export function isEmailAllowedForApp(
  appId: string,
  email: string
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM app_allowed_emails WHERE app_id = ? AND email = ? COLLATE NOCASE`
    )
    .get(appId, email);
  return !!row;
}
