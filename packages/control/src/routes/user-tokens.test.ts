/**
 * User tokens (rwu_…) on the API and /mcp (S10, S18): one token for every app
 * a person may see, limited by its scope, checked against the dashboard's own
 * rights on every request, expiring, revocable, audited, rate limited. Drives
 * the real app against an in-memory database; only the rebuild runner and the
 * Trivy rescan are replaced.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const startRebuildRun = vi.hoisted(() => vi.fn());
vi.mock("../deploy/rebuild.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../deploy/rebuild.js")>();
  return { ...real, startRebuildRun };
});
const rescanApp = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../deploy/periodic-scanner.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../deploy/periodic-scanner.js")>();
  return { ...real, rescanApp };
});

import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { appsVisibleTo, createApp, getAppByKey, updateApp } from "../db/apps.js";
import { createSession } from "../db/sessions.js";
import { createUser, deleteUser, setUserRole } from "../db/users.js";
import {
  createUserToken,
  getUserTokenById,
  listUserTokens,
  revokeUserToken,
  TokenLimitError,
} from "../db/user-tokens.js";
import { createDevToken, deleteDevTokenAsAdmin, getDevTokenByToken } from "../db/dev-tokens.js";
import { RebuildBusyError } from "../deploy/rebuild.js";
import { endRescan, tryBeginRescan, activeRescan } from "../deploy/rescan-guard.js";
import { resetTokenLimits } from "../middleware/token-limit.js";
import { USER_TOKEN_ONLY_ROUTES } from "../middleware/api-authorize.js";
import { hashToken } from "../util/token-hash.js";

const CSRF = "test-csrf-token";
const ENV_KEYS = ["RATE_LIMIT_READ_PER_MIN", "RATE_LIMIT_WRITE_PER_MIN", "RATE_LIMIT_HEAVY_PER_10MIN", "RATE_LIMIT_AUTH_FAIL_PER_10MIN"];

const u: Record<string, { id: string }> = {};
let sessions: Record<string, string> = {};
const apps: Record<string, { id: string; key: string }> = {};
let t: Record<string, string> = {}; // tokens by label

beforeAll(async () => {
  migrate();
  process.env.DASHBOARD_DOMAIN = "runway.example.com";
  for (const [name, role] of [["root", "admin"], ["alice", "member"], ["bob", "member"]] as const) {
    u[name] = await createUser(name, `pw-${name}-123456`, role);
  }
  sessions = Object.fromEntries(Object.entries(u).map(([n, x]) => [n, createSession(x.id).token]));
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetTokenLimits();
  startRebuildRun.mockReset();
  startRebuildRun.mockReturnValue(7);
  rescanApp.mockReset();
  rescanApp.mockResolvedValue(undefined);
  const r = activeRescan();
  if (r) endRescan(r);
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM apps");
  db.exec("DELETE FROM user_tokens");
  const mk = (owner: string | undefined, name: string, extra: Record<string, unknown> = {}) => {
    const a = createApp(owner);
    updateApp(a.id, { name, runtime: "node", image_tag: `runway/${name}:1`, status: "running", ...extra } as never);
    return { id: a.id, key: a.api_key };
  };
  apps.alice1 = mk("alice", "alice-one");
  apps.alice2 = mk("alice", "alice-two");
  apps.bob1 = mk("bob", "bob-one");
  apps.orphan = mk(undefined, "orphan");
  apps.noimage = mk("alice", "never-built", { image_tag: null });
  t = {
    aliceRead: createUserToken(u.alice!.id, "r", "read").token,
    aliceDeploy: createUserToken(u.alice!.id, "d", "deploy").token,
    bobDeploy: createUserToken(u.bob!.id, "d", "deploy").token,
    rootRead: createUserToken(u.root!.id, "r", "read").token,
    rootDeploy: createUserToken(u.root!.id, "d", "deploy").token,
    rootAdmin: createUserToken(u.root!.id, "a", "admin").token,
  };
});

function call(token: string, method: string, path: string, opts: { app?: string; body?: unknown; query?: string } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (opts.app) headers["x-runway-app"] = opts.app;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.request(`/api/v1${path}${opts.query ?? ""}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}
const json = async (r: Response) => (await r.json()) as any;
const audit = (where = "1=1") => db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`).all() as any[];

describe("who am I", () => {
  it("answers with the person, the scope and the expiry, and no secret", async () => {
    const res = await call(t.aliceDeploy!, "GET", "/me");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.user).toEqual({ id: u.alice!.id, username: "alice", role: "member" });
    expect(body.token.scope).toBe("deploy");
    expect(body.token.expires_at).toMatch(/^\d{4}-\d\d-\d\d/);
    expect(JSON.stringify(body)).not.toContain("rwu_");
    expect(JSON.stringify(body)).not.toContain("hash");
  });

  it("refuses no token, a made-up token, a token of the wrong kind, and an app key", async () => {
    expect((await app.request("/api/v1/me")).status).toBe(401);
    expect((await call("rwu_nothingtoseehere", "GET", "/me")).status).toBe(401);
    expect((await call("rwd_nothingtoseehere", "GET", "/me")).status).toBe(401);
    const res = await call(apps.alice1!.key, "GET", "/me");
    expect(res.status).toBe(403);
    expect((await json(res)).error).toContain("user token");
  });
});

describe("which apps a token reaches", () => {
  it("lists exactly the apps the dashboard shows that person", async () => {
    for (const who of ["alice", "bob", "root"]) {
      const token = who === "alice" ? t.aliceRead! : who === "bob" ? t.bobDeploy! : t.rootRead!;
      const body = await json(await call(token, "GET", "/apps"));
      const user = u[who]!;
      const expected = appsVisibleTo(user.id, who === "root").map((a) => a.id).sort();
      expect(body.apps.map((a: any) => a.id).sort()).toEqual(expected);
    }
    // Spelled out, so a change in the rule is a visible change here too.
    const alice = await json(await call(t.aliceRead!, "GET", "/apps"));
    expect(alice.apps.map((a: any) => a.id).sort()).toEqual([apps.alice1!.id, apps.alice2!.id, apps.noimage!.id].sort());
    expect((await json(await call(t.rootRead!, "GET", "/apps"))).apps).toHaveLength(5);
  });

  it("says what the person may do on each app", async () => {
    const body = await json(await call(t.aliceRead!, "GET", "/apps"));
    expect(body.apps[0].can).toEqual({ rebuild: true, rescan: true });
  });

  it("an app route needs the app named", async () => {
    const res = await call(t.aliceRead!, "GET", "/app");
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain("X-Runway-App");
  });

  it("works with the app in the header or in ?app=", async () => {
    const h = await json(await call(t.aliceRead!, "GET", "/app", { app: apps.alice1!.id }));
    expect(h.id).toBe(apps.alice1!.id);
    const q = await json(await call(t.aliceRead!, "GET", "/app", { query: `?app=${apps.alice2!.id}` }));
    expect(q.id).toBe(apps.alice2!.id);
  });

  it("somebody else's app, an ownerless app and an unknown app all look the same (404)", async () => {
    const answers: string[] = [];
    for (const id of [apps.bob1!.id, apps.orphan!.id, "doesnotexist"]) {
      const res = await call(t.aliceDeploy!, "GET", "/app", { app: id });
      expect(res.status).toBe(404);
      answers.push(JSON.stringify(await json(res)));
    }
    expect(new Set(answers).size).toBe(1);
  });

  it("an owner cannot touch another owner's app with any verb", async () => {
    for (const [m, p, body] of [
      ["PUT", "/app/env", { env: { A: "1" } }],
      ["GET", "/app/env", undefined],
      ["POST", "/app/rebuild", undefined],
      ["POST", "/app/rescan", undefined],
      ["POST", "/app/rotate-key", {}],
      ["DELETE", "/app/env/A", undefined],
      ["PUT", "/app/domain", { custom_domain: "x.example.org" }],
    ] as const) {
      const res = await call(t.aliceDeploy!, m, p, { app: apps.bob1!.id, body });
      expect(res.status, `${m} ${p}`).toBe(404);
    }
    expect(startRebuildRun).not.toHaveBeenCalled();
    expect(rescanApp).not.toHaveBeenCalled();
    expect(getAppByKey(apps.bob1!.key)?.id).toBe(apps.bob1!.id);
  });

  it("an administrator reaches every app, an ownerless one included", async () => {
    for (const a of Object.values(apps)) {
      expect((await call(t.rootRead!, "GET", "/app", { app: a.id })).status).toBe(200);
    }
  });

  it("a person who stops being an administrator loses every app but their own, at once", async () => {
    expect((await call(t.rootRead!, "GET", "/app", { app: apps.alice1!.id })).status).toBe(200);
    setUserRole(u.root!.id, "member");
    try {
      expect((await call(t.rootRead!, "GET", "/app", { app: apps.alice1!.id })).status).toBe(404);
      expect(((await json(await call(t.rootRead!, "GET", "/apps"))).apps)).toHaveLength(0);
    } finally {
      setUserRole(u.root!.id, "admin");
    }
  });

  it("ownership moving to somebody else takes effect on the next request", async () => {
    expect((await call(t.aliceRead!, "GET", "/app", { app: apps.alice1!.id })).status).toBe(200);
    db.prepare(`UPDATE apps SET owner_user_id = ? WHERE id = ?`).run(u.bob!.id, apps.alice1!.id);
    expect((await call(t.aliceRead!, "GET", "/app", { app: apps.alice1!.id })).status).toBe(404);
    expect((await call(t.bobDeploy!, "GET", "/app", { app: apps.alice1!.id })).status).toBe(200);
  });
});

describe("scopes", () => {
  it("a read token reads and cannot change anything", async () => {
    expect((await call(t.aliceRead!, "GET", "/app", { app: apps.alice1!.id })).status).toBe(200);
    expect((await call(t.aliceRead!, "GET", "/app/deploys", { app: apps.alice1!.id })).status).toBe(200);
    const writes: Array<[string, string, unknown?]> = [
      ["PUT", "/app/env", { env: { A: "1" } }],
      ["POST", "/app/deploy"],
      ["POST", "/app/configure", { name: "x", runtime: "node" }],
      ["PUT", "/app/domain", { custom_domain: "x.example.org" }],
      ["PUT", "/app/sso", { enabled: true }],
      ["POST", "/app/rollback"],
      ["POST", "/app/rebuild"],
      ["POST", "/app/rescan"],
      ["POST", "/app/rotate-key", {}],
      ["DELETE", "/app/env/A"],
    ];
    for (const [m, p, body] of writes) {
      const res = await call(t.aliceRead!, m, p, { app: apps.alice1!.id, body });
      expect(res.status, `${m} ${p}`).toBe(403);
      expect((await json(res)).error).toContain("scope");
    }
    expect((await call(t.aliceRead!, "POST", "/apps")).status).toBe(403);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM env_vars`).get()).toEqual({ n: 0 });
    expect(startRebuildRun).not.toHaveBeenCalled();
  });

  it("a deploy token changes its own apps", async () => {
    const res = await call(t.aliceDeploy!, "PUT", "/app/env", { app: apps.alice1!.id, body: { env: { LOG: "debug" } } });
    expect(res.status).toBe(200);
    const env = await json(await call(t.aliceDeploy!, "GET", "/app/env", { app: apps.alice1!.id }));
    expect(env.env.LOG).toBe("debug");
  });

  it("a deploy token cannot do administrator things, even as an administrator", async () => {
    for (const [m, p] of [["GET", "/tokens/all"]] as const) {
      expect((await call(t.rootDeploy!, m, p)).status).toBe(403);
    }
    expect((await call(t.rootAdmin!, "GET", "/tokens/all")).status).toBe(200);
  });

  it("an admin-scope token of somebody who is no longer an administrator is refused", async () => {
    setUserRole(u.root!.id, "member");
    try {
      const res = await call(t.rootAdmin!, "GET", "/tokens/all");
      expect(res.status).toBe(403);
      expect((await json(res)).error).toContain("administrator");
    } finally {
      setUserRole(u.root!.id, "admin");
    }
  });

  it("a member cannot be given an admin-scope token in the dashboard, and an unknown scope becomes read", async () => {
    const post = (form: string) =>
      app.request("/account/access-tokens", {
        method: "POST",
        headers: {
          cookie: `runway_session=${sessions.alice}; runway_csrf=${CSRF}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: `_csrf=${CSRF}&${form}`,
      });
    await post("name=sneaky&scope=admin&days=30");
    await post("name=odd&scope=superuser&days=30");
    const scopes = listUserTokens(u.alice!.id).filter((x) => ["sneaky", "odd"].includes(x.name)).map((x) => x.scope);
    expect(scopes).toEqual(["read", "read"]);
  });

  it("a token cannot make tokens: there is no such route", async () => {
    for (const m of ["POST", "PUT", "PATCH"]) {
      const res = await call(t.rootAdmin!, m, "/tokens", { body: { name: "x", scope: "admin" } });
      expect([404, 405]).toContain(res.status);
    }
  });
});

describe("expiry, revocation, deleted people", () => {
  it("a token past its expiry stops working", async () => {
    const past = createUserToken(u.alice!.id, "old", "read", 1, Date.now() - 3 * 86_400_000).token;
    const res = await call(past, "GET", "/me");
    expect(res.status).toBe(401);
    expect((await json(res)).error).toContain("expired");
  });

  it("always has an expiry, 90 days by default and a year at most", () => {
    const day = 86_400_000;
    const a = createUserToken(u.alice!.id, "dflt", "read");
    const b = createUserToken(u.alice!.id, "long", "read", 5000);
    const c = createUserToken(u.alice!.id, "junk", "read", Number.NaN);
    const days = (x: { expires_at: string }) => Math.round((Date.parse(x.expires_at.replace(" ", "T") + "Z") - Date.now()) / day);
    expect(days(a)).toBe(90);
    expect(days(b)).toBe(365);
    expect(days(c)).toBe(90);
  });

  it("a revoked token stops working at once, and stays listed as revoked", async () => {
    expect((await call(t.aliceDeploy!, "GET", "/me")).status).toBe(200);
    const row = listUserTokens(u.alice!.id).find((x) => x.name === "d")!;
    expect(revokeUserToken(row.id, u.root!.id)).toEqual({ user_id: u.alice!.id });
    expect((await call(t.aliceDeploy!, "GET", "/me")).status).toBe(401);
    const after = getUserTokenById(row.id)!;
    expect(after.revoked_at).toBeTruthy();
    expect(after.revoked_by).toBe(u.root!.id);
    expect(revokeUserToken(row.id, u.root!.id)).toBeNull();
  });

  it("a token dies with its person", async () => {
    const carol = await createUser("carol", "pw-carol-123456", "member");
    const token = createUserToken(carol.id, "c", "deploy").token;
    expect((await call(token, "GET", "/me")).status).toBe(200);
    deleteUser(carol.id);
    expect((await call(token, "GET", "/me")).status).toBe(401);
  });

  it("allows 20 active tokens a person and not 21", () => {
    const dave = db.prepare(`SELECT 1`).get();
    expect(dave).toBeTruthy();
    const fill = () => {
      for (let i = 0; i < 20; i++) createUserToken(u.bob!.id, `n${i}`, "read");
    };
    expect(fill).toThrow(TokenLimitError); // bob already holds one from setup
    const active = listUserTokens(u.bob!.id).filter((x) => !x.revoked_at).length;
    expect(active).toBe(20);
  });

  it("stores only a hash", () => {
    const made = createUserToken(u.alice!.id, "hash", "read");
    const row = db.prepare(`SELECT * FROM user_tokens WHERE id = ?`).get(made.id) as any;
    expect(row.token_hash).toBe(hashToken(made.token));
    expect(JSON.stringify(db.prepare(`SELECT * FROM user_tokens`).all())).not.toContain(made.token);
  });
});

describe("token routes", () => {
  it("lists a person's own tokens, never a hash or a token", async () => {
    const body = await json(await call(t.aliceRead!, "GET", "/tokens"));
    expect(body.tokens).toHaveLength(2);
    const text = JSON.stringify(body);
    expect(text).not.toContain("token_hash");
    expect(text).not.toContain("rwu_");
    for (const tok of body.tokens) expect(tok.user_id).toBe(u.alice!.id);
  });

  it("lets an administrator with the admin scope see everybody's", async () => {
    const body = await json(await call(t.rootAdmin!, "GET", "/tokens/all"));
    expect(body.tokens.length).toBe(Number((db.prepare(`SELECT COUNT(*) AS n FROM user_tokens`).get() as any).n));
    expect(body.tokens.some((x: any) => x.username === "alice")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("token_hash");
  });

  it("revokes your own token, but not somebody else's, with a deploy token", async () => {
    const own = listUserTokens(u.alice!.id).find((x) => x.name === "r")!;
    const theirs = listUserTokens(u.bob!.id)[0]!;
    expect((await call(t.aliceDeploy!, "DELETE", `/tokens/${theirs.id}`)).status).toBe(404);
    expect(getUserTokenById(theirs.id)!.revoked_at).toBeNull();
    expect((await call(t.aliceDeploy!, "DELETE", `/tokens/${own.id}`)).status).toBe(200);
    expect((await call(t.aliceRead!, "GET", "/me")).status).toBe(401);
  });

  it("an administrator with the admin scope revokes anybody's", async () => {
    const theirs = listUserTokens(u.bob!.id)[0]!;
    expect((await call(t.rootDeploy!, "DELETE", `/tokens/${theirs.id}`)).status).toBe(404);
    expect((await call(t.rootAdmin!, "DELETE", `/tokens/${theirs.id}`)).status).toBe(200);
    expect((await call(t.bobDeploy!, "GET", "/me")).status).toBe(401);
    expect(audit("action = 'user_token_revoked'")[0]!.detail).toContain("administrator");
  });

  it("an unknown token id is a 404", async () => {
    expect((await call(t.rootAdmin!, "DELETE", "/tokens/nope")).status).toBe(404);
  });
});

describe("making an app", () => {
  it("creates an unconfigured app owned by the person", async () => {
    const res = await call(t.aliceDeploy!, "POST", "/apps");
    expect(res.status).toBe(201);
    const id = (await json(res)).id;
    const row = db.prepare(`SELECT owner_user_id, name FROM apps WHERE id = ?`).get(id) as any;
    expect(row.owner_user_id).toBe(u.alice!.id);
    expect(row.name).toBeNull();
    expect((await json(await call(t.aliceRead!, "GET", "/apps"))).apps.map((a: any) => a.id)).toContain(id);
    expect((await json(await call(t.bobDeploy!, "GET", "/apps"))).apps.map((a: any) => a.id)).not.toContain(id);
  });
});

describe("rebuild and rescan", () => {
  it("an owner rebuilds their app; one run, audited", async () => {
    const res = await call(t.aliceDeploy!, "POST", "/app/rebuild", { app: apps.alice1!.id });
    expect(res.status).toBe(202);
    expect((await json(res)).run_id).toBe(7);
    expect(startRebuildRun).toHaveBeenCalledWith(expect.objectContaining({ appIds: [apps.alice1!.id] }));
    const line = audit("action = 'app_rebuild_started'")[0]!;
    expect(line.detail).toContain("by owner");
    expect(line.detail).toContain("api token");
  });

  it("an administrator rebuilds any app", async () => {
    expect((await call(t.rootDeploy!, "POST", "/app/rebuild", { app: apps.bob1!.id })).status).toBe(202);
    expect((await call(t.rootDeploy!, "POST", "/app/rebuild", { app: apps.orphan!.id })).status).toBe(202);
  });

  it("says why when it cannot, and when one is already running", async () => {
    const blocked = await call(t.aliceDeploy!, "POST", "/app/rebuild", { app: apps.noimage!.id });
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).code).toBe("blocked");
    startRebuildRun.mockImplementation(() => {
      throw new RebuildBusyError();
    });
    const busy = await call(t.aliceDeploy!, "POST", "/app/rebuild", { app: apps.alice1!.id });
    expect(busy.status).toBe(409);
    expect((await json(busy)).code).toBe("busy");
  });

  it("an owner rescans their app, one scan at a time", async () => {
    expect((await call(t.aliceDeploy!, "POST", "/app/rescan", { app: apps.alice1!.id })).status).toBe(200);
    expect(rescanApp).toHaveBeenCalledTimes(1);
    expect(audit("action = 'app_rescanned'")[0]!.detail).toContain("by owner");
    tryBeginRescan(apps.alice2!.id);
    const busy = await call(t.aliceDeploy!, "POST", "/app/rescan", { app: apps.alice1!.id });
    expect(busy.status).toBe(409);
    expect((await json(busy)).code).toBe("busy");
    expect(rescanApp).toHaveBeenCalledTimes(1);
  });

  it("an app key cannot rebuild or rescan", async () => {
    for (const p of ["/app/rebuild", "/app/rescan", "/app/rotate-key"]) {
      expect((await call(apps.alice1!.key, "POST", p)).status, p).toBe(403);
    }
    expect(startRebuildRun).not.toHaveBeenCalled();
    expect(rescanApp).not.toHaveBeenCalled();
  });
});

describe("rotating an app key with a token", () => {
  it("the owner gets the new key once; the old one stops, the new one works", async () => {
    const res = await call(t.aliceDeploy!, "POST", "/app/rotate-key", { app: apps.alice1!.id, body: {} });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.key.startsWith("rwy_")).toBe(true);
    expect(body.hint).toBe(body.key.slice(-4));
    expect(body.previous_key_valid_until).toBeNull();
    expect(getAppByKey(apps.alice1!.key)).toBeUndefined();
    expect(getAppByKey(body.key)?.id).toBe(apps.alice1!.id);
    // It is not in the audit log, not in the dashboard audit, not anywhere in the database.
    expect(JSON.stringify(audit())).not.toContain(body.key);
    expect(JSON.stringify(db.prepare(`SELECT * FROM apps`).all())).not.toContain(body.key);
  });

  it("can keep the old key for an overlap", async () => {
    const body = await json(await call(t.aliceDeploy!, "POST", "/app/rotate-key", { app: apps.alice1!.id, body: { grace_minutes: 60 } }));
    expect(body.previous_key_valid_until).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(getAppByKey(apps.alice1!.key)?.id).toBe(apps.alice1!.id);
  });

  it("an administrator needs the admin scope for an app that is not theirs", async () => {
    expect((await call(t.rootDeploy!, "POST", "/app/rotate-key", { app: apps.alice1!.id, body: {} })).status).toBe(403);
    expect(getAppByKey(apps.alice1!.key)?.id).toBe(apps.alice1!.id);
    expect((await call(t.rootAdmin!, "POST", "/app/rotate-key", { app: apps.alice1!.id, body: {} })).status).toBe(200);
    expect(getAppByKey(apps.alice1!.key)).toBeUndefined();
  });
});

describe("the audit log", () => {
  it("names the token, the person and the app, and never a token", async () => {
    await call(t.aliceDeploy!, "PUT", "/app/env", { app: apps.alice1!.id, body: { env: { SECRET_NAME: "super-secret-value" } } });
    const line = audit("action = 'api_put_env'")[0]!;
    const tokenRow = listUserTokens(u.alice!.id).find((x) => x.name === "d")!;
    expect(line.actor_type).toBe("user-token");
    expect(line.user_id).toBe(`user-token:${tokenRow.id}`);
    expect(line.app_id).toBe(apps.alice1!.id);
    expect(line.result).toBe("ok");
    expect(line.detail).toContain("user=alice");
    expect(line.detail).toContain("env{SECRET_NAME}");
    const all = JSON.stringify(audit());
    expect(all).not.toContain("super-secret-value");
    for (const token of Object.values(t)) expect(all).not.toContain(token);
  });

  it("records a call that is about no single app (list, make) with no app id", async () => {
    await call(t.aliceDeploy!, "POST", "/apps");
    const line = audit("action = 'api_post_apps'")[0]!;
    expect(line.actor_type).toBe("user-token");
    expect(line.detail).toContain("user=alice");
  });

  it("folds refusals into one counted row instead of one per request", async () => {
    for (let i = 0; i < 6; i++) await call(t.aliceRead!, "PUT", "/app/env", { app: apps.alice1!.id, body: { env: { A: "1" } } });
    const rows = audit("action = 'api_forbidden'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(6);
    expect(rows[0]!.detail).toContain("need=deploy");
    expect(JSON.stringify(rows)).not.toContain(t.aliceRead!);
  });

  it("notes a refused token as one counted row without the token", async () => {
    for (let i = 0; i < 4; i++) await call("rwu_wrongwrongwrongwrongwrongwrongwr", "GET", "/me");
    const rows = audit("action = 'api_auth_denied'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(4);
    expect(JSON.stringify(rows)).not.toContain("wrongwrong");
  });
});

describe("rate limits per token", () => {
  it("counts each token on its own, even two of the same person", async () => {
    process.env.RATE_LIMIT_READ_PER_MIN = "3";
    for (let i = 0; i < 3; i++) expect((await call(t.aliceRead!, "GET", "/me")).status).toBe(200);
    const limited = await call(t.aliceRead!, "GET", "/me");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(await json(limited))).not.toContain("user-token");
    expect((await call(t.aliceDeploy!, "GET", "/me")).status).toBe(200);
    expect((await call(t.bobDeploy!, "GET", "/me")).status).toBe(200);
  });

  it("puts rebuild and rescan in the heavy bucket", async () => {
    process.env.RATE_LIMIT_HEAVY_PER_10MIN = "2";
    expect((await call(t.aliceDeploy!, "POST", "/app/rescan", { app: apps.alice1!.id })).status).toBe(200);
    expect((await call(t.aliceDeploy!, "POST", "/app/rebuild", { app: apps.alice1!.id })).status).toBe(202);
    expect((await call(t.aliceDeploy!, "POST", "/app/rebuild", { app: apps.alice1!.id })).status).toBe(429);
    // Reading is a different bucket.
    expect((await call(t.aliceDeploy!, "GET", "/me")).status).toBe(200);
  });

  it("counts refusals too, so a token that keeps asking for what it may not have is slowed down", async () => {
    process.env.RATE_LIMIT_WRITE_PER_MIN = "2";
    expect((await call(t.aliceRead!, "PUT", "/app/env", { app: apps.alice1!.id, body: {} })).status).toBe(403);
    expect((await call(t.aliceRead!, "PUT", "/app/env", { app: apps.alice1!.id, body: {} })).status).toBe(403);
    expect((await call(t.aliceRead!, "PUT", "/app/env", { app: apps.alice1!.id, body: {} })).status).toBe(429);
  });
});

describe("the route table", () => {
  it("every user-token-only route is a real route", () => {
    const routes = new Set(app.routes.map((r) => r.path));
    for (const p of USER_TOKEN_ONLY_ROUTES) expect(routes.has(p), `${p} is not a route`).toBe(true);
  });

  it("every route that needs a person is closed to an app key", async () => {
    for (const r of app.routes.filter((x) => x.path.startsWith("/api/v1/") && USER_TOKEN_ONLY_ROUTES.has(x.path))) {
      const url = r.path.replace("/api/v1", "").replace(/:[A-Za-z]+/g, "x");
      const res = await call(apps.alice1!.key, r.method === "ALL" ? "GET" : r.method, url, { body: r.method === "GET" ? undefined : {} });
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
    }
  });
});

describe("the skills MCP route", () => {
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  };
  const mcp = (token: string) =>
    app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initialize),
    });

  it("accepts a user token of any scope, and a developer token", async () => {
    expect((await mcp(t.aliceRead!)).status).toBe(200);
    expect((await mcp(t.rootAdmin!)).status).toBe(200);
    expect((await mcp(createDevToken(u.alice!.id, "skills").token)).status).toBe(200);
  });

  it("refuses an expired, a revoked and an unknown token", async () => {
    const old = createUserToken(u.alice!.id, "old", "read", 1, Date.now() - 3 * 86_400_000).token;
    expect((await mcp(old)).status).toBe(401);
    const dev = createDevToken(u.alice!.id, "old", 1, Date.now() - 3 * 86_400_000);
    expect((await mcp(dev.token)).status).toBe(401);
    const live = createDevToken(u.alice!.id, "live");
    expect((await mcp(live.token)).status).toBe(200);
    deleteDevTokenAsAdmin(live.id);
    expect((await mcp(live.token)).status).toBe(401);
    expect((await mcp("rwu_unknownunknownunknownunknownunk")).status).toBe(401);
  });

  it("an old developer token without an expiry keeps working", async () => {
    const dev = createDevToken(u.alice!.id, "legacy");
    db.prepare(`UPDATE dev_tokens SET expires_at = NULL WHERE id = ?`).run(dev.id);
    expect(getDevTokenByToken(dev.token)?.id).toBe(dev.id);
    expect((await mcp(dev.token)).status).toBe(200);
  });

  it("a developer token cannot call the API, and an app key cannot use /mcp", async () => {
    const dev = createDevToken(u.alice!.id, "skills").token;
    expect((await call(dev, "GET", "/me")).status).toBe(401);
    expect((await mcp(apps.alice1!.key)).status).toBe(401);
  });
});

describe("the dashboard side", () => {
  const form = (who: string, path: string, body = "", csrf = true) =>
    app.request(path, {
      method: "POST",
      headers: {
        cookie: [`runway_session=${sessions[who]}`, csrf ? `runway_csrf=${CSRF}` : ""].filter(Boolean).join("; "),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: csrf ? `_csrf=${CSRF}&${body}` : body,
    });
  const page = (who: string, path: string) => app.request(path, { headers: { cookie: `runway_session=${sessions[who]}` } });

  it("shows a new token once and never again", async () => {
    const res = await form("alice", "/account/access-tokens", "name=ci&scope=deploy&days=30");
    expect(res.status).toBe(200);
    const html = await res.text();
    const token = html.match(/rwu_[A-Za-z0-9_-]{32}/)![0];
    expect(html).toContain("only time");
    expect((await call(token, "GET", "/me")).status).toBe(200);
    const list = await (await page("alice", "/account")).text();
    expect(list).not.toContain(token);
    expect(list).toContain(`…${token.slice(-4)}`);
    const line = audit("action = 'user_token_created'")[0]!;
    expect(line.detail).toContain("deploy");
    expect(JSON.stringify(audit())).not.toContain(token);
  });

  it("revokes your own token, and only your own", async () => {
    const mine = listUserTokens(u.alice!.id)[0]!;
    const theirs = listUserTokens(u.bob!.id)[0]!;
    await form("alice", `/account/access-tokens/${theirs.id}/delete`);
    expect(getUserTokenById(theirs.id)!.revoked_at).toBeNull();
    await form("alice", `/account/access-tokens/${mine.id}/delete`);
    expect(getUserTokenById(mine.id)!.revoked_at).toBeTruthy();
  });

  it("needs the CSRF token and a signed-in person", async () => {
    expect((await form("alice", "/account/access-tokens", "name=x&scope=read&days=30", false)).status).toBe(403);
    const anon = await app.request("/account/access-tokens", {
      method: "POST",
      headers: { cookie: `runway_csrf=${CSRF}`, "content-type": "application/x-www-form-urlencoded" },
      body: `_csrf=${CSRF}&name=x&scope=read&days=30`,
    });
    expect(anon.headers.get("location") ?? "").toMatch(/login/);
  });

  it("lets an administrator see and revoke every token, and nobody else", async () => {
    const theirs = listUserTokens(u.bob!.id)[0]!;
    const html = await (await page("root", "/users")).text();
    expect(html).toContain("api-tokens");
    expect(html).toContain("bob");
    expect(html).not.toMatch(/rwu_[A-Za-z0-9_-]{32}/);
    expect((await form("alice", `/users/tokens/${theirs.id}/revoke`)).headers.get("location") ?? "").toContain("forbidden");
    expect(getUserTokenById(theirs.id)!.revoked_at).toBeNull();
    await form("root", `/users/tokens/${theirs.id}/revoke`);
    expect(getUserTokenById(theirs.id)!.revoked_at).toBeTruthy();
    expect(audit("action = 'user_token_revoked'")[0]!.detail).toContain("administrator");
  });

  it("lets an administrator end a skill token too", async () => {
    const dev = createDevToken(u.bob!.id, "skills");
    expect((await form("alice", `/users/dev-tokens/${dev.id}/revoke`)).headers.get("location") ?? "").toContain("forbidden");
    expect(getDevTokenByToken(dev.token)?.id).toBe(dev.id);
    await form("root", `/users/dev-tokens/${dev.id}/revoke`);
    expect(getDevTokenByToken(dev.token)).toBeUndefined();
  });
});
