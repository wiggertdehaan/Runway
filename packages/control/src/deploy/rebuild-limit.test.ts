import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../db/index.js";
import { RebuildBusyError, activeRebuildRun, startRebuildRun } from "./rebuild.js";

describe("one rebuild run at a time", () => {
  beforeAll(() => migrate());

  it("refuses a second run while the first is busy, whoever asks, and reports what it covers", async () => {
    let finished: unknown[] | null = null;
    const quiet = { log() {}, warn() {}, error() {} } as unknown as Console;
    const id = startRebuildRun({
      trigger: "manual",
      appIds: ["a1"],
      log: quiet,
      onFinished: (r) => void (finished = r),
    });
    expect(activeRebuildRun()).toEqual({ runId: id, appIds: ["a1"] });
    expect(() => startRebuildRun({ trigger: "manual", appIds: ["a2"], log: quiet })).toThrow(RebuildBusyError);
    // the run ends by itself (no trivy here: it records a failure and stops)
    for (let i = 0; i < 100 && activeRebuildRun() !== null; i++) await new Promise((r) => setTimeout(r, 20));
    expect(activeRebuildRun()).toBeNull();
    expect(finished).not.toBeNull();
    // and the slot is free again
    const next = startRebuildRun({ trigger: "manual", appIds: ["a3"], log: quiet });
    expect(next).toBeGreaterThan(id);
    for (let i = 0; i < 100 && activeRebuildRun() !== null; i++) await new Promise((r) => setTimeout(r, 20));
  });
});
