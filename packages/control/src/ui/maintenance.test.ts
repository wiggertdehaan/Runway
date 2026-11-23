import { describe, expect, it } from "vitest";
import { maintenanceSummary, maintenanceSwitches, renderMaintenance, type MaintenanceApp } from "./maintenance.js";

const app = (over: Partial<MaintenanceApp> = {}): MaintenanceApp => ({
  id: "abc123",
  auto_rebuild: 1,
  auto_patch_base: 1,
  auto_minor_base: 1,
  auto_update_deps: 1,
  auto_update_deps_major: 0,
  ...over,
});

describe("maintenanceSwitches", () => {
  it("lists the five switches in a fixed order with their state", () => {
    const s = maintenanceSwitches(app());
    expect(s.map((x) => x.action)).toEqual(["auto-rebuild", "auto-patch", "auto-minor", "auto-deps", "auto-deps-major"]);
    expect(s.map((x) => x.on)).toEqual([true, true, true, true, false]);
    expect(maintenanceSummary(s)).toBe("4 of 5 on");
  });

  it("blocks turning major updates on while dependency updates are off", () => {
    const s = maintenanceSwitches(app({ auto_update_deps: 0 }));
    expect(s[4]!.blocked).toMatch(/Update vulnerable dependencies/);
  });

  it("never blocks turning major updates OFF, even when dependency updates are off", () => {
    const s = maintenanceSwitches(app({ auto_update_deps: 0, auto_update_deps_major: 1 }));
    expect(s[4]!.blocked).toBeNull();
    expect(s[4]!.on).toBe(true);
  });
});

describe("renderMaintenance", () => {
  it("renders real switches for admins that post the state after the click", () => {
    const html = renderMaintenance(app({ auto_update_deps_major: 0 }), true);
    expect(html).toContain('role="switch"');
    expect(html).toContain('action="/apps/abc123/auto-deps-major"');
    // major is off -> the form posts enabled=1; weekly rebuild is on -> enabled=0
    expect(html).toMatch(/auto-deps-major"[^]*?name="enabled" value="1"/);
    expect(html).toMatch(/auto-rebuild"[^]*?name="enabled" value="0"/);
    expect(html).toContain("data-autosubmit");
    expect(html).toContain("<noscript>");
    expect(html).toContain("Admin setting");
  });

  it("is read-only for everyone else: no forms, switches disabled", () => {
    const html = renderMaintenance(app(), false);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("data-autosubmit");
    expect((html.match(/role="switch"/g) ?? []).length).toBe(5);
    expect((html.match(/role="switch"[^>]*disabled/g) ?? []).length).toBe(5);
    expect(html).toContain("Ask an administrator");
  });

  it("gives every switch a label and a described-by help text", () => {
    const html = renderMaintenance(app(), true);
    for (const a of ["auto-rebuild", "auto-patch", "auto-minor", "auto-deps", "auto-deps-major"]) {
      expect(html).toContain(`for="sw-${a}"`);
      expect(html).toContain(`id="sw-${a}-h"`);
    }
  });

  it("escapes the app id in the form action", () => {
    const html = renderMaintenance(app({ id: 'a"b' }), true);
    expect(html).not.toContain('a"b/');
    expect(html).toContain("a%22b");
  });
});
