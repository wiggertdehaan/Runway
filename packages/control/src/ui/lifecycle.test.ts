import { describe, expect, it } from "vitest";
import {
  daysLeft,
  lifecycleActions,
  renderAppActions,
  renderDeleteMenuItem,
  renderLifecycleMenuItems,
  renderLifecycleNote,
  renderTrashRow,
  renderStoppedBanner,
} from "./lifecycle.js";

describe("lifecycleActions", () => {
  it("running and failed: restart + stop; stopped: start; everything else none", () => {
    expect(lifecycleActions("running", true)).toEqual(["restart", "stop"]);
    expect(lifecycleActions("failed", true)).toEqual(["restart", "stop"]);
    expect(lifecycleActions("stopped", true)).toEqual(["start"]);
    for (const s of ["building", "scanning", "starting", "quarantined"]) expect(lifecycleActions(s, true)).toEqual([]);
  });
  it("an app without a deployed version has none", () => {
    expect(lifecycleActions("running", false)).toEqual([]);
    expect(lifecycleActions("stopped", false)).toEqual([]);
  });
});

describe("daysLeft", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-11-25T10:00:00Z");
  it("counts down from 7", () => {
    expect(daysLeft(new Date(now).toISOString(), now)).toBe("7 days left");
    expect(daysLeft(new Date(now - 3 * day).toISOString(), now)).toBe("4 days left");
    expect(daysLeft(new Date(now - 6.5 * day).toISOString(), now)).toBe("less than a day left");
    expect(daysLeft(new Date(now - 8 * day).toISOString(), now)).toBe("removed soon");
    expect(daysLeft("garbage", now)).toBe("in the trash");
  });
});

describe("rendering escapes what comes from the app", () => {
  const evil = `<script>alert(1)</script>"'`;
  it("menu, actions, banner, trash row", () => {
    const html = [
      renderDeleteMenuItem("a1", evil),
      renderAppActions("a1", "running", true, evil),
      renderTrashRow({ id: "a1", name: evil, description: null, domain: evil, custom_domain: null, deleted_at: new Date().toISOString() }, { admin: true, expectedName: evil, now: Date.now() }),
      renderStoppedBanner({ status: "stopped", stopped_at: evil }, (s) => s),
    ].join("");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(`"'`);
  });
  it("ids are URL-encoded in the form actions", () => {
    expect(renderLifecycleMenuItems("a/b", "running", true)).toContain("/apps/a%2Fb/stop");
  });
  it("the purge button is only rendered for an admin", () => {
    const row = { id: "a1", name: "A", description: null, domain: null, custom_domain: null, deleted_at: new Date().toISOString() };
    expect(renderTrashRow(row, { admin: false, expectedName: "A", now: Date.now() })).not.toContain("/purge");
    expect(renderTrashRow(row, { admin: true, expectedName: "A", now: Date.now() })).toContain("/apps/a1/purge");
  });
  it("a banner only for a stopped app", () => {
    expect(renderStoppedBanner({ status: "running", stopped_at: null }, (s) => s)).toBe("");
  });
});

describe("notes", () => {
  it("unknown keys render nothing", () => {
    expect(renderLifecycleNote("nope")).toBe("");
    expect(renderLifecycleNote(undefined)).toBe("");
    expect(renderLifecycleNote("busy")).toContain("class=\"error\"");
  });
});
