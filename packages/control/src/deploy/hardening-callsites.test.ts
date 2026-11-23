/**
 * Every place that starts an app container must pass the app's hardening
 * profile and read-only flag. A new call site that forgets them would
 * silently start that app with the instance default, ignoring what the
 * administrator set. Source-level guard, like the other "keep this wired"
 * tests in this package.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("runContainer call sites in deploy/index.ts", () => {
  const calls = src.split("runContainer({").slice(1);

  it("there are call sites to check", () => {
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("each one passes the hardening profile and the read-only flag", () => {
    for (const [i, rest] of calls.entries()) {
      const body = rest.slice(0, rest.indexOf("});"));
      expect(body, `call site ${i + 1}`).toContain("hardening: app.hardening_profile");
      expect(body, `call site ${i + 1}`).toContain("readonlyRootfs: app.readonly_rootfs === 1");
    }
  });

  it("each one passes the memory limit, so the no-swap rule can apply", () => {
    for (const [i, rest] of calls.entries()) {
      expect(rest.slice(0, rest.indexOf("});")), `call site ${i + 1}`).toContain("memoryLimit: app.memory_limit");
    }
  });
});
