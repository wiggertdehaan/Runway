import { describe, it, expect } from "vitest";
import {
  parseImageRef,
  parseExactTag,
  pickLatestPatch,
  parseDockerfile,
  expandArgs,
  planBasePatches,
  extractUsedBaseImages,
  describeBaseImage,
  type TagSource,
} from "./base-images.js";

describe("parseImageRef", () => {
  it("official image gets docker.io/library", () => {
    expect(parseImageRef("nginx:1.30.6-alpine")).toEqual({
      registry: "docker.io", repo: "library/nginx", tag: "1.30.6-alpine", digest: null,
    });
  });
  it("user repo, registry host with port, digest", () => {
    expect(parseImageRef("grafana/grafana:11.2.1")?.repo).toBe("grafana/grafana");
    expect(parseImageRef("ghcr.io/o/r:1.2.3")?.registry).toBe("ghcr.io");
    expect(parseImageRef("localhost:5000/x:1.2.3")?.registry).toBe("localhost:5000");
    const d = "sha256:" + "a".repeat(64);
    expect(parseImageRef(`nginx:1.30.6@${d}`)).toMatchObject({ tag: "1.30.6", digest: d });
    expect(parseImageRef(`nginx@${d}`)).toMatchObject({ tag: null, digest: d });
  });
  it("no tag, bad input", () => {
    expect(parseImageRef("nginx")?.tag).toBeNull();
    expect(parseImageRef("")).toBeNull();
    expect(parseImageRef("a b")).toBeNull();
    expect(parseImageRef("nginx@notadigest")).toBeNull();
  });
});

describe("parseExactTag", () => {
  it("accepts exact patch pins, with variants", () => {
    expect(parseExactTag("1.30.6-alpine")).toMatchObject({ major: 1, minor: 30, patch: 6, variant: "alpine" });
    expect(parseExactTag("3.12.7")).toMatchObject({ variant: "" });
    expect(parseExactTag("3.12.7-slim-bookworm")?.variant).toBe("slim-bookworm");
    expect(parseExactTag("1.27.3-alpine3.20")?.variant).toBe("alpine3.20");
    expect(parseExactTag("v1.2.3")).toMatchObject({ prefix: "v", patch: 3 });
  });
  it("rejects floating, minor-only, major-only, latest", () => {
    for (const t of ["latest", "1.30", "1.30-alpine", "24-alpine", "24", "alpine", "stable"]) {
      expect(parseExactTag(t)).toBeNull();
    }
  });
  it("rejects tags with characters that could inject Dockerfile content", () => {
    for (const t of ["1.30.7-alpine\nRUN evil", "1.30.7 alpine", "1.30.7-alpine;x", "1.30.7-$(id)", "1.30.7-\"q"]) {
      expect(parseExactTag(t)).toBeNull();
    }
  });
  it("rejects 4-part versions and pre-releases", () => {
    expect(parseExactTag("1.30.6.1")).toBeNull();
    expect(parseExactTag("1.30.6-rc1")).toBeNull();
    expect(parseExactTag("1.30.6-beta.2")).toBeNull();
  });
});

describe("pickLatestPatch", () => {
  const cur = parseExactTag("1.30.6-alpine")!;
  const tags = [
    "1.30.5-alpine", "1.30.6-alpine", "1.30.7-alpine", "1.30.8-alpine-slim",
    "1.30.9-alpine-perl", "1.30.7", "1.31.0-alpine", "1.29.9-alpine", "2.0.0-alpine",
    "1.30-alpine", "alpine", "latest", "1.30.7-alpine3.22",
  ];
  it("newest patch, same minor, same variant only", () => {
    expect(pickLatestPatch(cur, tags)).toBe("1.30.7-alpine");
  });
  it("never crosses minor or major", () => {
    expect(pickLatestPatch(cur, ["1.31.0-alpine", "2.0.0-alpine", "1.29.9-alpine"])).toBeNull();
  });
  it("compares patch numerically, not lexically", () => {
    expect(pickLatestPatch(parseExactTag("1.30.9-alpine")!, ["1.30.10-alpine", "1.30.9-alpine"])).toBe("1.30.10-alpine");
  });
  it("never downgrades or repeats the current tag", () => {
    expect(pickLatestPatch(cur, ["1.30.6-alpine", "1.30.3-alpine"])).toBeNull();
  });
  it("variant-less pin does not jump to a variant tag", () => {
    expect(pickLatestPatch(parseExactTag("3.12.7")!, ["3.12.8-slim", "3.12.8"])).toBe("3.12.8");
    expect(pickLatestPatch(parseExactTag("3.12.7")!, ["3.12.8-slim"])).toBeNull();
  });
  it("keeps the v prefix", () => {
    expect(pickLatestPatch(parseExactTag("v1.2.3")!, ["1.2.9", "v1.2.4"])).toBe("v1.2.4");
  });
});

describe("expandArgs", () => {
  it("expands forms, applies defaults", () => {
    expect(expandArgs("nginx:${V}", { V: "1.30.6" })).toBe("nginx:1.30.6");
    expect(expandArgs("nginx:$V", { V: "1.30.6" })).toBe("nginx:1.30.6");
    expect(expandArgs("${B:-node:24}", {})).toBe("node:24");
    expect(expandArgs("${B:-node:24}", { B: "node:22" })).toBe("node:22");
  });
  it("null for unset or unmodelled", () => {
    expect(expandArgs("nginx:${V}", {})).toBeNull();
    expect(expandArgs("x:${V:+y}", { V: "1" })).toBeNull();
  });
});

describe("parseDockerfile", () => {
  it("multi-stage: stage refs and scratch are not images", () => {
    const p = parseDockerfile(
      ["FROM node:24.1.0-alpine AS build", "RUN x", "FROM build AS test", "FROM scratch", "FROM nginx:1.30.6-alpine"].join("\n")
    );
    expect(p.froms.map((f) => f.raw)).toEqual(["node:24.1.0-alpine", "nginx:1.30.6-alpine"]);
    expect(p.froms[0].stage).toBe("build");
  });
  it("handles --platform, case, comments and continuations", () => {
    const p = parseDockerfile(
      ["# FROM fake:1.2.3", "from --platform=linux/amd64 python:3.12.7-slim as base", "RUN a \\", "  && b", "FROM \\", "  nginx:1.30.6"].join("\n")
    );
    expect(p.froms.map((f) => f.raw)).toEqual(["python:3.12.7-slim", "nginx:1.30.6"]);
  });
  it("global ARGs resolve FROM refs; ARG after first FROM does not", () => {
    const p = parseDockerfile(
      ["ARG V=1.30.6-alpine", 'ARG R="nginx"', "FROM ${R}:${V}", "ARG LATE=x", "FROM busybox:${LATE}"].join("\n")
    );
    expect(p.froms[0].resolved).toBe("nginx:1.30.6-alpine");
    expect(p.froms[1].resolved).toBeNull();
  });
});

function source(map: Record<string, string[]>): TagSource & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (ref: { registry: string; repo: string }) => {
    calls.push(`${ref.registry}/${ref.repo}`);
    const t = map[ref.repo];
    if (!t) throw new Error("not found");
    return t;
  }) as unknown as TagSource & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const NGINX = ["1.30.6-alpine", "1.30.7-alpine", "1.31.0-alpine"];
const NODE = ["24.1.0-alpine", "24.1.2-alpine", "25.0.0-alpine"];

describe("planBasePatches", () => {
  it("rewrites a literal exact pin in a copy, leaving the rest identical", async () => {
    const df = "FROM nginx:1.30.6-alpine\nCOPY . /usr/share/nginx/html\n";
    const plan = await planBasePatches(df, source({ "library/nginx": NGINX }));
    expect(plan.dockerfile).toBe("FROM nginx:1.30.7-alpine\nCOPY . /usr/share/nginx/html\n");
    expect(plan.patches).toEqual([{ from: "nginx:1.30.6-alpine", to: "nginx:1.30.7-alpine" }]);
    expect(plan.buildArgs).toEqual({});
  });
  it("leaves digest pins, floating tags and minor pins alone (and never queries)", async () => {
    const d = "sha256:" + "b".repeat(64);
    const df = [`FROM nginx:1.30.6-alpine@${d}`, "FROM node:24-alpine", "FROM python", "FROM nginx:1.30-alpine", "FROM alpine:latest"].join("\n");
    const src = source({ "library/nginx": NGINX });
    const plan = await planBasePatches(df, src);
    expect(plan.dockerfile).toBeUndefined();
    expect(plan.patches).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      "digest-pinned", "not an exact patch pin", "floating (no tag)", "not an exact patch pin", "not an exact patch pin",
    ]);
    expect(src.calls).toEqual([]);
  });
  it("multi-stage: bumps each external base, skips stage refs", async () => {
    const df = ["FROM node:24.1.0-alpine AS build", "RUN build", "FROM build AS x", "FROM nginx:1.30.6-alpine", "COPY --from=build /o /h"].join("\n");
    const plan = await planBasePatches(df, source({ "library/nginx": NGINX, "library/node": NODE }));
    expect(plan.dockerfile).toContain("FROM node:24.1.2-alpine AS build");
    expect(plan.dockerfile).toContain("FROM nginx:1.30.7-alpine\n");
    expect(plan.patches).toHaveLength(2);
  });
  it("already newest -> no change", async () => {
    const plan = await planBasePatches("FROM nginx:1.30.7-alpine", source({ "library/nginx": NGINX }));
    expect(plan.dockerfile).toBeUndefined();
    expect(plan.skipped[0].reason).toBe("already on the newest patch");
  });
  it("registry failure is a skip, not an error", async () => {
    const plan = await planBasePatches("FROM nginx:1.30.6-alpine", source({}));
    expect(plan.patches).toEqual([]);
    expect(plan.skipped[0].reason).toContain("registry lookup failed");
  });
  it("ARG as the tag -> build-arg, Dockerfile untouched", async () => {
    const df = "ARG NGINX_VERSION=1.30.6-alpine\nFROM nginx:${NGINX_VERSION}\n";
    const plan = await planBasePatches(df, source({ "library/nginx": NGINX }));
    expect(plan.dockerfile).toBeUndefined();
    expect(plan.buildArgs).toEqual({ NGINX_VERSION: "1.30.7-alpine" });
    expect(plan.patches).toEqual([{ from: "nginx:1.30.6-alpine", to: "nginx:1.30.7-alpine" }]);
  });
  it("ARG as the whole image -> build-arg carries the full new ref", async () => {
    const df = "ARG BASE=nginx:1.30.6-alpine\nFROM $BASE\n";
    const plan = await planBasePatches(df, source({ "library/nginx": NGINX }));
    expect(plan.buildArgs).toEqual({ BASE: "nginx:1.30.7-alpine" });
  });
  it("ARG shapes we don't model, undeclared ARGs and unresolved ARGs are skipped", async () => {
    const src = source({ "library/nginx": NGINX });
    const mixed = await planBasePatches("ARG M=1\nFROM nginx:${M}.30.6-alpine", src);
    expect(mixed.patches).toEqual([]);
    const undeclared = await planBasePatches("FROM nginx:${V:-1.30.6-alpine}", src);
    expect(undeclared.patches).toEqual([]);
    expect(undeclared.skipped[0].reason).toContain("not declared");
    const unresolved = await planBasePatches("FROM nginx:${V}", src);
    expect(unresolved.skipped[0].reason).toContain("cannot resolve");
  });
  it("one ARG needing two different values is not overridden at all", async () => {
    const df = "ARG T=1.30.6-alpine\nFROM nginx:${T}\nFROM node:${T}\n";
    const plan = await planBasePatches(df, source({ "library/nginx": NGINX, "library/node": ["1.30.6-alpine", "1.30.9-alpine"] }));
    expect(plan.buildArgs).toEqual({});
    expect(plan.patches).toEqual([]);
  });
  it("preserves CRLF line endings", async () => {
    const plan = await planBasePatches("FROM nginx:1.30.6-alpine\r\nCOPY . /x\r\n", source({ "library/nginx": NGINX }));
    expect(plan.dockerfile).toBe("FROM nginx:1.30.7-alpine\r\nCOPY . /x\r\n");
  });
  it("non-docker.io registries are looked up on their own registry", async () => {
    const src = source({ "o/r": ["1.2.3", "1.2.4"] });
    const plan = await planBasePatches("FROM ghcr.io/o/r:1.2.3", src);
    expect(plan.dockerfile).toBe("FROM ghcr.io/o/r:1.2.4");
    expect(src.calls).toEqual(["ghcr.io/o/r"]);
  });
});

describe("extractUsedBaseImages / describeBaseImage", () => {
  const d1 = "sha256:" + "1".repeat(64);
  const d2 = "sha256:" + "2".repeat(64);
  const log = [
    `#5 [build 1/4] FROM docker.io/library/node:24.1.2-alpine@${d1}`,
    `#5 resolve docker.io/library/node:24.1.2-alpine@${d1} 0.0s done`,
    `#9 [stage-1 1/3] FROM docker.io/library/nginx:1.30.7-alpine@${d2}`,
    `#9 [stage-1 1/3] FROM docker.io/library/nginx:1.30.7-alpine@${d2}`,
  ].join("\n");
  it("dedupes and marks auto-patched images", () => {
    const used = extractUsedBaseImages(log, [{ from: "nginx:1.30.6-alpine", to: "nginx:1.30.7-alpine" }]);
    expect(used).toEqual([
      { image: "docker.io/library/node:24.1.2-alpine", digest: d1 },
      { image: "docker.io/library/nginx:1.30.7-alpine", digest: d2, auto_patched_from: "1.30.6-alpine" },
    ]);
  });
  it("describes in one line", () => {
    expect(describeBaseImage({ image: "docker.io/library/nginx:1.30.7-alpine", digest: d2, auto_patched_from: "1.30.6-alpine" }))
      .toBe("nginx:1.30.7-alpine @222222222222 (auto-patched from 1.30.6-alpine)");
  });
  it("empty log -> nothing", () => {
    expect(extractUsedBaseImages("")).toEqual([]);
  });
});

// ── Escalation helpers ─────────────────────────────────────────────

import {
  parseVersionTag,
  pickMinorCandidates,
  pickMajorProbe,
  lineOf,
  findRuntimeFrom,
} from "./base-images.js";

describe("parseVersionTag", () => {
  it("classifies exact, minor and major pins with variants", () => {
    expect(parseVersionTag("1.29.8-alpine")).toMatchObject({ style: "exact", major: 1, minor: 29, patch: 8, variant: "alpine" });
    expect(parseVersionTag("1.29-alpine")).toMatchObject({ style: "minor", major: 1, minor: 29, variant: "alpine" });
    expect(parseVersionTag("24-alpine")).toMatchObject({ style: "major", major: 24, variant: "alpine" });
    expect(parseVersionTag("24")).toMatchObject({ style: "major", variant: "" });
  });
  it("rejects names, latest, pre-releases and unsafe tags", () => {
    for (const t of ["latest", "alpine", "stable", "1.29-rc1", "1-beta", "1.30\nRUN x", "1.30 x"]) {
      expect(parseVersionTag(t)).toBeNull();
    }
  });
});

describe("lineOf", () => {
  it("gives major.minor, or major for major pins", () => {
    expect(lineOf("1.30.7-alpine")).toBe("1.30");
    expect(lineOf("1.31-alpine")).toBe("1.31");
    expect(lineOf("24-alpine")).toBe("24");
    expect(lineOf("latest")).toBeNull();
  });
});

describe("pickMinorCandidates", () => {
  const tags = [
    "1.28.3-alpine", "1.29.8-alpine", "1.30.6-alpine", "1.30.7-alpine", "1.31.8-alpine", "1.31.9-alpine",
    "1.32.1-alpine", "1.33.0-alpine", "1.30.7-alpine-slim", "1.30.7", "2.0.1-alpine", "1.30-alpine", "1.31-alpine", "1.32-alpine", "latest",
  ];
  it("exact pin: newest patch of each HIGHER minor, same major+variant, lowest first", () => {
    const cur = parseVersionTag("1.29.8-alpine")!;
    expect(pickMinorCandidates(cur, tags)).toEqual(["1.30.7-alpine", "1.31.9-alpine", "1.32.1-alpine"]);
  });
  it("is capped and never includes the current or lower minors", () => {
    const cur = parseVersionTag("1.30.7-alpine")!;
    expect(pickMinorCandidates(cur, tags, 1)).toEqual(["1.31.9-alpine"]);
    expect(pickMinorCandidates(parseVersionTag("1.33.0-alpine")!, tags)).toEqual([]);
  });
  it("minor pin: follows the minor tag style", () => {
    expect(pickMinorCandidates(parseVersionTag("1.29-alpine")!, tags)).toEqual(["1.30-alpine", "1.31-alpine", "1.32-alpine"]);
  });
  it("never crosses major or variant; major pins have no minor to escalate", () => {
    expect(pickMinorCandidates(parseVersionTag("1.29.8-alpine")!, ["2.0.1-alpine", "1.30.7", "1.30.7-alpine-slim"])).toEqual([]);
    expect(pickMinorCandidates(parseVersionTag("24-alpine")!, ["24.1.0-alpine", "25-alpine"])).toEqual([]);
  });
  it("compares minors numerically (1.10 > 1.9)", () => {
    expect(pickMinorCandidates(parseVersionTag("1.9.1")!, ["1.10.0", "1.9.5"])).toEqual(["1.10.0"]);
  });
});

describe("pickMajorProbe", () => {
  it("lowest newer major, same style and variant, newest version in it", () => {
    const tags = ["2.0.1-alpine", "2.1.4-alpine", "3.0.0-alpine", "2.9.9", "1.30.7-alpine"];
    expect(pickMajorProbe(parseVersionTag("1.30.7-alpine")!, tags)).toBe("2.1.4-alpine");
  });
  it("major pins probe the next major tag", () => {
    expect(pickMajorProbe(parseVersionTag("24-alpine")!, ["25-alpine", "26-alpine", "24-alpine"])).toBe("25-alpine");
  });
  it("null when there is no newer major", () => {
    expect(pickMajorProbe(parseVersionTag("1.30.7-alpine")!, ["1.31.9-alpine"])).toBeNull();
  });
});

describe("findRuntimeFrom", () => {
  it("is the last stage's base, not a build stage", () => {
    const p = parseDockerfile("FROM node:24.1.0-alpine AS build\nRUN b\nFROM nginx:1.29.8-alpine\nCOPY --from=build /o /h");
    expect(findRuntimeFrom(p)?.raw).toBe("nginx:1.29.8-alpine");
  });
  it("follows a chain of stage references back to an image", () => {
    const p = parseDockerfile("FROM nginx:1.29.8-alpine AS base\nFROM base AS final\nRUN x");
    expect(findRuntimeFrom(p)?.raw).toBe("nginx:1.29.8-alpine");
  });
  it("null for scratch", () => {
    expect(findRuntimeFrom(parseDockerfile("FROM golang:1.23.4 AS b\nFROM scratch\nCOPY --from=b /x /x"))).toBeNull();
  });
  it("single-stage file", () => {
    expect(findRuntimeFrom(parseDockerfile("FROM python:3.12.7-slim"))?.raw).toBe("python:3.12.7-slim");
  });
});

describe("planBasePatches retarget", () => {
  const src = source({
    "library/nginx": ["1.29.8-alpine", "1.30.7-alpine"],
    "library/node": ["24.1.0-alpine", "24.1.2-alpine"],
  });
  const df = "FROM node:24.1.0-alpine AS build\nRUN b\nFROM nginx:1.29.8-alpine\nCOPY --from=build /o /h\n";

  it("forces only the chosen FROM; the other stage keeps its normal patch bump", async () => {
    const plan = await planBasePatches(df, src, { retarget: { line: 2, tag: "1.30.7-alpine", kind: "minor" } });
    expect(plan.dockerfile).toBe("FROM node:24.1.2-alpine AS build\nRUN b\nFROM nginx:1.30.7-alpine\nCOPY --from=build /o /h\n");
    expect(plan.patches).toEqual([
      { from: "node:24.1.0-alpine", to: "node:24.1.2-alpine" },
      { from: "nginx:1.29.8-alpine", to: "nginx:1.30.7-alpine", kind: "minor" },
    ]);
  });
  it("works on a minor pin (which normal patching skips)", async () => {
    const plan = await planBasePatches("FROM nginx:1.29-alpine\n", src, { retarget: { line: 0, tag: "1.30-alpine", kind: "minor" } });
    expect(plan.dockerfile).toBe("FROM nginx:1.30-alpine\n");
    const none = await planBasePatches("FROM nginx:1.29-alpine\n", src);
    expect(none.dockerfile).toBeUndefined();
  });
  it("ARG-driven runtime FROM becomes a build-arg", async () => {
    const plan = await planBasePatches("ARG V=1.29.8-alpine\nFROM nginx:${V}\n", src, { retarget: { line: 1, tag: "1.30.7-alpine", kind: "minor" } });
    expect(plan.buildArgs).toEqual({ V: "1.30.7-alpine" });
    expect(plan.dockerfile).toBeUndefined();
  });
  it("refuses to retarget a digest-pinned runtime", async () => {
    const d = "sha256:" + "c".repeat(64);
    const plan = await planBasePatches(`FROM nginx:1.29.8-alpine@${d}\n`, src, { retarget: { line: 0, tag: "1.30.7-alpine", kind: "minor" } });
    expect(plan.patches).toEqual([]);
  });
  it("major kind is recorded as such", async () => {
    const plan = await planBasePatches("FROM nginx:1.29.8-alpine\n", src, { retarget: { line: 0, tag: "2.0.1-alpine", kind: "major" } });
    expect(plan.patches[0].kind).toBe("major");
  });
});

describe("minor jumps in the used-image record", () => {
  const d = "sha256:" + "4".repeat(64);
  it("marks auto_minor_from and describes it", () => {
    const used = extractUsedBaseImages(`#5 [1/2] FROM docker.io/library/nginx:1.30.7-alpine@${d}`, [
      { from: "nginx:1.29.8-alpine", to: "nginx:1.30.7-alpine", kind: "minor" },
    ]);
    expect(used[0]).toEqual({ image: "docker.io/library/nginx:1.30.7-alpine", digest: d, auto_minor_from: "1.29" });
    expect(describeBaseImage(used[0])).toBe("nginx:1.30.7-alpine @444444444444 (auto-minor 1.29→1.30)");
  });
});
