import { describe, expect, it } from "vitest";
import {
  decideOAuthLogin,
  emailDomain,
  matchesAccess,
  parseAccessEntry,
  safeReturnTo,
} from "./oauth-access.js";
import { decodeIdToken, isEmailVerified } from "./oauth.js";

describe("parseAccessEntry", () => {
  it("reads an address, a domain with and without @, and lowercases", () => {
    expect(parseAccessEntry(" Ann@Example.COM ")).toEqual({ kind: "email", value: "ann@example.com" });
    expect(parseAccessEntry("@Example.com")).toEqual({ kind: "domain", value: "example.com" });
    expect(parseAccessEntry("example.com.")).toEqual({ kind: "domain", value: "example.com" });
  });
  it("rejects junk, lists and script-ish input", () => {
    for (const bad of ["", "   ", "ann", "ann@", "a@b", "a b@c.com", "a@b.com,c@d.com", "<x>@y.com", "localhost", "exa mple.com", "@"]) {
      expect(parseAccessEntry(bad), bad).toBeNull();
    }
  });
});

describe("matchesAccess", () => {
  const entries = [
    { kind: "email" as const, value: "ann@example.com" },
    { kind: "domain" as const, value: "corp.example" },
  ];
  it("matches the exact address and the whole domain only", () => {
    expect(matchesAccess(entries, "ANN@example.com")).toBe(true);
    expect(matchesAccess(entries, "bob@corp.example")).toBe(true);
    expect(matchesAccess(entries, "bob@example.com")).toBe(false);
    expect(matchesAccess(entries, "bob@evilcorp.example")).toBe(false);
    expect(matchesAccess(entries, "bob@sub.corp.example")).toBe(false);
  });
  it("emailDomain takes what follows the last @", () => {
    expect(emailDomain("a@b.com")).toBe("b.com");
    expect(emailDomain("nope")).toBe("");
  });
});

describe("isEmailVerified", () => {
  const jwt = (p: object) => `x.${Buffer.from(JSON.stringify(p)).toString("base64url")}.y`;
  it("Google needs email_verified", () => {
    expect(isEmailVerified("google", decodeIdToken(jwt({ sub: "1", email: "a@b.com", email_verified: true })))).toBe(true);
    expect(isEmailVerified("google", decodeIdToken(jwt({ sub: "1", email: "a@b.com", email_verified: "true" })))).toBe(true);
    expect(isEmailVerified("google", decodeIdToken(jwt({ sub: "1", email: "a@b.com", email_verified: false })))).toBe(false);
    expect(isEmailVerified("google", decodeIdToken(jwt({ sub: "1", email: "a@b.com" })))).toBe(false);
  });
  it("Microsoft fails closed unless xms_edov is set; email_verified is not trusted there", () => {
    expect(isEmailVerified("microsoft", decodeIdToken(jwt({ sub: "1", email: "a@b.com" })))).toBe(false);
    expect(isEmailVerified("microsoft", decodeIdToken(jwt({ sub: "1", email: "a@b.com", email_verified: true })))).toBe(false);
    expect(isEmailVerified("microsoft", decodeIdToken(jwt({ sub: "1", email: "a@b.com", xms_edov: true })))).toBe(true);
    expect(isEmailVerified("microsoft", decodeIdToken(jwt({ sub: "1", xms_edov: true })))).toBe(false);
  });
});

describe("decideOAuthLogin", () => {
  const base = { provider: "google", sub: "s1", emailVerified: true, existing: null, allowed: false };
  it("never lets an unverified address in, whatever else is true", () => {
    expect(decideOAuthLogin({ ...base, emailVerified: false, allowed: true })).toEqual({ action: "deny", reason: "unverified_email" });
    expect(decideOAuthLogin({ ...base, emailVerified: false, existing: { oauth_provider: null, oauth_sub: null } })).toEqual({ action: "deny", reason: "unverified_email" });
    expect(decideOAuthLogin({ ...base, sub: "" })).toMatchObject({ action: "deny" });
  });
  it("refuses a stranger unless the address is allowed", () => {
    expect(decideOAuthLogin(base)).toEqual({ action: "deny", reason: "not_invited" });
    expect(decideOAuthLogin({ ...base, allowed: true })).toEqual({ action: "provision" });
  });
  it("signs an existing account in and pins the identity on first use", () => {
    expect(decideOAuthLogin({ ...base, existing: { oauth_provider: null, oauth_sub: null } })).toEqual({ action: "login", bindIdentity: true });
    expect(decideOAuthLogin({ ...base, existing: { oauth_provider: "google", oauth_sub: "s1" } })).toEqual({ action: "login", bindIdentity: false });
  });
  it("refuses a different identity claiming a pinned account's address", () => {
    expect(decideOAuthLogin({ ...base, existing: { oauth_provider: "google", oauth_sub: "other" } })).toEqual({ action: "deny", reason: "identity_mismatch" });
    expect(decideOAuthLogin({ ...base, existing: { oauth_provider: "microsoft", oauth_sub: "s1" } })).toEqual({ action: "deny", reason: "identity_mismatch" });
  });
});

describe("safeReturnTo", () => {
  const ours = (h: string) => h === "dash.example.com" || h.endsWith(".apps.example.com");
  it("keeps relative paths", () => {
    expect(safeReturnTo("/", ours)).toBe("/");
    expect(safeReturnTo("/apps/x?saved=1#scan", ours)).toBe("/apps/x?saved=1#scan");
  });
  it("keeps absolute URLs only on our hosts", () => {
    expect(safeReturnTo("https://dash.example.com/apps", ours)).toBe("https://dash.example.com/apps");
    expect(safeReturnTo("https://shop.apps.example.com/x", ours)).toBe("https://shop.apps.example.com/x");
  });
  it("falls back to / for anything that could leave the site", () => {
    for (const bad of [
      "//evil.com", "///evil.com", "/\\evil.com", "\\\\evil.com", "https://evil.com/",
      "https://dash.example.com.evil.com/", "https://evil.com/dash.example.com",
      "https://dash.example.com@evil.com/", "https://user:pw@dash.example.com/",
      "javascript:alert(1)", "data:text/html,x", "ftp://dash.example.com/", "evil.com",
      "/ok\r\nSet-Cookie: a=b", "/ok\tx", "", undefined, null,
    ]) {
      expect(safeReturnTo(bad as string, ours), String(bad)).toBe("/");
    }
  });
  it("refuses absurdly long values", () => {
    expect(safeReturnTo("/" + "a".repeat(3000), ours)).toBe("/");
  });
});
