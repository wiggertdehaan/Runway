import { describe, expect, it } from "vitest";
import { describeProfile, describeSource, renderHardening } from "./hardening.js";

const app = { id: "abc123", hardening_profile: null, readonly_rootfs: 0 };

describe("renderHardening", () => {
  it("admin: form posts to the app's endpoint, offers the four choices, nothing pre-selected but the default", () => {
    const html = renderHardening(app, true, {});
    expect(html).toContain('action="/apps/abc123/hardening"');
    expect(html).toContain('<option value="" selected>Server default</option>');
    for (const v of ["standard", "strict", "relaxed"]) expect(html).toContain(`<option value="${v}"`);
    expect(html).not.toMatch(/name="readonly" value="1" checked/);
  });

  it("owner: read-only text, no form", () => {
    const html = renderHardening(app, false, {});
    expect(html).not.toContain("<form");
    expect(html).toContain("Set by an administrator");
    expect(html).toContain("Running profile: <b>standard</b>");
  });

  it("mentions the read-only rootfs only when it is in effect", () => {
    expect(renderHardening({ ...app, readonly_rootfs: 1 }, false, {})).toContain("Root filesystem is read-only");
    expect(renderHardening({ ...app, readonly_rootfs: 0 }, false, {})).not.toContain("Root filesystem is read-only");
    // The brake switches the read-only rule off too.
    expect(renderHardening({ ...app, readonly_rootfs: 1 }, false, { RUNWAY_HARDENING: "relaxed" })).not.toContain(
      "Root filesystem is read-only"
    );
  });

  it("explains that a change reaches a running container at its next deploy", () => {
    expect(renderHardening(app, true, {})).toContain("next time the container is created");
  });

  it("describes every profile and source in words", () => {
    for (const m of ["standard", "strict", "relaxed"] as const) expect(describeProfile(m).length).toBeGreaterThan(20);
    for (const s of ["emergency-brake", "app", "instance", "default"] as const) {
      expect(describeSource(s).length).toBeGreaterThan(3);
    }
  });
});
