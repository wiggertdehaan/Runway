import { describe, expect, it } from "vitest";
import { parseAuditFilter, renderAuditFilters, renderAuditRows, type AuditRowInput } from "./audit.js";

const person: AuditRowInput = {
  created_at: "2026-11-23 10:00:00",
  username: "alice",
  action: "login",
  target_username: null,
  detail: null,
  actor_type: null,
  app_id: null,
  result: null,
  source_ip: null,
  count: 1,
};

describe("parseAuditFilter", () => {
  it("accepts the four filters and falls back to all", () => {
    expect(parseAuditFilter("api")).toBe("api");
    expect(parseAuditFilter("denied")).toBe("denied");
    expect(parseAuditFilter("people")).toBe("people");
    expect(parseAuditFilter("../x")).toBe("all");
    expect(parseAuditFilter(undefined)).toBe("all");
  });
});

describe("renderAuditFilters", () => {
  it("marks the active filter", () => {
    const html = renderAuditFilters("api");
    expect(html).toContain('href="/audit?type=api" aria-current="page"');
    expect(html).toContain('href="/audit" aria-current="false"');
  });
});

describe("renderAuditRows", () => {
  it("shows a person's line as before", () => {
    const html = renderAuditRows([person]);
    expect(html).toContain("alice");
    expect(html).toContain("<code>login</code>");
    expect(html).not.toContain("tag-");
  });

  it("shows an API line with actor kind, result, app link and source", () => {
    const html = renderAuditRows([
      {
        ...person,
        username: "api-key:abc123",
        action: "api_put_env",
        actor_type: "api-key",
        app_id: "abc123",
        result: "ok",
        source_ip: "203.0.113.7",
        detail: "env{DB_URL} status=200",
      },
    ]);
    expect(html).toContain("API key");
    expect(html).toContain('<span class="tag tag-ok">ok</span>');
    expect(html).toContain('href="/apps/abc123"');
    expect(html).toContain("from 203.0.113.7");
  });

  it("shows a counted refusal", () => {
    const html = renderAuditRows([
      {
        ...person,
        username: "198.51.100.9",
        action: "api_auth_denied",
        actor_type: "api-key",
        result: "denied",
        source_ip: "198.51.100.9",
        count: 37,
        detail: "reason=unknown_key",
      },
    ]);
    expect(html).toContain("tag-err");
    expect(html).toContain("&times;37");
  });

  it("says 'many sources' for the shared flood row", () => {
    const html = renderAuditRows([
      { ...person, actor_type: "api-key", result: "denied", source_ip: "*", count: 400 },
    ]);
    expect(html).toContain("many sources");
  });

  it("escapes everything that comes from outside", () => {
    const html = renderAuditRows([
      {
        ...person,
        username: "<script>alert(1)</script>",
        action: '"><img src=x>',
        detail: "<b>x</b>",
        actor_type: "api-key",
        app_id: '"><svg>',
        result: "ok",
        source_ip: "<i>",
      },
    ]);
    expect(html).not.toMatch(/<script>|<img |<b>|<svg>|<i>/);
  });
});
