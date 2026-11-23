/**
 * Google/Microsoft sign-in end to end against the real app (CSRF, cookies,
 * audit included) with the provider's token endpoint stubbed: strangers are
 * refused, allowlisted people and invitations get in once, unverified
 * addresses and impostors never do, and the redirect after login cannot
 * leave the site. Plus the admin screen and the migration.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createSession } from "../db/sessions.js";
import { createUser, getUserByEmail, setUserEmail } from "../db/users.js";
import { setSetting } from "../db/settings.js";
import { addAccess } from "../db/oauth-access.js";
import { createApp, updateApp } from "../db/apps.js";

const CSRF = "test-csrf-token";
let adminTok = "";
let memberTok = "";

beforeAll(async () => {
  migrate();
  setSetting("oauth_google_client_id", "gid");
  setSetting("oauth_google_client_secret", "gsecret");
  setSetting("oauth_microsoft_client_id", "mid");
  setSetting("oauth_microsoft_client_secret", "msecret");
  setSetting("base_domain", "apps.example.com");
  const root = await createUser("root", "pw-root-123456", "admin");
  const sam = await createUser("sam", "pw-sam-123456", "member");
  setUserEmail(root.id, "root@corp.example");
  adminTok = createSession(root.id).token;
  memberTok = createSession(sam.id).token;
});

beforeEach(() => {
  db.exec("DELETE FROM oauth_access");
  db.exec("DELETE FROM audit_log");
  // every test starts with only the two seeded people, root unpinned
  db.exec("DELETE FROM users WHERE username NOT IN ('root','sam')");
  db.exec("UPDATE users SET oauth_provider = NULL, oauth_sub = NULL");
});
afterEach(() => vi.unstubAllGlobals());

const jwt = (p: object) => `h.${Buffer.from(JSON.stringify(p)).toString("base64url")}.s`;

/** Run the callback with a given id_token payload; returns the response. */
async function callback(
  provider: "google" | "microsoft",
  claims: Record<string, unknown>,
  opts: { state?: string; returnTo?: string } = {}
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ id_token: jwt({ nonce: "N", ...claims }), access_token: "a" }), { status: 200 })
    )
  );
  const cookie = [
    "runway_oauth_state=S",
    "runway_oauth_nonce=N",
    "runway_oauth_pkce=V",
    opts.returnTo !== undefined ? `runway_oauth_return=${encodeURIComponent(opts.returnTo)}` : "",
  ].filter(Boolean).join("; ");
  return app.request(`/auth/${provider}/callback?state=${opts.state ?? "S"}&code=C`, { headers: { cookie } });
}
const loc = (r: Response) => r.headers.get("location") ?? "";
const audit = (action: string) =>
  db.prepare(`SELECT username, detail FROM audit_log WHERE action = ?`).all(action) as Array<{ username: string; detail: string }>;
const google = (email: string, extra: Record<string, unknown> = {}) => ({ sub: `g-${email}`, email, email_verified: true, ...extra });

describe("a stranger", () => {
  it("is refused with a generic message and no account is created", async () => {
    const r = await callback("google", google("new@corp.example"));
    expect(loc(r)).toBe("/login?error=oauth_denied");
    expect(getUserByEmail("new@corp.example")).toBeUndefined();
    expect(r.headers.get("set-cookie") ?? "").not.toContain("runway_session=");
    expect(audit("oauth_denied")[0]?.detail).toContain("reason=not_invited");
  });

  it("gets an account when their address is allowlisted", async () => {
    addAccess({ kind: "email", value: "ann@corp.example" });
    const r = await callback("google", google("ann@corp.example"));
    expect(loc(r)).toBe("/");
    expect(r.headers.get("set-cookie") ?? "").toContain("runway_session=");
    const u = getUserByEmail("ann@corp.example")!;
    expect(u.role).toBe("member");
    expect(u.oauth_sub).toBe("g-ann@corp.example");
  });

  it("gets an account when their domain is allowlisted, and the entry stays", async () => {
    addAccess({ kind: "domain", value: "corp.example" });
    expect(loc(await callback("google", google("b1@corp.example")))).toBe("/");
    expect(loc(await callback("google", google("b2@corp.example")))).toBe("/");
    expect(getUserByEmail("b2@corp.example")).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) c FROM oauth_access").get()).toEqual({ c: 1 });
  });

  it("is not let in by a look-alike domain", async () => {
    addAccess({ kind: "domain", value: "corp.example" });
    expect(loc(await callback("google", google("x@evilcorp.example")))).toBe("/login?error=oauth_denied");
    expect(loc(await callback("google", google("x@sub.corp.example")))).toBe("/login?error=oauth_denied");
  });

  it("uses up an invitation on the first account", async () => {
    addAccess({ kind: "email", value: "inv@corp.example" }, { invite: true });
    expect(loc(await callback("google", google("inv@corp.example")))).toBe("/");
    expect(db.prepare("SELECT COUNT(*) c FROM oauth_access").get()).toEqual({ c: 0 });
    // The account exists, so a later login is a normal login; delete it and the invitation is gone.
    db.prepare("DELETE FROM users WHERE email = ?").run("inv@corp.example");
    expect(loc(await callback("google", google("inv@corp.example", { sub: "g-other" })))).toBe("/login?error=oauth_denied");
  });
});

describe("unverified addresses", () => {
  it("never get an account, even when allowlisted", async () => {
    addAccess({ kind: "email", value: "ann@corp.example" });
    const r = await callback("google", google("ann@corp.example", { email_verified: false }));
    expect(loc(r)).toBe("/login?error=oauth_denied");
    expect(getUserByEmail("ann@corp.example")).toBeUndefined();
    expect(audit("oauth_denied")[0]?.detail).toContain("unverified_email");
  });

  it("never link to an existing account (the admin is safe from a Microsoft tenant trick)", async () => {
    const r = await callback("microsoft", { sub: "attacker", email: "root@corp.example" });
    expect(loc(r)).toBe("/login?error=oauth_denied");
    expect(r.headers.get("set-cookie") ?? "").not.toContain("runway_session=");
    expect(getUserByEmail("root@corp.example")!.oauth_sub).toBeNull();
  });

  it("Microsoft with xms_edov counts as verified", async () => {
    addAccess({ kind: "email", value: "ms@corp.example" });
    const r = await callback("microsoft", { sub: "m1", email: "ms@corp.example", xms_edov: true });
    expect(loc(r)).toBe("/");
    expect(getUserByEmail("ms@corp.example")!.oauth_provider).toBe("microsoft");
  });

  it("give the visitor the same answer as a stranger (no way to probe who has an account)", async () => {
    const a = await callback("google", google("root@corp.example", { email_verified: false }));
    const b = await callback("google", google("nobody@corp.example"));
    expect(loc(a)).toBe(loc(b));
  });
});

describe("existing accounts", () => {
  it("sign in on a verified address, and are pinned to that identity", async () => {
    const r = await callback("google", google("root@corp.example", { sub: "root-sub" }));
    expect(loc(r)).toBe("/");
    expect(getUserByEmail("root@corp.example")!.oauth_sub).toBe("root-sub");
  });

  it("then refuse a different identity with the same address", async () => {
    await callback("google", google("root@corp.example", { sub: "root-sub" }));
    const r = await callback("google", google("root@corp.example", { sub: "someone-else" }));
    expect(loc(r)).toBe("/login?error=oauth_denied");
    expect(audit("oauth_denied").some((a) => a.detail.includes("identity_mismatch"))).toBe(true);
    // the real one still gets in
    expect(loc(await callback("google", google("root@corp.example", { sub: "root-sub" })))).toBe("/");
  });
});

describe("the flow checks that were already there", () => {
  it("rejects a state mismatch", async () => {
    expect(loc(await callback("google", google("a@corp.example"), { state: "WRONG" }))).toBe("/login?error=oauth_state");
  });
  it("rejects a wrong nonce", async () => {
    expect(loc(await callback("google", google("a@corp.example", { nonce: "OTHER" })))).toBe("/login?error=oauth_nonce");
  });
});

describe("where you land after login (S17)", () => {
  beforeEach(() => addAccess({ kind: "domain", value: "corp.example" }));

  it("follows a relative path", async () => {
    expect(loc(await callback("google", google("r1@corp.example"), { returnTo: "/apps/x#scan" }))).toBe("/apps/x#scan");
  });
  it("follows an app on the base domain", async () => {
    expect(loc(await callback("google", google("r2@corp.example"), { returnTo: "https://shop.apps.example.com/p" }))).toBe("https://shop.apps.example.com/p");
  });
  it("follows an app's own custom domain", async () => {
    const a = createApp("sam");
    updateApp(a.id, { custom_domain: "shop.mine.example" } as never);
    expect(loc(await callback("google", google("r3@corp.example"), { returnTo: "https://shop.mine.example/" }))).toBe("https://shop.mine.example/");
  });
  it("drops an outside address, even one planted in the cookie", async () => {
    for (const evil of ["https://evil.example/", "//evil.example", "/\\evil.example", "https://apps.example.com.evil.example/", "javascript:alert(1)"]) {
      expect(loc(await callback("google", google("r4@corp.example"), { returnTo: evil })), evil).toBe("/");
    }
  });
  it("sanitises return_to at the start of the flow, so the cookie never holds it", async () => {
    const r = await app.request("/auth/google?return_to=" + encodeURIComponent("https://evil.example/"));
    expect(r.status).toBe(302);
    const c = r.headers.get("set-cookie") ?? "";
    expect(c).not.toContain("evil.example");
    expect(c).toMatch(/runway_oauth_return=%2F|runway_oauth_return=\//);
  });
  it("does not hand an outside return_to to the OAuth buttons on the login page", async () => {
    const html = await (await app.request("/login?return_to=" + encodeURIComponent("https://evil.example/"))).text();
    expect(html).not.toContain("evil.example");
  });
});

describe("the admin screen", () => {
  const post = (path: string, who: string | null, body: string, csrf = true) =>
    app.request(path, {
      method: "POST",
      headers: {
        cookie: [who === "admin" ? `runway_session=${adminTok}` : who === "member" ? `runway_session=${memberTok}` : "", csrf ? `runway_csrf=${CSRF}` : ""].filter(Boolean).join("; "),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: csrf ? `_csrf=${CSRF}&${body}` : body,
    });

  it("lets an admin allow an address, a domain and a one-use invitation, audited", async () => {
    expect((await post("/users/oauth-access", "admin", "entry=Ann%40Corp.Example")).status).toBe(302);
    await post("/users/oauth-access", "admin", "entry=%40team.example");
    await post("/users/oauth-access", "admin", "entry=inv%40corp.example&invite=1");
    const rows = db.prepare("SELECT kind, value, one_time FROM oauth_access ORDER BY id").all();
    expect(rows).toEqual([
      { kind: "email", value: "ann@corp.example", one_time: 0 },
      { kind: "domain", value: "team.example", one_time: 0 },
      { kind: "email", value: "inv@corp.example", one_time: 1 },
    ]);
    expect(audit("oauth_access_added")).toHaveLength(3);
    const html = await (await app.request("/users", { headers: { cookie: `runway_session=${adminTok}` } })).text();
    expect(html).toContain("ann@corp.example");
    expect(html).toContain("@team.example");
    expect(html).toContain("Invitation, one use");
  });

  it("ignores the one-use flag on a domain", async () => {
    await post("/users/oauth-access", "admin", "entry=team.example&invite=1");
    expect(db.prepare("SELECT one_time FROM oauth_access").get()).toEqual({ one_time: 0 });
  });

  it("refuses junk with a message and adds nothing", async () => {
    const r = await post("/users/oauth-access", "admin", "entry=not+valid");
    expect(r.headers.get("location")).toContain("oauth_access_invalid");
    expect(db.prepare("SELECT COUNT(*) c FROM oauth_access").get()).toEqual({ c: 0 });
  });

  it("escapes what an admin typed when it is shown", async () => {
    db.prepare("INSERT INTO oauth_access (kind, value) VALUES ('email', ?)").run("<img src=x onerror=1>@a.example");
    const html = await (await app.request("/users", { headers: { cookie: `runway_session=${adminTok}` } })).text();
    expect(html).not.toContain("<img src=x");
  });

  it("removes an entry, audited", async () => {
    addAccess({ kind: "email", value: "gone@corp.example" });
    const id = (db.prepare("SELECT id FROM oauth_access").get() as { id: number }).id;
    await post(`/users/oauth-access/${id}/delete`, "admin", "");
    expect(db.prepare("SELECT COUNT(*) c FROM oauth_access").get()).toEqual({ c: 0 });
    expect(audit("oauth_access_removed")).toHaveLength(1);
  });

  it("keeps members, anonymous visitors and CSRF-less posts out", async () => {
    expect(loc(await post("/users/oauth-access", "member", "entry=a%40b.example"))).toContain("forbidden");
    expect(loc(await post("/users/oauth-access", null, "entry=a%40b.example"))).toMatch(/login/);
    expect((await post("/users/oauth-access", "admin", "entry=a%40b.example", false)).status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) c FROM oauth_access").get()).toEqual({ c: 0 });
  });
});

describe("migration", () => {
  it("adds oauth_sub and oauth_access to an older database without touching users, and can run twice", async () => {
    db.exec("ALTER TABLE users DROP COLUMN oauth_sub");
    db.exec("DROP TABLE oauth_access");
    const before = db.prepare("SELECT COUNT(*) c FROM users").get();
    migrate();
    migrate();
    const cols = (db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("oauth_sub");
    expect(db.prepare("SELECT COUNT(*) c FROM users").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) c FROM oauth_access").get()).toEqual({ c: 0 });
  });

  it("starts empty: nobody new may sign in until an admin allows them", () => {
    expect(db.prepare("SELECT COUNT(*) c FROM oauth_access").get()).toEqual({ c: 0 });
  });
});
