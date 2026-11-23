/**
 * What a person sees when the upgrade gave their developer token an expiry:
 * the token still works until the date, the Account page says so and shows
 * the date, and the notice goes away when the token is revoked. Drives the
 * real app against an in-memory database.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createUser } from "../db/users.js";
import { createSession } from "../db/sessions.js";
import { createDevToken, getDevTokenByToken, listDevTokens } from "../db/dev-tokens.js";
import { expireLegacyDevTokens } from "../db/token-migration.js";
import { hashToken, newToken, placeholderFor, tokenHint } from "../util/token-hash.js";
import { legacyExpiryNotice } from "../ui/token-lists.js";

const CSRF = "test-csrf-token";
const DAY = 86_400_000;
let sessions: Record<string, string> = {};
let ids: Record<string, string> = {};
let legacyToken = "";
let legacyId = "";

beforeAll(async () => {
  migrate();
  const admin = await createUser("root", "pw-root-123456", "admin");
  const alice = await createUser("alice", "pw-alice-123456", "member");
  const bob = await createUser("bob", "pw-bob-123456", "member");
  sessions = {
    root: createSession(admin.id).token,
    alice: createSession(alice.id).token,
    bob: createSession(bob.id).token,
  };
  ids = { root: admin.id, alice: alice.id, bob: bob.id };
  // A token as an old release stored it: no expiry at all.
  legacyToken = newToken("dev-token");
  legacyId = "legacytoken01";
  db.prepare(
    `INSERT INTO dev_tokens (id, user_id, token, token_hash, token_hint, name, expires_at)
     VALUES (?, ?, ?, ?, ?, 'old laptop', NULL)`
  ).run(legacyId, alice.id, placeholderFor(legacyId), hashToken(legacyToken), tokenHint(legacyToken));
  // Bob has only a modern token with its own expiry.
  createDevToken(bob.id, "modern", 30);
});

const get = (path: string, who: string) =>
  app.request(path, { headers: { cookie: `runway_session=${sessions[who]}` } });
const post = (path: string, who: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      cookie: `runway_session=${sessions[who]}; runway_csrf=${CSRF}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ _csrf: CSRF }).toString(),
  });

describe("after the upgrade gave a token without expiry a date", () => {
  it("sets 90 days on exactly the token that had none, once", () => {
    const before = Date.now();
    expect(expireLegacyDevTokens(db)).toBe(1);
    expect(expireLegacyDevTokens(db)).toBe(0);
    const t = listDevTokens(ids.alice!).find((x) => x.id === legacyId)!;
    expect(t.expiry_assigned).toBe(1);
    const ms = Date.parse(t.expires_at!.replace(" ", "T") + "Z");
    expect(ms).toBeGreaterThan(before + 89 * DAY);
    expect(ms).toBeLessThan(Date.now() + 91 * DAY);
    // Bob's own token kept its own date and is not marked.
    expect(listDevTokens(ids.bob!).every((x) => x.expiry_assigned === 0)).toBe(true);
  });

  it("the token keeps working until the new date, and stops after it", () => {
    const row = getDevTokenByToken(legacyToken)!;
    expect(row).toBeDefined();
    expect(row.id).toBe(legacyId);
    const expiry = Date.parse(row.expires_at!.replace(" ", "T") + "Z");
    expect(getDevTokenByToken(legacyToken, expiry - 1000)).toBeDefined();
    expect(getDevTokenByToken(legacyToken, expiry + 1000)).toBeUndefined();
  });

  it("the Account page of its owner says so, with the date, and tags the row", async () => {
    const html = await (await get("/account", "alice")).text();
    const row = listDevTokens(ids.alice!).find((x) => x.id === legacyId)!;
    expect(html).toContain('id="legacy-expiry"');
    expect(html).toContain(`will stop working on ${row.expires_at!.slice(0, 10)}`);
    expect(html).toContain("set by upgrade");
    expect(html).toContain("generate a new token");
  });

  it("someone whose tokens all had a date sees no notice", async () => {
    const html = await (await get("/account", "bob")).text();
    expect(html).not.toContain('id="legacy-expiry"');
    expect(html).not.toContain("set by upgrade");
  });

  it("the administrator's overview shows the same tag", async () => {
    const html = await (await get("/users", "root")).text();
    expect(html).toContain("set by upgrade");
  });

  it("the notice goes away when the token is revoked", async () => {
    const r = await post(`/account/tokens/${legacyId}/delete`, "alice");
    expect([302, 303]).toContain(r.status);
    const html = await (await get("/account", "alice")).text();
    expect(html).not.toContain('id="legacy-expiry"');
  });
});

describe("legacyExpiryNotice", () => {
  const NOW = Date.parse("2026-11-23T10:00:00Z");
  const row = (over: Record<string, unknown> = {}) => ({
    expires_at: "2027-02-21 10:00:00",
    revoked_at: null,
    expiry_assigned: 1,
    ...over,
  });

  it("is empty when nothing was dated by the upgrade", () => {
    expect(legacyExpiryNotice([], NOW)).toBe("");
    expect(legacyExpiryNotice([row({ expiry_assigned: 0 })], NOW)).toBe("");
  });

  it("names the date for one token", () => {
    const html = legacyExpiryNotice([row()], NOW);
    expect(html).toContain("One of your tokens will stop working on 2027-02-21");
  });

  it("counts several and names the earliest date", () => {
    const html = legacyExpiryNotice([row(), row({ expires_at: "2027-02-01 10:00:00" })], NOW);
    expect(html).toContain("2 of your tokens will stop working on 2027-02-01");
  });

  it("ignores tokens that have expired or been revoked", () => {
    expect(legacyExpiryNotice([row({ expires_at: "2026-11-01 00:00:00" })], NOW)).toBe("");
    expect(legacyExpiryNotice([row({ revoked_at: "2026-11-10 00:00:00" })], NOW)).toBe("");
  });
});
