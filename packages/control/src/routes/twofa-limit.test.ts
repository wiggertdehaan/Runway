/**
 * S09 through the real app: the second factor is limited per USER, in the
 * database, charged before the code is looked at. A password-holder cannot
 * reset it by signing in again, parallel guesses cannot beat it, a correct
 * code during a lock is refused like a wrong one, backup codes count, the
 * signed-in actions that ask for a code share the same counter, and an admin
 * can lift a lock. Drives the real app (CSRF included) against an in-memory
 * database; no network.
 */
import { createHmac } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createPreauthSession } from "../db/preauth.js";
import { createSession } from "../db/sessions.js";
import { commitTotp, createUser, setTotpPending } from "../db/users.js";
import { generateTotpSecret } from "../auth/totp.js";
import { storeBackupCodes } from "../auth/backup-codes.js";
import { beginAttempt, lockedUsers } from "../auth/twofa-limit.js";

const CSRF = "test-csrf-token";
const PW = "pw-dana-123456";

let secret = "";
let danaId = "";
let adminId = "";
let memberId = "";
const backup = ["AAAA-1111-BBBB", "CCCC-2222-DDDD", "EEEE-3333-FFFF"];
const sessions: Record<string, string> = {};

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.toUpperCase().replace(/=+$/, "")) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code the authenticator would show, `drift` steps from now. */
function totp(drift = 0): string {
  const counter = Math.floor(Date.now() / 1000 / 30) + drift;
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, "0");
}

/** A 6-digit code that is certainly not valid right now. */
function wrongCode(n = 0): string {
  const valid = new Set([-1, 0, 1].map((d) => totp(d)));
  let c = 100000 + n;
  while (valid.has(String(c))) c++;
  return String(c);
}

function form(path: string, body: Record<string, string>, cookies: string[]) {
  return app.request(path, {
    method: "POST",
    headers: { cookie: [...cookies, `runway_csrf=${CSRF}`].join("; "), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: CSRF, ...body }).toString(),
  });
}

/** One sign-in second-factor guess with its own fresh pre-auth session. */
async function guess(code: string, token = createPreauthSession(danaId).token) {
  const res = await form("/login/2fa", { code }, [`runway_preauth=${token}`]);
  return { res, location: res.headers.get("location") ?? "", setCookie: res.headers.get("set-cookie") ?? "" };
}

const audit = (action: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?").get(action) as { n: number }).n;
const row = () =>
  db.prepare("SELECT failures, locked_until FROM twofa_attempts WHERE user_id = ?").get(danaId) as
    | { failures: number; locked_until: number }
    | undefined;

beforeAll(async () => {
  migrate();
  const dana = await createUser("dana", PW, "member");
  danaId = dana.id;
  secret = generateTotpSecret();
  setTotpPending(danaId, secret);
  commitTotp(danaId);
  const admin = await createUser("root", "pw-root-123456", "admin");
  adminId = admin.id;
  const member = await createUser("mallory", "pw-mallory-12345", "member");
  memberId = member.id;
  sessions.dana = createSession(danaId).token;
  sessions.root = createSession(adminId).token;
  sessions.mallory = createSession(memberId).token;
});

beforeEach(async () => {
  db.exec("DELETE FROM twofa_attempts");
  db.exec("DELETE FROM used_totp_counters");
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM preauth_sessions");
  try {
    db.exec("DELETE FROM rate_limits");
  } catch {
    /* table is created on first use */
  }
  await storeBackupCodes(danaId, backup);
});

describe("sign-in second factor", () => {
  it("accepts a correct code and clears the counter", async () => {
    await guess(wrongCode(1));
    await guess(wrongCode(2));
    expect(row()?.failures).toBe(2);
    const ok = await guess(totp());
    expect(ok.location).toBe("/");
    expect(ok.setCookie).toContain("runway_session=");
    expect(row()).toBeUndefined();
  });

  it("locks after the 5th wrong code and destroys that pre-auth session", async () => {
    const token = createPreauthSession(danaId).token;
    for (let i = 1; i <= 4; i++) {
      expect((await guess(wrongCode(i), token)).location).toBe("/login/2fa?error=1");
    }
    const fifth = await guess(wrongCode(5), token);
    expect(fifth.location).toBe("/login?locked=1");
    expect(db.prepare("SELECT COUNT(*) AS n FROM preauth_sessions WHERE token = ?").get(token)).toEqual({ n: 0 });
    expect(row()?.failures).toBe(5);
    expect(row()!.locked_until).toBeGreaterThan(Date.now());
    expect(audit("2fa_failed")).toBe(5);
    expect(audit("2fa_locked")).toBe(1);
  });

  it("refuses a CORRECT code during the lock exactly like a wrong one, and gives no session", async () => {
    for (let i = 1; i <= 5; i++) await guess(wrongCode(i));
    const right = await guess(totp());
    const wrong = await guess(wrongCode(9));
    expect(right.location).toBe("/login/2fa?locked=1");
    expect(wrong.location).toBe(right.location);
    expect(right.setCookie).not.toContain("runway_session=");
    // The refused attempt was not even checked, so it burned neither the code nor a count.
    expect(row()?.failures).toBe(5);
  });

  it("is not reset by signing in with the password again", async () => {
    // Four misses, then the password step (which clears the per-IP login counter).
    for (let i = 1; i <= 4; i++) await guess(wrongCode(i));
    const login = await form("/login", { username: "dana", password: PW }, []);
    expect(login.headers.get("location")).toBe("/login/2fa");
    const token = /runway_preauth=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
    expect(token).toBeTruthy();
    expect(row()?.failures).toBe(4);
    // The fifth miss, on the NEW pre-auth session, still locks.
    const fifth = await guess(wrongCode(5), token);
    // On a fresh pre-auth session the 5th miss is just "that code did not work"...
    expect(fifth.location).toBe("/login/2fa?error=1");
    // ...but the USER counter carried over from the earlier session: it is 5 now and locked.
    expect(row()?.failures).toBe(5);
    expect(row()!.locked_until).toBeGreaterThan(Date.now());
    expect((await guess(totp())).location).toBe("/login/2fa?locked=1");
  });

  it("counts backup codes and malformed input in the same counter, with one error for all", async () => {
    const results = [
      await guess(wrongCode(1)),
      await guess("ZZZZ-9999-YYYY"), // wrong backup code
      await guess(""), // empty
      await guess("abcdef"), // not digits
    ];
    for (const r of results) expect(r.location).toBe("/login/2fa?error=1");
    expect(row()?.failures).toBe(4);
    await guess("NOPE-0000-NOPE");
    expect(row()?.failures).toBe(5);
    expect((await guess(backup[0]!)).location).toBe("/login/2fa?locked=1");
  });

  it("accepts a backup code when not locked, once", async () => {
    const ok = await guess(backup[1]!);
    expect(ok.location).toBe("/");
    const again = await guess(backup[1]!);
    expect(again.location).toBe("/login/2fa?error=1");
  });

  it("works again when the lock has run out, and then resets", async () => {
    for (let i = 1; i <= 5; i++) await guess(wrongCode(i));
    db.prepare("UPDATE twofa_attempts SET locked_until = 0 WHERE user_id = ?").run(danaId);
    const ok = await guess(totp());
    expect(ok.location).toBe("/");
    expect(row()).toBeUndefined();
  });

  it("charges parallel guesses all, before the check: no more than 5 get through", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 14 }, (_, i) =>
        // a mix of authenticator-style and (slow, async) backup-style guesses
        guess(i % 3 === 0 ? `AAAA-0000-${String(i).padStart(4, "0")}` : wrongCode(i))
      )
    );
    // Exactly 5 were looked at (and failed); the other 9 were refused unseen.
    expect(audit("2fa_failed")).toBe(5);
    expect(row()?.failures).toBe(5);
    const refused = attempts.filter((a) => a.location === "/login/2fa?locked=1");
    expect(refused).toHaveLength(9);
    expect(attempts.some((a) => a.setCookie.includes("runway_session="))).toBe(false);
  });

  it("alerts the administrator at the 10th failure in a row", async () => {
    for (let i = 1; i <= 10; i++) {
      db.prepare("UPDATE twofa_attempts SET locked_until = 0 WHERE user_id = ?").run(danaId);
      await guess(wrongCode(i));
    }
    expect(row()?.failures).toBe(10);
    expect(audit("2fa_bruteforce_suspected")).toBe(1);
    expect(audit("2fa_locked")).toBeGreaterThanOrEqual(6);
  });

  it("shows how long to wait on the 2FA page while locked", async () => {
    for (let i = 1; i <= 5; i++) await guess(wrongCode(i));
    const token = createPreauthSession(danaId).token;
    const page = await app.request("/login/2fa?locked=1", { headers: { cookie: `runway_preauth=${token}` } });
    const html = await page.text();
    expect(html).toMatch(/Too many failed attempts\. Try again in \d+ minutes?\./);
  });

  it("does not change what an unknown user or a wrong password sees", async () => {
    const a = await form("/login", { username: "nobody", password: "whatever-123" }, []);
    const b = await form("/login", { username: "dana", password: "wrong-password" }, []);
    expect(a.headers.get("location")).toBe("/login?error=1");
    expect(b.headers.get("location")).toBe("/login?error=1");
  });
});

describe("signed-in actions share the same counter", () => {
  const cookie = () => [`runway_session=${sessions.dana}`];

  it("turning 2FA off cannot be used to guess codes without limit", async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await form("/account/2fa/disable", { code: wrongCode(i) }, cookie());
      expect(r.headers.get("location")).toBe("/account?error=1");
    }
    const right = await form("/account/2fa/disable", { code: totp() }, cookie());
    expect(right.headers.get("location")).toBe("/account?error=locked");
    // ... and 2FA is still on.
    const u = db.prepare("SELECT totp_enabled FROM users WHERE id = ?").get(danaId) as { totp_enabled: number };
    expect(u.totp_enabled).toBe(1);
    // The sign-in is locked by the same counter.
    expect((await guess(totp())).location).toBe("/login/2fa?locked=1");
  });

  it("new backup codes are limited too", async () => {
    for (let i = 1; i <= 5; i++) await form("/account/2fa/regenerate", { code: wrongCode(i) }, cookie());
    const right = await form("/account/2fa/regenerate", { code: totp() }, cookie());
    expect(right.headers.get("location")).toBe("/account?error=locked");
  });

  it("an admin's own counter limits the reset of someone else's 2FA", async () => {
    const adminSecret = generateTotpSecret();
    setTotpPending(adminId, adminSecret);
    commitTotp(adminId);
    for (let i = 1; i <= 5; i++) {
      await form(`/users/${danaId}/2fa/reset`, { code: wrongCode(i) }, [`runway_session=${sessions.root}`]);
    }
    const r = await form(`/users/${danaId}/2fa/reset`, { code: "000000" }, [`runway_session=${sessions.root}`]);
    expect(r.headers.get("location")).toBe("/users?error=2fa_locked");
    // Dana's 2FA is untouched.
    const u = db.prepare("SELECT totp_enabled FROM users WHERE id = ?").get(danaId) as { totp_enabled: number };
    expect(u.totp_enabled).toBe(1);
    db.prepare("DELETE FROM twofa_attempts WHERE user_id = ?").run(adminId);
  });

  it("shows the lock message on the account page", async () => {
    for (let i = 0; i < 5; i++) beginAttempt(danaId);
    const html = await (
      await app.request("/account?error=locked", { headers: { cookie: `runway_session=${sessions.dana}` } })
    ).text();
    expect(html).toMatch(/Too many failed attempts\. Try again in \d+ minutes?\./);
  });
});

describe("admin unlock", () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) beginAttempt(danaId);
  });

  it("lifts the lock, is audited, and the person can sign in again", async () => {
    expect(lockedUsers().has(danaId)).toBe(true);
    const r = await form(`/users/${danaId}/2fa/unlock`, {}, [`runway_session=${sessions.root}`]);
    expect(r.status).toBe(302);
    expect(lockedUsers().has(danaId)).toBe(false);
    expect(audit("2fa_unlocked")).toBe(1);
    expect((await guess(totp())).location).toBe("/");
  });

  it("is admin-only", async () => {
    const r = await form(`/users/${danaId}/2fa/unlock`, {}, [`runway_session=${sessions.mallory}`]);
    expect(r.headers.get("location") ?? "").toContain("forbidden");
    expect(lockedUsers().has(danaId)).toBe(true);
  });

  it("needs a CSRF token and a session", async () => {
    const noCsrf = await app.request(`/users/${danaId}/2fa/unlock`, {
      method: "POST",
      headers: { cookie: `runway_session=${sessions.root}` },
    });
    expect(noCsrf.status).toBe(403);
    const anon = await form(`/users/${danaId}/2fa/unlock`, {}, []);
    expect(anon.headers.get("location") ?? "").toMatch(/login/);
    expect(lockedUsers().has(danaId)).toBe(true);
  });

  it("shows the lock and an Unlock button to the admin on the Users page", async () => {
    const html = await (await app.request("/users", { headers: { cookie: `runway_session=${sessions.root}` } })).text();
    expect(html).toContain("2FA locked");
    expect(html).toContain(`/users/${danaId}/2fa/unlock`);
    await form(`/users/${danaId}/2fa/unlock`, {}, [`runway_session=${sessions.root}`]);
    const after = await (await app.request("/users", { headers: { cookie: `runway_session=${sessions.root}` } })).text();
    expect(after).not.toContain("2FA locked");
  });

  it("the 2FA reset flow still works for an admin with their own code", async () => {
    const adminSecret = generateTotpSecret();
    setTotpPending(adminId, adminSecret);
    commitTotp(adminId);
    const saved = secret;
    secret = adminSecret;
    const code = totp();
    secret = saved;
    const r = await form(`/users/${danaId}/2fa/reset`, { code }, [`runway_session=${sessions.root}`]);
    expect(r.headers.get("location")).toBe("/users");
    const u = db.prepare("SELECT totp_enabled FROM users WHERE id = ?").get(danaId) as { totp_enabled: number };
    expect(u.totp_enabled).toBe(0);
    // Resetting someone's 2FA also lifts their lock.
    expect(lockedUsers().has(danaId)).toBe(false);
    setTotpPending(danaId, secret);
    commitTotp(danaId);
  });
});
