import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, migrate } from "./index.js";
import { createApp, getApp, getAppByDomain, isDomainTaken, updateApp } from "./apps.js";
import { ensureUniqueDomainIndexes, findDomainDuplicates, normalizeHost } from "./domain-index.js";

function reset() {
  migrate();
  db.exec("DROP INDEX IF EXISTS idx_apps_domain_unique");
  db.exec("DROP INDEX IF EXISTS idx_apps_custom_domain_unique");
  db.exec("DELETE FROM apps");
  db.exec("DELETE FROM audit_log");
}

describe("normalizeHost", () => {
  it("lowercases, trims and drops trailing dots", () => {
    expect(normalizeHost("  Shop.Example.COM. ")).toBe("shop.example.com");
    expect(normalizeHost("a.b")).toBe("a.b");
  });
});

describe("hostname lookups", () => {
  beforeEach(reset);
  it("matches case-insensitively and ignores a trailing dot", () => {
    const a = createApp("u");
    updateApp(a.id, { domain: "shop.example.com" });
    expect(getAppByDomain("SHOP.example.com.")?.id).toBe(a.id);
    expect(isDomainTaken("Shop.Example.Com", "other")).toBe(true);
    expect(isDomainTaken("shop.example.com", a.id)).toBe(false);
  });
  it("sees a custom domain as taken too", () => {
    const a = createApp("u");
    updateApp(a.id, { custom_domain: "mine.example.org" });
    expect(isDomainTaken("mine.example.org", "other")).toBe(true);
  });
  it("is deterministic when old duplicates exist: the oldest app wins", () => {
    const first = createApp("u");
    updateApp(first.id, { domain: "dup.example.com" });
    db.prepare("UPDATE apps SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(first.id);
    const second = createApp("u");
    updateApp(second.id, { domain: "dup.example.com" });
    expect(getAppByDomain("dup.example.com")?.id).toBe(first.id);
  });
});

describe("ensureUniqueDomainIndexes", () => {
  beforeEach(reset);

  it("creates the indexes on a clean database and then blocks a duplicate", () => {
    const res = ensureUniqueDomainIndexes(db);
    expect(res.created.sort()).toEqual(["custom_domain", "domain"]);
    expect(res.duplicates).toEqual([]);
    const a = createApp("u");
    const b = createApp("u");
    updateApp(a.id, { domain: "x.example.com" });
    expect(() => updateApp(b.id, { domain: "X.example.com" })).toThrow(/UNIQUE/i);
    expect(getApp(b.id)!.domain).toBeNull();
  });

  it("is idempotent", () => {
    ensureUniqueDomainIndexes(db);
    const again = ensureUniqueDomainIndexes(db);
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual([]);
  });

  it("allows many apps without a domain", () => {
    ensureUniqueDomainIndexes(db);
    createApp("u");
    createApp("u");
    expect(() => createApp("u")).not.toThrow();
  });

  it("with existing duplicates: does not crash, keeps both apps, reports and audits once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = createApp("u");
    const b = createApp("u");
    updateApp(a.id, { domain: "same.example.com" });
    updateApp(b.id, { domain: "Same.example.com" });

    const res = ensureUniqueDomainIndexes(db);
    expect(res.skipped).toEqual(["domain"]);
    expect(res.created).toEqual(["custom_domain"]);
    expect(res.duplicates).toHaveLength(1);
    expect(res.duplicates[0].host).toBe("same.example.com");
    expect(res.duplicates[0].appIds.sort()).toEqual([a.id, b.id].sort());
    // nothing was deleted or changed
    expect(getApp(a.id)!.domain).toBe("same.example.com");
    expect(getApp(b.id)!.domain).toBe("Same.example.com");
    expect(warn).toHaveBeenCalled();

    ensureUniqueDomainIndexes(db); // a second start, same finding
    const rows = db
      .prepare("SELECT detail FROM audit_log WHERE action = 'domain_duplicates_detected'")
      .all();
    expect(rows).toHaveLength(1);
    warn.mockRestore();
  });

  it("creates the index by itself once the duplicates are gone", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = createApp("u");
    const b = createApp("u");
    updateApp(a.id, { domain: "same.example.com" });
    updateApp(b.id, { domain: "same.example.com" });
    expect(ensureUniqueDomainIndexes(db).skipped).toEqual(["domain"]);
    updateApp(b.id, { domain: "other.example.com" });
    const res = ensureUniqueDomainIndexes(db);
    expect(res.created).toEqual(["domain"]);
    expect(res.duplicates).toEqual([]);
  });

  it("migrate() on a database with duplicates does not throw", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = createApp("u");
    const b = createApp("u");
    updateApp(a.id, { domain: "d.example.com" });
    updateApp(b.id, { domain: "d.example.com" });
    expect(() => migrate()).not.toThrow();
  });
});

describe("findDomainDuplicates", () => {
  beforeEach(reset);
  it("finds a generated domain that equals another app's custom domain", () => {
    const a = createApp("u");
    const b = createApp("u");
    updateApp(a.id, { domain: "x.example.com" });
    updateApp(b.id, { custom_domain: "X.example.com" });
    const dups = findDomainDuplicates(db);
    expect(dups).toHaveLength(1);
    expect(dups[0].host).toBe("x.example.com");
  });
  it("does not flag one app that uses the same name in both columns", () => {
    const a = createApp("u");
    updateApp(a.id, { domain: "x.example.com", custom_domain: "x.example.com" });
    expect(findDomainDuplicates(db)).toEqual([]);
  });
});
