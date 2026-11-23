/** Token lists (S18): state, labels and, above all, that no secret can appear. */
import { describe, expect, it } from "vitest";
import { renderNewTokenForm, renderTokenTable, scopeLabel, tokenState, type TokenRow } from "./token-lists.js";

const NOW = Date.parse("2026-06-01T12:00:00Z");
const row = (over: Partial<TokenRow> = {}): TokenRow => ({
  id: "t1",
  name: "laptop",
  hint: "Ab3x",
  scope: "deploy",
  expires_at: "2026-09-01 00:00:00",
  last_used_at: null,
  revoked_at: null,
  ...over,
});

describe("tokenState", () => {
  it("is active until the expiry, expired after, and revoked beats both", () => {
    expect(tokenState(row(), NOW)).toBe("active");
    expect(tokenState(row({ expires_at: "2026-05-31 23:59:59" }), NOW)).toBe("expired");
    expect(tokenState(row({ revoked_at: "2026-05-01 00:00:00" }), NOW)).toBe("revoked");
    expect(tokenState(row({ expires_at: "2020-01-01 00:00:00", revoked_at: "2020-01-01 00:00:00" }), NOW)).toBe("revoked");
  });
  it("treats a token without an expiry as active (an old skill token)", () => {
    expect(tokenState(row({ expires_at: null }), NOW)).toBe("active");
  });
});

describe("renderTokenTable", () => {
  const opts = {
    revokeAction: (t: TokenRow) => `/account/access-tokens/${t.id}/delete`,
    empty: "Nothing yet.",
    confirmText: "Sure?",
    now: NOW,
  };
  it("says so when there is nothing", () => {
    expect(renderTokenTable([], opts)).toContain("Nothing yet.");
  });
  it("shows the name, the last four characters, the scope in words and the expiry", () => {
    const html = renderTokenTable([row()], opts);
    expect(html).toContain("laptop");
    expect(html).toContain("…Ab3x");
    expect(html).toContain("Deploy: read, plus change and deploy your apps");
    expect(html).toContain("until 2026-09-01");
    expect(html).toContain("Active");
    expect(html).toContain('action="/account/access-tokens/t1/delete"');
  });
  it("offers no revoke button for a token that is already revoked", () => {
    const html = renderTokenTable([row({ revoked_at: "2026-05-01 00:00:00" })], opts);
    expect(html).toContain("Revoked");
    expect(html).not.toContain("Revoke</button>");
  });
  it("calls out a token with no expiry", () => {
    expect(renderTokenTable([row({ expires_at: null, scope: null })], opts)).toContain("No expiry");
  });
  it("escapes names and owners", () => {
    const html = renderTokenTable([row({ name: '<img src=x onerror=1>', username: "<b>x</b>" })], { ...opts, showOwner: true });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;img");
  });
  it("marks the owner of a deleted account", () => {
    expect(renderTokenTable([row({ username: null })], { ...opts, showOwner: true })).toContain("deleted user");
  });
});

describe("scope labels and the new-token form", () => {
  it("describes a skill token as read-only", () => {
    expect(scopeLabel(null)).toContain("Skills");
    expect(scopeLabel("read")).toContain("Read");
  });
  it("offers the admin scope only to an administrator", () => {
    expect(renderNewTokenForm({ admin: false })).not.toContain('value="admin"');
    expect(renderNewTokenForm({ admin: true })).toContain('value="admin"');
  });
  it("defaults to 90 days and offers at most a year", () => {
    const html = renderNewTokenForm({ admin: false });
    expect(html).toContain('<option value="90" selected>');
    expect(html).toContain('value="365"');
    expect(html).not.toContain('value="730"');
  });
});
