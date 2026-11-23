import { describe, expect, it } from "vitest";
import type { RebuildAppResult, RebuildRun, SeverityCounts } from "../db/rebuild-runs.js";
import {
  changeSentences,
  durationText,
  outcomeView,
  parseUtc,
  reasonFor,
  redact,
  renderEarlierRun,
  renderRunResult,
  runHeading,
  runTiles,
  scanLine,
  shortText,
  tallyText,
} from "./rebuild-result.js";

const counts = (critical: number, high: number): SeverityCounts => ({ critical, high, medium: 0, low: 0, unknown: 0 });
const snap = (critical: number, high: number, kev = 0) => ({ counts: counts(critical, high), kev });

const res = (over: Partial<RebuildAppResult> = {}): RebuildAppResult => ({
  app_id: "a1",
  app_name: "klantportaal",
  outcome: "rebuilt",
  before: snap(0, 2),
  after: snap(0, 0),
  ...over,
});

const run = (results: RebuildAppResult[], over: Partial<RebuildRun> = {}): RebuildRun => ({
  id: 15,
  trigger: "scheduled",
  status: "done",
  started_at: "2026-11-22 04:00:00",
  finished_at: "2026-11-22 04:09:41",
  results,
  ...over,
});

describe("outcomeView", () => {
  it("names every stored outcome in plain words", () => {
    expect(outcomeView("rebuilt")).toEqual({ label: "Rebuilt", tone: "ok" });
    expect(outcomeView("rolled_back").label).toBe("Rolled back");
    expect(outcomeView("blocked").label).toBe("Not deployed");
    expect(outcomeView("failed").tone).toBe("err");
    expect(outcomeView("skipped").tone).toBe("neutral");
  });
  it("does not crash on an outcome it does not know", () => {
    expect(outcomeView("brand_new").label).toBe("brand new");
  });
});

describe("redact", () => {
  it("removes credentials, tokens and paths", () => {
    expect(redact("https://user:hunter2@registry.example/v2/")).not.toContain("hunter2");
    expect(redact("Authorization: Bearer abcdef1234567890")).not.toContain("abcdef1234567890");
    expect(redact("npm_token=abc123def456 failed")).not.toContain("abc123def456");
    expect(redact("API_KEY: s3cretvalue")).not.toContain("s3cretvalue");
    expect(redact("ghp_abcdefghijklmnopqrstuvwx")).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
    expect(redact("AKIAABCDEFGHIJKLMNOP")).toBe("[redacted]");
    expect(redact("failed in /data/builds/x/Dockerfile line 3")).toBe("failed in [path] line 3");
  });
  it("leaves ordinary sentences alone", () => {
    expect(redact("The new version was worse.")).toBe("The new version was worse.");
  });
});

describe("shortText", () => {
  it("keeps the first line only and caps its length", () => {
    expect(shortText("first\nsecond secret=abc")).toBe("first");
    const long = shortText("x".repeat(500), 50);
    expect(long.length).toBe(50);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("reasonFor", () => {
  it("says nothing for a rebuild that went live", () => {
    expect(reasonFor({ outcome: "rebuilt", detail: "selected: kev" })).toBeNull();
  });
  it("explains a rollback in one fixed sentence", () => {
    expect(reasonFor({ outcome: "rolled_back", detail: "container exited with code 1: stack trace ..." })).toBe(
      "The new version failed its health check, so the previous version was put back."
    );
  });
  it("never shows raw build output for a failure", () => {
    const raw = "failed to solve: process \"/bin/sh -c npm ci\" did not complete successfully: exit code: 1\nnpm ERR! /data/x token=abc123def456";
    const out = reasonFor({ outcome: "failed", detail: raw }) as string;
    expect(out).toBe("A build step failed. Details are in the control log.");
    expect(out).not.toContain("npm ci");
    expect(out).not.toContain("abc123def456");
  });
  it("classifies a health failure and a timeout", () => {
    expect(reasonFor({ outcome: "failed", detail: "health check did not pass" })).toMatch(/health check/);
    expect(reasonFor({ outcome: "failed", detail: "request timed out" })).toMatch(/timed out/);
  });
  it("falls back to a generic sentence for an unknown failure", () => {
    const out = reasonFor({ outcome: "failed", detail: "ECONNRESET at 10.0.0.5:2375" }) as string;
    expect(out).toBe("The rebuild failed. Details are in the control log.");
  });
  it("handles a crashed run", () => {
    expect(reasonFor({ outcome: "failed", detail: "run crashed: Error: boom at /app/x.js" })).toMatch(/stopped unexpectedly/);
  });
  it("translates the known skip reasons", () => {
    expect(reasonFor({ outcome: "skipped", detail: "never deployed" })).toMatch(/Never deployed/);
    expect(reasonFor({ outcome: "skipped", detail: "a deploy is in progress (building)" })).toMatch(/deploy was in progress/);
    expect(reasonFor({ outcome: "skipped", detail: "no stored source to rebuild from" })).toMatch(/no stored source/);
    expect(reasonFor({ outcome: "skipped", detail: "trivy not available; refusing to rebuild without the scan gate" })).toMatch(/scanner/);
  });
  it("passes an unknown skip reason through redacted and short", () => {
    expect(reasonFor({ outcome: "skipped", detail: "held, password=hunter2" })).not.toContain("hunter2");
    expect(reasonFor({ outcome: "skipped", detail: undefined })).toBe("Nothing to do.");
  });
  it("redacts the gate message of a blocked rebuild", () => {
    const out = reasonFor({ outcome: "blocked", detail: "new critical CVE-2026-1 in /data/img token=zzzzzzzz1" }) as string;
    expect(out).toContain("not deployed");
    expect(out).toContain(" New critical CVE-2026-1");
    expect(out.endsWith(".")).toBe(true);
    expect(out).not.toContain("zzzzzzzz1");
    expect(out).not.toContain("/data/img");
  });
});

describe("runTiles", () => {
  it("groups rolled back and not deployed as old version kept", () => {
    const t = runTiles([
      res(),
      res({ outcome: "rolled_back" }),
      res({ outcome: "blocked" }),
      res({ outcome: "failed" }),
      res({ outcome: "skipped" }),
      res({ outcome: "skipped" }),
    ]);
    expect(Object.fromEntries(t.map((x) => [x.key, x.n]))).toEqual({ rebuilt: 1, held: 2, failed: 1, skipped: 2 });
  });
  it("is all zeros for an empty run", () => {
    expect(runTiles([]).every((t) => t.n === 0)).toBe(true);
  });
});

describe("scanLine", () => {
  it("shows critical and high before and after", () => {
    expect(scanLine({ before: snap(0, 2), after: snap(0, 0) })).toEqual({ text: "0C 2H → 0C 0H", kev: null, trend: "better" });
  });
  it("adds KEV only when there is any, and ranks it above everything else", () => {
    const s = scanLine({ before: snap(0, 0, 1), after: snap(5, 5, 0) });
    expect(s.kev).toBe("KEV 1 → 0");
    expect(s.trend).toBe("better");
  });
  it("detects worse and same", () => {
    expect(scanLine({ before: snap(0, 0), after: snap(1, 0) }).trend).toBe("worse");
    expect(scanLine({ before: snap(0, 3), after: snap(0, 3) }).trend).toBe("same");
  });
  it("copes with a missing before or after", () => {
    expect(scanLine({ before: null, after: null })).toEqual({ text: "n/a", kev: null, trend: "unknown" });
    expect(scanLine({ before: snap(1, 0), after: null }).text).toBe("1C 0H → n/a");
    expect(scanLine({ before: null, after: snap(0, 1) }).trend).toBe("unknown");
  });
});

describe("changeSentences", () => {
  it("lists updated dependencies and base image bumps", () => {
    const s = changeSentences(
      res({
        patched: [{ from: "node:22.11.0", to: "node:22.11.3" }],
        deps: [{ ecosystem: "node", pkg: "tar", from: "6.1.15", to: "6.2.1", kind: "compatible", outcome: "applied" }],
      })
    );
    expect(s).toEqual(["Base image node:22.11.0 to node:22.11.3.", "Updated tar 6.1.15 to 6.2.1."]);
  });
  it("says a rebuild with no changes had nothing to update", () => {
    expect(changeSentences(res())).toEqual(["Rebuilt from source on fresh base layers. Nothing needed updating."]);
  });
  it("reports a withheld major as not applied", () => {
    const s = changeSentences(
      res({
        deps: [{ ecosystem: "python", pkg: "flask", from: "2.3", to: "3.0", kind: "major", outcome: "skipped", detail: "major available" }],
      })
    );
    expect(s.join(" ")).toMatch(/Major update flask 2\.3 to 3\.0 available\. Not applied/);
  });
  it("reports a raised dependency whose finding remains, and a failed one", () => {
    const s = changeSentences(
      res({
        deps: [
          { ecosystem: "node", pkg: "a", from: "1.0.0", to: "1.0.1", kind: "compatible", outcome: "ineffective" },
          { ecosystem: "node", pkg: "b", from: "2.0.0", to: "2.1.0", kind: "compatible", outcome: "unhealthy" },
        ],
      })
    );
    expect(s[0]).toMatch(/finding is still there/);
    expect(s[1]).toMatch(/unhealthy\. The old version was kept/);
  });
  it("reports minor escalation and a major base image notice", () => {
    const s = changeSentences(
      res({
        escalation: [
          { kind: "minor", from: "1.29.3", to: "1.30.2", outcome: "applied", detail: "ok" },
          { kind: "major", from: "1.30", to: "2.0", outcome: "notice", detail: "major" },
        ],
      })
    );
    expect(s[0]).toMatch(/minor line 1\.29 to 1\.30/);
    expect(s[1]).toMatch(/major base image update is available/);
  });
  it("does not claim base-image bumps for a rebuild that did not go live", () => {
    expect(changeSentences(res({ outcome: "failed", patched: [{ from: "a:1.0.0", to: "a:1.0.1" }] }))).toEqual([]);
  });
});

describe("time helpers", () => {
  it("reads SQLite datetimes as UTC", () => {
    expect(parseUtc("2026-11-22 04:00:00")).toBe(Date.parse("2026-11-22T04:00:00Z"));
    expect(parseUtc("2026-11-22T04:00:00Z")).toBe(Date.parse("2026-11-22T04:00:00Z"));
    expect(parseUtc(null)).toBeNull();
    expect(parseUtc("garbage")).toBeNull();
  });
  it("formats a duration, and is null while running", () => {
    expect(durationText({ started_at: "2026-11-22 04:00:00", finished_at: "2026-11-22 04:09:41" })).toBe("9m 41s");
    expect(durationText({ started_at: "2026-11-22 04:00:00", finished_at: "2026-11-22 04:00:42" })).toBe("42s");
    expect(durationText({ started_at: "2026-11-22 04:00:00", finished_at: null })).toBeNull();
  });
  it("tallies an earlier run in words", () => {
    expect(tallyText([res(), res(), res({ outcome: "failed" })])).toBe("2 rebuilt, 1 failed");
    expect(tallyText([])).toBe("nothing to rebuild");
  });
});

describe("rendering", () => {
  const o = { relative: () => "17h ago" };

  it("renders tiles and one row per app with its words and scan line", () => {
    const html = renderRunResult(
      run([
        res({ patched: [{ from: "node:22.11.0", to: "node:22.11.3" }] }),
        res({ app_id: "a2", app_name: "ledenlijst", outcome: "failed", before: snap(0, 1), after: null, detail: "npm ci exit code 1" }),
      ]),
      o
    );
    expect(html).toContain('data-tile="rebuilt"');
    expect(html).toContain("klantportaal");
    expect(html).toContain("0C 2H → 0C 0H");
    expect(html).toContain('data-outcome="failed"');
    expect(html).toContain("A build step failed.");
    expect(html).not.toContain("npm ci");
    expect(html).toContain("sec-row-err");
  });

  it("escapes app names and free text", () => {
    const html = renderRunResult(
      run([res({ app_name: '<img src=x onerror=alert(1)>', outcome: "skipped", detail: "<script>alert(2)</script>" })]),
      o
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
  });

  it("links to the app by an encoded id", () => {
    const html = renderRunResult(run([res({ app_id: "a/b?c" })]), o);
    expect(html).toContain('href="/apps/a%2Fb%3Fc"');
  });

  it("has a calm message for a run with no results", () => {
    expect(renderRunResult(run([], { status: "running" }), o)).toContain("Starting");
    expect(renderRunResult(run([]), o)).toContain("No apps needed a rebuild");
  });

  it("shows the base images in a details block", () => {
    const html = renderRunResult(
      run([res({ base_images: [{ image: "docker.io/library/node:22.11.3", digest: "sha256:0123456789abcdef9999", auto_patched_from: "22.11.0" }] })]),
      o
    );
    expect(html).toContain("<summary>Base images</summary>");
    expect(html).toContain("node:22.11.3");
    expect(html).toContain("@0123456789ab");
    expect(html).toContain("auto-patched from 22.11.0");
  });

  it("heads a run with trigger, age and duration", () => {
    const h = runHeading(run([res()]), o);
    expect(h).toContain("Weekly schedule");
    expect(h).toContain("started 17h ago");
    expect(h).toContain("9m 41s");
    expect(runHeading(run([res()], { status: "running", finished_at: null }), o)).toContain("<strong>running</strong>");
  });

  it("summarises an earlier run on one line", () => {
    const h = renderEarlierRun(run([res(), res({ outcome: "skipped" })], { id: 14, trigger: "manual" }), o);
    expect(h).toContain("#14");
    expect(h).toContain("Started by an admin");
    expect(h).toContain("1 rebuilt, 1 skipped");
  });
});
