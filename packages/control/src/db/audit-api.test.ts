/**
 * S12: the audit table's new columns, the counted "refused" rows and the
 * bounded retention of API lines. In-memory database.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, migrate } from "./index.js";
import {
  DENIED_MAX_ROWS_PER_WINDOW,
  getRecentAuditEntries,
  logApiAudit,
  logAudit,
  logDeniedAudit,
  pruneApiAudit,
} from "./audit.js";

beforeAll(() => migrate());
beforeEach(() => db.exec("DELETE FROM audit_log"));

function rows(where = "1=1") {
  return db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`).all() as Array<
    Record<string, any>
  >;
}

describe("migration", () => {
  it("adds the columns to an audit table that predates them, and keeps its rows", () => {
    db.exec("DROP INDEX IF EXISTS idx_audit_actor");
    db.exec("DROP INDEX IF EXISTS idx_audit_denied");
    db.exec("DROP INDEX IF EXISTS idx_audit_app");
    for (const col of ["actor_type", "app_id", "result", "source_ip", "count"]) {
      db.exec(`ALTER TABLE audit_log DROP COLUMN ${col}`);
    }
    db.exec(
      `INSERT INTO audit_log (user_id, username, action, detail) VALUES ('u1', 'alice', 'login', 'old row')`
    );

    migrate();
    migrate(); // idempotent

    const cols = (db.prepare("PRAGMA table_info(audit_log)").all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    for (const c of ["actor_type", "app_id", "result", "source_ip", "count"]) {
      expect(cols).toContain(c);
    }
    const old = rows()[0]!;
    expect(old.detail).toBe("old row");
    expect(old.actor_type).toBeNull(); // a person, not an API key
    expect(old.count).toBe(1);
  });
});

describe("logApiAudit", () => {
  it("records the actor, app, result and source", () => {
    logApiAudit({
      actorType: "api-key",
      appId: "abc123",
      action: "api_put_env",
      result: "ok",
      ip: "203.0.113.7",
      detail: "env{DB_URL} status=200",
    });
    const r = rows()[0]!;
    expect(r.user_id).toBe("api-key:abc123");
    expect(r.actor_type).toBe("api-key");
    expect(r.app_id).toBe("abc123");
    expect(r.result).toBe("ok");
    expect(r.source_ip).toBe("203.0.113.7");
    expect(r.detail).toBe("env{DB_URL} status=200");
  });

  it("masks a token-shaped value even if a caller passes one in the detail", () => {
    logApiAudit({
      actorType: "api-key",
      appId: "abc123",
      action: "x",
      result: "ok",
      ip: "1.1.1.1",
      detail: "oops rwy_abcdefghijklmnopqrstuv",
    });
    expect(rows()[0]!.detail).not.toContain("rwy_abcdef");
  });
});

describe("logDeniedAudit", () => {
  const base = { actorType: "api-key" as const, action: "api_auth_denied", reason: "unknown_key" };

  it("folds repeats from one source into one counted row", () => {
    for (let i = 0; i < 50; i++) logDeniedAudit({ ...base, ip: "198.51.100.9" });
    const r = rows("action = 'api_auth_denied'");
    expect(r).toHaveLength(1);
    expect(r[0]!.count).toBe(50);
    expect(r[0]!.result).toBe("denied");
    expect(r[0]!.source_ip).toBe("198.51.100.9");
    expect(r[0]!.detail).toBe("reason=unknown_key");
  });

  it("keeps different sources and different reasons apart", () => {
    logDeniedAudit({ ...base, ip: "198.51.100.1" });
    logDeniedAudit({ ...base, ip: "198.51.100.2" });
    logDeniedAudit({ ...base, ip: "198.51.100.1", reason: "missing_header" });
    expect(rows("action = 'api_auth_denied'")).toHaveLength(3);
  });

  it("opens a new row once the window has passed", () => {
    logDeniedAudit({ ...base, ip: "198.51.100.3" });
    db.exec(`UPDATE audit_log SET created_at = datetime('now', '-11 minutes')`);
    logDeniedAudit({ ...base, ip: "198.51.100.3" });
    expect(rows("action = 'api_auth_denied'")).toHaveLength(2);
  });

  it("collapses a flood from many sources into one shared row", () => {
    const n = DENIED_MAX_ROWS_PER_WINDOW + 40;
    for (let i = 0; i < n; i++) logDeniedAudit({ ...base, ip: `10.9.${Math.floor(i / 250)}.${i % 250}` });
    const all = rows("action = 'api_auth_denied'");
    expect(all.length).toBe(DENIED_MAX_ROWS_PER_WINDOW + 1);
    const shared = all.find((r) => r.source_ip === "*")!;
    expect(shared.count).toBe(40);
  });

  it("never stores anything that identifies the presented key", () => {
    logDeniedAudit({ ...base, ip: "198.51.100.4" });
    expect(JSON.stringify(rows())).not.toMatch(/rwy_/);
  });
});

describe("pruneApiAudit", () => {
  it("drops old API lines, keeps recent ones and never touches people's lines", () => {
    logAudit("u1", "alice", "user_created");
    logApiAudit({ actorType: "api-key", appId: "a", action: "old", result: "ok", ip: "1.1.1.1" });
    logApiAudit({ actorType: "api-key", appId: "a", action: "new", result: "ok", ip: "1.1.1.1" });
    db.exec(`UPDATE audit_log SET created_at = datetime('now', '-200 days') WHERE action IN ('old', 'user_created')`);

    const removed = pruneApiAudit(90, 1000);
    expect(removed).toBe(1);
    const left = rows().map((r) => r.action);
    expect(left).toContain("user_created"); // a person's line, however old
    expect(left).toContain("new");
    expect(left).not.toContain("old");
  });

  it("keeps at most maxRows API lines, newest first", () => {
    for (let i = 0; i < 10; i++) {
      logApiAudit({ actorType: "api-key", appId: "a", action: `n${i}`, result: "ok", ip: "1.1.1.1" });
    }
    logAudit("u1", "alice", "person");
    pruneApiAudit(90, 4);
    const api = rows("actor_type IS NOT NULL").map((r) => r.action);
    expect(api).toEqual(["n6", "n7", "n8", "n9"]);
    expect(rows("actor_type IS NULL")).toHaveLength(1);
  });
});

describe("getRecentAuditEntries filters", () => {
  it("separates people, API/MCP and refused lines", () => {
    logAudit("u1", "alice", "login");
    logApiAudit({ actorType: "api-key", appId: "a", action: "api_put_env", result: "ok", ip: "1.1.1.1" });
    logDeniedAudit({ actorType: "mcp", action: "mcp_auth_denied", ip: "2.2.2.2", reason: "unknown_token" });
    expect(getRecentAuditEntries(50, "all")).toHaveLength(3);
    expect(getRecentAuditEntries(50, "people").map((e) => e.action)).toEqual(["login"]);
    expect(getRecentAuditEntries(50, "api").map((e) => e.action).sort()).toEqual([
      "api_put_env",
      "mcp_auth_denied",
    ]);
    expect(getRecentAuditEntries(50, "denied").map((e) => e.action)).toEqual(["mcp_auth_denied"]);
  });
});
