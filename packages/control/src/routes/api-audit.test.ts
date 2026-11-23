/**
 * S12: what the API and the MCP route do, and who is refused, ends up in the
 * audit log, without a value ever landing there. Drives the real app (Bearer
 * app keys) against an in-memory database.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { app } from "../app.js";
import { db, migrate } from "../db/index.js";
import { createApp } from "../db/apps.js";
import { setSetting } from "../db/settings.js";
import { apiAudit, AUDITED_READS, MUTATING_METHODS, UNAUDITED_READS } from "../middleware/api-audit.js";
import { apiAuth } from "../middleware/auth.js";
import { actionFor } from "../util/audit-detail.js";

let owner = { id: "", key: "" };

beforeAll(() => {
  migrate();
  process.env.DASHBOARD_DOMAIN = "runway.example.com";
});

beforeEach(() => {
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM apps");
  try {
    db.exec("DELETE FROM rate_limits");
  } catch {
    /* created on first use */
  }
  setSetting("base_domain", "example.com");
  const a = createApp("alice");
  owner = { id: a.id, key: a.api_key };
});

function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${owner.key}`,
      "content-type": "application/json",
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function audit(where = "1=1") {
  return db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`).all() as Array<
    Record<string, any>
  >;
}

describe("the audit middleware is in place", () => {
  it("is registered on the API right after the key check", () => {
    const handlers = app.routes
      .filter((r) => r.path === "/api/v1/*")
      .map((r) => r.handler);
    const auth = handlers.indexOf(apiAuth);
    const aud = handlers.indexOf(apiAudit);
    expect(auth).toBeGreaterThanOrEqual(0);
    expect(aud).toBe(auth + 1);
  });

  it("every GET route is consciously audited or not (a new route must pick)", () => {
    const gets = new Set(
      app.routes
        .filter((r) => r.method === "GET" && r.path.startsWith("/api/v1/"))
        .map((r) => r.path)
    );
    for (const p of gets) {
      const listed = AUDITED_READS.has(p) !== UNAUDITED_READS.has(p);
      expect(listed, `GET ${p} must be in exactly one of AUDITED_READS / UNAUDITED_READS`).toBe(true);
    }
    // No stale entries either: every listed path still exists.
    for (const p of [...AUDITED_READS, ...UNAUDITED_READS]) {
      expect(gets.has(p), `${p} is listed but is not a GET route`).toBe(true);
    }
  });
});

describe("every mutating route writes an audit line", () => {
  const mutating = () =>
    app.routes.filter(
      (r) => r.path.startsWith("/api/v1/") && MUTATING_METHODS.has(r.method)
    );

  it("there are mutating routes to check (a floor, so the walk below cannot match nothing)", () => {
    expect(mutating().length).toBeGreaterThanOrEqual(14);
  });

  it("each one, even when it refuses the request, is audited with the right action and actor", async () => {
    for (const r of mutating()) {
      db.exec("DELETE FROM audit_log");
      // Fill in the path parameters with something harmless.
      const url = r.path
        .replace("/api/v1", "")
        .replace(/:[A-Za-z]+(\{[^}]*\})?/g, "x");
      await call(r.method, url, {});
      const lines = audit("actor_type = 'api-key'");
      expect(lines, `${r.method} ${r.path} wrote no audit line`).toHaveLength(1);
      expect(lines[0]!.action).toBe(actionFor(r.method, r.path));
      expect(lines[0]!.user_id).toBe(`api-key:${owner.id}`);
      expect(lines[0]!.app_id).toBe(owner.id);
      expect(["ok", "rejected", "error", "denied"]).toContain(lines[0]!.result);
    }
  });
});

describe("what goes into a line", () => {
  it("records a successful change with its result and field names", async () => {
    const res = await call("PUT", "/app/env", { env: { DB_URL: "postgres://u:p@h/db" } });
    expect(res.status).toBe(200);
    const line = audit("action = 'api_put_env'")[0]!;
    expect(line.result).toBe("ok");
    expect(line.detail).toContain("env{DB_URL}");
    expect(line.detail).toContain("status=200");
  });

  it("records a refused change as rejected", async () => {
    const res = await call("PUT", "/app/env", { nope: 1 });
    expect(res.status).toBe(400);
    expect(audit("action = 'api_put_env'")[0]!.result).toBe("rejected");
  });

  it("keeps the handler working: it still reads the body the middleware looked at", async () => {
    await call("PUT", "/app/env", { env: { A: "1", B: "2" } });
    const res = await call("GET", "/app/env");
    expect(((await res.json()) as any).env).toEqual({ A: "1", B: "2" });
  });

  it("never stores a secret value, a password or the key itself", async () => {
    await call("PUT", "/app/env", {
      env: { DB_PASSWORD: "s3cr3t-VALUE-xyz", API_TOKEN: "tok-live-9999" },
    });
    await call("PUT", "/app/basic-auth", { enabled: true, username: "bob", password: "hunter2-pass" });
    await call("DELETE", "/app/env/DB_PASSWORD");
    const dump = JSON.stringify(audit());
    for (const secret of ["s3cr3t-VALUE-xyz", "tok-live-9999", "hunter2-pass", owner.key]) {
      expect(dump).not.toContain(secret);
    }
    // The names are there: that is the point of the log.
    expect(dump).toContain("DB_PASSWORD");
    expect(dump).toContain("password"); // the field name, not its value
  });

  it("records the env var name from the path on a delete", async () => {
    await call("PUT", "/app/env", { env: { OLD: "1" } });
    await call("DELETE", "/app/env/OLD");
    const line = audit("action = 'api_delete_env'")[0]!;
    expect(line.detail).toContain("key=OLD");
    expect(line.result).toBe("ok");
  });

  it("labels the MCP client, and neutralises a hostile label", async () => {
    await call("PUT", "/app/env", { env: { A: "1" } }, { "x-runway-client": "runway-mcp" });
    expect(audit("action = 'api_put_env'")[0]!.detail).toContain("client=runway-mcp");

    db.exec("DELETE FROM audit_log");
    await call("PUT", "/app/env", { env: { A: "1" } }, { "x-runway-client": "x <b>bold</b> rwy_secretsecret" });
    const detail = audit("action = 'api_put_env'")[0]!.detail as string;
    expect(detail).not.toContain("<");
    expect(detail).not.toContain(" rwy_");
  });

  it("audits the two sensitive reads, and leaves the others out", async () => {
    await call("GET", "/app/env");
    await call("GET", "/app");
    await call("GET", "/app/deploys");
    const actions = audit().map((r) => r.action);
    expect(actions).toEqual(["api_get_env"]);
  });

  it("a handler that throws is audited as an error and still fails for the caller", async () => {
    const probe = new Hono<{ Variables: { app: { id: string } } }>();
    probe.use("*", async (c, next) => {
      c.set("app", { id: "probe1" });
      await next();
    });
    probe.use("*", apiAudit as any);
    probe.post("/api/v1/app/boom", () => {
      throw new Error("nope");
    });
    const res = await probe.request("/api/v1/app/boom", { method: "POST" });
    expect(res.status).toBe(500);
    const line = audit("action = 'api_post_boom'")[0]!;
    expect(line.result).toBe("error");
    expect(line.app_id).toBe("probe1");
  });
});

describe("refused attempts are counted, not listed", () => {
  it("many bad keys from one source are one row", async () => {
    for (let i = 0; i < 30; i++) {
      await app.request("/api/v1/app", { headers: { authorization: `Bearer rwy_guess${i}` } });
    }
    const rows = audit("action = 'api_auth_denied'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(30);
    expect(rows[0]!.detail).toBe("reason=unknown_key");
    expect(JSON.stringify(audit())).not.toContain("rwy_guess");
  });

  it("a missing header is its own reason", async () => {
    await app.request("/api/v1/app");
    await app.request("/api/v1/app", { headers: { authorization: "Bearer rwy_nope" } });
    expect(audit("action = 'api_auth_denied'").map((r) => r.detail).sort()).toEqual([
      "reason=missing_header",
      "reason=unknown_key",
    ]);
  });

  it("the per-IP rate limit shows up as one counted row", async () => {
    for (let i = 0; i < 66; i++) await call("GET", "/app");
    const rows = audit("action = 'api_rate_limited'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(6);
    expect(rows[0]!.result).toBe("denied");
  });

  it("a refused /mcp request is audited as mcp", async () => {
    await app.request("/mcp", { method: "POST" });
    await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer rwd_nothere" } });
    const rows = audit("action = 'mcp_auth_denied'");
    expect(rows.map((r) => r.actor_type)).toEqual(["mcp", "mcp"]);
    expect(rows.map((r) => r.detail).sort()).toEqual([
      "reason=missing_header",
      "reason=unknown_token",
    ]);
    expect(JSON.stringify(rows)).not.toContain("rwd_nothere");
  });
});
