import { describe, expect, it } from "vitest";
import { appsLabel, canChangeRole, peopleError, peopleSummary, renderPersonCard, roleTag, twoFaTag, type PersonRow } from "./people.js";

const row = (o: Partial<PersonRow> = {}): PersonRow => ({
  id: "u1",
  username: "sanne",
  role: "member",
  totpEnabled: true,
  createdAt: "2026-11-01 10:00:00",
  appNames: [],
  ...o,
});
const ctx = { currentUserId: "me", adminCount: 2 };

describe("tags", () => {
  it("never shows a normal role in an error colour", () => {
    for (const r of ["admin", "member"] as const) {
      const html = roleTag(r);
      expect(html).not.toMatch(/tag-err|badge-stopped|badge-failed/);
      expect(html).not.toMatch(/tag-warn/);
    }
  });
  it("shows 2FA off as amber, not red", () => {
    expect(twoFaTag(false)).toContain("tag-warn");
    expect(twoFaTag(false)).not.toMatch(/err|stopped/);
    expect(twoFaTag(true)).toContain("tag-ok");
  });
});

describe("appsLabel", () => {
  it("says what each role manages", () => {
    expect(appsLabel("admin", ["a"])).toBe("Manages all apps");
    expect(appsLabel("member", [])).toBe("No apps yet");
    expect(appsLabel("member", ["a", "b"])).toBe("a, b");
    expect(appsLabel("member", ["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });
});

describe("canChangeRole", () => {
  it("refuses yourself and the last admin", () => {
    expect(canChangeRole(row({ id: "me" }), ctx)).toBe(false);
    expect(canChangeRole(row({ id: "x", role: "admin" }), { ...ctx, adminCount: 1 })).toBe(false);
    expect(canChangeRole(row({ id: "x", role: "admin" }), ctx)).toBe(true);
    expect(canChangeRole(row({ id: "x" }), { ...ctx, adminCount: 1 })).toBe(true);
  });
});

describe("renderPersonCard", () => {
  it("labels the 2FA reset code as the admin's own code", () => {
    const html = renderPersonCard(row(), ctx);
    expect(html).toContain("confirm with your own code");
    expect(html).toContain('autocomplete="one-time-code"');
    expect(html).toMatch(/<label[^>]*for="code-u1"/);
  });
  it("offers no reset when the person has no 2FA, and nothing for yourself", () => {
    expect(renderPersonCard(row({ totpEnabled: false }), ctx)).not.toContain("/2fa/reset");
    const me = renderPersonCard(row({ id: "me" }), ctx);
    expect(me).toContain("This is you");
    expect(me).not.toContain("/delete");
    expect(me).not.toContain("/role");
  });
  it("escapes usernames and app names everywhere", () => {
    const html = renderPersonCard(row({ username: "<img src=x onerror=1>", appNames: ["<b>x</b>"] }), ctx);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;img");
  });
  it("keeps a quote in a username from breaking the confirm() string", () => {
    const html = renderPersonCard(row({ username: "o'brien" }), ctx);
    expect(html).toContain("o&#39;brien");
    expect(html).not.toContain("o'brien");
  });
});

describe("summary and errors", () => {
  it("pluralises", () => {
    expect(peopleSummary([{ role: "admin" }])).toMatch(/^1 person\./);
    expect(peopleSummary([{ role: "admin" }, { role: "member" }])).toMatch(/^2 people\./);
  });
  it("maps the existing redirect codes, and says nothing without one", () => {
    expect(peopleError(undefined)).toBe("");
    expect(peopleError("last_admin")).toContain("zero admins");
    expect(peopleError("needs_2fa")).toContain("your own account");
    expect(peopleError("anything-else")).toContain("did not work");
  });
});
