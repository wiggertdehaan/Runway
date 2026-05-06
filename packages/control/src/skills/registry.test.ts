import { describe, it, expect } from "vitest";
import {
  bundleSha256,
  isTrustedSource,
  listTrustedOrgs,
  mimeForPath,
  parseSkillSource,
  sourceUrl,
} from "./registry.js";

describe("parseSkillSource", () => {
  it("parses owner/repo with no path as ref=main", () => {
    expect(parseSkillSource("anthropics/skills")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      path: "",
    });
  });

  it("parses owner/repo/path/to/skill", () => {
    expect(parseSkillSource("anthropics/skills/pdf")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      path: "pdf",
    });
  });

  it("parses nested paths", () => {
    expect(parseSkillSource("vercel-labs/agent-skills/foo/bar/baz")).toEqual({
      owner: "vercel-labs",
      repo: "agent-skills",
      ref: "main",
      path: "foo/bar/baz",
    });
  });

  it("parses bare github.com URL", () => {
    expect(parseSkillSource("https://github.com/anthropics/skills")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      path: "",
    });
  });

  it("parses tree URL with branch + path", () => {
    expect(
      parseSkillSource(
        "https://github.com/anthropics/skills/tree/develop/sub/dir",
      ),
    ).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "develop",
      path: "sub/dir",
    });
  });

  it("strips trailing slash", () => {
    expect(parseSkillSource("anthropics/skills/pdf/")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      path: "pdf",
    });
  });

  it("rejects empty input", () => {
    expect(parseSkillSource("")).toBeNull();
    expect(parseSkillSource("   ")).toBeNull();
  });

  it("rejects single-segment input", () => {
    expect(parseSkillSource("anthropics")).toBeNull();
    expect(parseSkillSource("https://github.com/anthropics")).toBeNull();
  });
});

describe("isTrustedSource", () => {
  it("matches the known whitelist verbatim", () => {
    expect(isTrustedSource("anthropics")).toBe(true);
    expect(isTrustedSource("vercel-labs")).toBe(true);
    expect(isTrustedSource("microsoft")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isTrustedSource("Anthropics")).toBe(true);
    expect(isTrustedSource("VERCEL-LABS")).toBe(true);
  });

  it("rejects unknown owners", () => {
    expect(isTrustedSource("randomuser")).toBe(false);
    expect(isTrustedSource("")).toBe(false);
  });
});

describe("listTrustedOrgs", () => {
  it("returns a sorted, non-empty list", () => {
    const orgs = listTrustedOrgs();
    expect(orgs.length).toBeGreaterThan(5);
    expect([...orgs]).toEqual([...orgs].sort());
    expect(orgs).toContain("anthropics");
  });
});

describe("bundleSha256", () => {
  const enc = new TextEncoder();
  const fileA = { path: "SKILL.md", content: enc.encode("hello") };
  const fileB = { path: "scripts/run.sh", content: enc.encode("echo hi") };

  it("is deterministic across input order", () => {
    const a = bundleSha256([fileA, fileB]);
    const b = bundleSha256([fileB, fileA]);
    expect(a).toBe(b);
  });

  it("produces a 64-char hex string", () => {
    expect(bundleSha256([fileA])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a file is renamed", () => {
    const renamed = { path: "SKILL.markdown", content: enc.encode("hello") };
    expect(bundleSha256([fileA])).not.toBe(bundleSha256([renamed]));
  });

  it("changes when content changes", () => {
    const altered = { path: "SKILL.md", content: enc.encode("hello!") };
    expect(bundleSha256([fileA])).not.toBe(bundleSha256([altered]));
  });

  it("uses path/content separators so concatenation collisions don't fool it", () => {
    // Without the null separator a file 'ab'+'c' would hash the same
    // as 'a'+'bc'. Verify the implementation doesn't have that bug.
    const split = bundleSha256([
      { path: "ab", content: enc.encode("c") },
    ]);
    const merged = bundleSha256([
      { path: "a", content: enc.encode("bc") },
    ]);
    expect(split).not.toBe(merged);
  });
});

describe("mimeForPath", () => {
  it.each([
    ["SKILL.md", "text/markdown"],
    ["readme.txt", "text/plain"],
    ["meta.json", "application/json"],
    ["compose.yaml", "application/yaml"],
    ["config.yml", "application/yaml"],
    ["scripts/run.sh", "text/x-shellscript"],
    ["lib/util.py", "text/x-python"],
    ["Dockerfile", "text/x-dockerfile"],
    ["logo.png", "image/png"],
    ["icon.svg", "image/svg+xml"],
    ["unknown.bin", "application/octet-stream"],
  ])("%s → %s", (path, mime) => {
    expect(mimeForPath(path)).toBe(mime);
  });
});

describe("sourceUrl", () => {
  it("renders a tree URL when path is set", () => {
    expect(
      sourceUrl({
        owner: "anthropics",
        repo: "skills",
        ref: "main",
        path: "pdf",
      }),
    ).toBe("https://github.com/anthropics/skills/tree/main/pdf");
  });

  it("renders a bare repo URL when path is empty", () => {
    expect(
      sourceUrl({
        owner: "anthropics",
        repo: "skills",
        ref: "main",
        path: "",
      }),
    ).toBe("https://github.com/anthropics/skills");
  });
});
