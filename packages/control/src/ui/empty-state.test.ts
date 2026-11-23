import { describe, expect, it } from "vitest";
import { mcpInstallCommand, mcpUrl, renderEmptyState } from "./empty-state.js";

describe("mcp install command", () => {
  it("matches the documented command shape, with a token placeholder", () => {
    expect(mcpInstallCommand("runway.example.com")).toBe(
      'claude mcp add runway-skills --transport http https://runway.example.com/mcp --header "Authorization: Bearer rwd_..."'
    );
  });
  it("uses a visible placeholder when the dashboard domain is unknown", () => {
    expect(mcpUrl("")).toContain("YOUR-RUNWAY-DOMAIN");
  });
});

describe("renderEmptyState", () => {
  const base = { dashboardDomain: "runway.example.com" };
  it("gives three steps and a create button", () => {
    const html = renderEmptyState(base);
    expect(html).toContain("Deploy your first app");
    expect(html).toContain('action="/apps"');
    expect((html.match(/<span class="n">/g) ?? []).length).toBe(3);
    expect(html).toContain("Copy deploy instruction");
  });
  it("never contains a real-looking token", () => {
    expect(renderEmptyState(base)).not.toMatch(/rwd_[A-Za-z0-9_-]{8,}/);
  });
  it("copies the command it displays", () => {
    const html = renderEmptyState(base);
    const cmd = mcpInstallCommand("runway.example.com").replace(/"/g, "&quot;");
    expect(html).toContain(`data-copy="${cmd}"`);
  });
  it("escapes the dashboard domain", () => {
    const html = renderEmptyState({ ...base, dashboardDomain: 'x"><script>1</script>' });
    expect(html).not.toContain("<script>1</script>");
  });
});
