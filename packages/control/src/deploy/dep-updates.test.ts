import { describe, it, expect } from "vitest";
import {
  chooseFix,
  compareVersions,
  depKey,
  describeUpdate,
  ecosystemOf,
  parseVersion,
  planDepUpdates,
  raiseSpecifier,
  requirementsMention,
  rewritePackageJson,
  rewriteRequirements,
  sameLine,
} from "./dep-updates.js";
import type { Finding } from "./scan.js";

const py = (id: string, pkg: string, version: string, fixedVersion: string | undefined, severity: Finding["severity"] = "HIGH"): Finding => ({
  id, severity, source: "image", pkg, version, fixedVersion, pkgType: "python-pkg",
});
const node = (id: string, pkg: string, version: string, fixedVersion: string | undefined, severity: Finding["severity"] = "HIGH", pkgPath = `app/node_modules/${pkg}/package.json`): Finding => ({
  id, severity, source: "image", pkg, version, fixedVersion, pkgType: "node-pkg", pkgPath,
});
const none = new Set<string>();

describe("ecosystemOf", () => {
  it("recognises python and node packages", () => {
    expect(ecosystemOf(py("C", "pillow", "1.0.0", "1.0.1"))).toBe("python");
    expect(ecosystemOf(node("C", "qs", "1.0.0", "1.0.1"))).toBe("node");
  });
  it("ignores OS packages and findings without a type", () => {
    expect(ecosystemOf({ id: "C", severity: "HIGH", source: "image", pkg: "musl", pkgType: "alpine" })).toBeNull();
    expect(ecosystemOf({ id: "C", severity: "HIGH", source: "image", pkg: "x" })).toBeNull();
  });
  it("ignores node modules that ship with the base image (npm itself)", () => {
    expect(
      ecosystemOf(node("C", "tar", "6.0.0", "6.2.1", "HIGH", "usr/local/lib/node_modules/npm/node_modules/tar/package.json"))
    ).toBeNull();
  });
  it("ignores secret and misconfig findings", () => {
    expect(ecosystemOf({ ...py("C", "pillow", "1.0.0", "1.0.1"), source: "secret" })).toBeNull();
  });
});

describe("versions", () => {
  it("parses plain release versions only", () => {
    expect(parseVersion("12.3.0")).toEqual([12, 3, 0]);
    expect(parseVersion("v2.0")).toEqual([2, 0]);
    expect(parseVersion("1.0.0rc1")).toBeNull();
    expect(parseVersion("1.0.0-beta.2")).toBeNull();
    expect(parseVersion("1!2.0")).toBeNull();
  });
  it("compares numerically, not as text", () => {
    expect(compareVersions([1, 20, 9], [1, 20, 10])).toBe(-1);
    expect(compareVersions([2], [2, 0, 0])).toBe(0);
    expect(compareVersions([13, 0, 0], [12, 3, 0])).toBe(1);
  });
  it("treats 0.x minors as separate lines", () => {
    expect(sameLine([1, 2], [1, 9])).toBe(true);
    expect(sameLine([0, 2, 1], [0, 3, 0])).toBe(false);
    expect(sameLine([0, 2, 1], [0, 2, 9])).toBe(true);
  });
});

describe("chooseFix", () => {
  it("prefers the fix on the installed line when several are listed", () => {
    expect(chooseFix("1.20.5", "2.4.0, 1.20.9")).toEqual({ version: "1.20.9", kind: "compatible" });
  });
  it("crosses a major only when the installed line has no fix", () => {
    expect(chooseFix("12.3.0", "13.0.0")).toEqual({ version: "13.0.0", kind: "major" });
  });
  it("ignores fixes at or below the installed version", () => {
    expect(chooseFix("2.5.0", "2.4.0, 1.20.9")).toBeNull();
  });
  it("returns null for versions it cannot order", () => {
    expect(chooseFix("1.0.0rc1", "1.0.0")).toBeNull();
    expect(chooseFix("1.0.0", "1.0.1rc1")).toBeNull();
  });
});

describe("planDepUpdates", () => {
  it("splits one package into a compatible and a major step", () => {
    const plan = planDepUpdates(
      [node("CVE-A", "nodemailer", "9.0.1", "9.1.0"), node("CVE-B", "nodemailer", "9.0.1", "10.0.6")],
      none
    );
    expect(plan.compatible).toEqual([
      { ecosystem: "node", name: "nodemailer", from: "9.0.1", to: "9.1.0", kind: "compatible", cves: ["CVE-A"] },
    ]);
    expect(plan.major).toEqual([
      { ecosystem: "node", name: "nodemailer", from: "9.0.1", to: "10.0.6", kind: "major", cves: ["CVE-B"] },
    ]);
  });
  it("takes the highest fix across the findings of a package", () => {
    const plan = planDepUpdates(
      [py("CVE-A", "pillow", "12.3.0", "13.0.0", "CRITICAL"), py("CVE-B", "pillow", "12.3.0", "13.0.2")],
      none
    );
    expect(plan.major).toHaveLength(1);
    expect(plan.major[0]).toMatchObject({ to: "13.0.2", cves: ["CVE-A", "CVE-B"] });
  });
  it("leaves medium and low findings alone unless actively exploited", () => {
    const findings = [py("CVE-M", "jinja2", "3.1.0", "3.1.6", "MEDIUM")];
    expect(planDepUpdates(findings, none).compatible).toEqual([]);
    expect(planDepUpdates(findings, new Set(["CVE-M"])).compatible).toHaveLength(1);
  });
  it("ignores OS packages and findings without a fix", () => {
    const plan = planDepUpdates(
      [
        { id: "CVE-O", severity: "CRITICAL", source: "image", pkg: "musl", version: "1.2.5", fixedVersion: "1.2.6", pkgType: "alpine" },
        py("CVE-N", "pillow", "12.3.0", undefined, "CRITICAL"),
      ],
      none
    );
    expect(plan).toEqual({ compatible: [], major: [], skipped: [] });
  });
  it("plans from the lowest installed copy of a package", () => {
    const plan = planDepUpdates(
      [
        node("CVE-Q", "qs", "6.15.1", "6.16.1", "HIGH", "app/node_modules/body-parser/node_modules/qs/package.json"),
        node("CVE-Q", "qs", "6.14.2", "6.16.1"),
      ],
      none
    );
    expect(plan.compatible[0]).toMatchObject({ from: "6.14.2", to: "6.16.1" });
  });
  it("skips a version that failed recently, and says so", () => {
    const findings = [py("CVE-A", "pillow", "12.3.0", "13.0.0", "CRITICAL")];
    const plan = planDepUpdates(findings, none, { skip: new Set(["python:pillow@13.0.0"]) });
    expect(plan.major).toEqual([]);
    expect(plan.skipped[0].reason).toContain("failed recently");
  });
  it("reports a package whose versions cannot be read", () => {
    const plan = planDepUpdates([py("CVE-A", "weird", "1.0.0rc1", "1.0.0", "CRITICAL")], none);
    expect(plan.skipped).toHaveLength(1);
  });
});

describe("depKey / describeUpdate", () => {
  it("normalises python names", () => {
    expect(depKey({ ecosystem: "python", name: "Typing_Extensions", to: "4.0.0" })).toBe("python:typing-extensions@4.0.0");
    expect(depKey({ ecosystem: "node", name: "@scope/Pkg", to: "1.0.0" })).toBe("node:@scope/Pkg@1.0.0");
  });
  it("marks major jumps", () => {
    expect(describeUpdate({ name: "pillow", from: "12.3.0", to: "13.0.0", kind: "major" })).toBe("pillow 12.3.0 → 13.0.0 (major)");
    expect(describeUpdate({ name: "qs", from: "6.14.2", to: "6.16.1", kind: "compatible" })).toBe("qs 6.14.2 → 6.16.1");
  });
});

describe("raiseSpecifier", () => {
  it("keeps an exact pin exact", () => {
    expect(raiseSpecifier("==12.3.0", "13.0.0")).toBe("==13.0.0");
  });
  it("drops an upper bound that excludes the fix", () => {
    expect(raiseSpecifier(">=12.2,<13.0", "13.0.0")).toBe(">=13.0.0");
  });
  it("keeps an upper bound that still allows the fix", () => {
    expect(raiseSpecifier(">=2.31,<3.0", "2.32.4")).toBe(">=2.32.4,<3.0");
    expect(raiseSpecifier(">=1.0,<=2.0,!=1.5", "1.6")).toBe(">=1.6,<=2.0,!=1.5");
  });
  it("replaces compatible-release and wildcard pins by a floor", () => {
    expect(raiseSpecifier("~=3.1", "3.1.6")).toBe(">=3.1.6");
    expect(raiseSpecifier("==3.1.*", "3.2.0")).toBe(">=3.2.0");
    expect(raiseSpecifier("", "1.0.0")).toBe(">=1.0.0");
  });
});

describe("rewriteRequirements", () => {
  const text = [
    "# web",
    "fastapi>=0.110,<1.0",
    "uvicorn[standard]>=0.27,<1.0  # server",
    "Pillow>=12.2,<13.0",
    'pywin32==306 ; sys_platform == "win32"',
    "",
  ].join("\n");

  it("raises a listed package in place, whatever its capitalisation", () => {
    const r = rewriteRequirements(text, [{ name: "pillow", to: "13.0.0" }]);
    expect(r.applied).toEqual(["pillow"]);
    expect(r.text).toContain("Pillow>=13.0.0\n");
    expect(r.text).toContain("fastapi>=0.110,<1.0");
  });
  it("keeps extras, markers and trailing comments", () => {
    const r = rewriteRequirements(text, [
      { name: "uvicorn", to: "0.30.0" },
      { name: "pywin32", to: "307" },
    ]);
    expect(r.text).toContain("uvicorn[standard]>=0.30.0,<1.0  # server");
    expect(r.text).toContain('pywin32==307 ; sys_platform == "win32"');
  });
  it("appends a package that is not listed", () => {
    const r = rewriteRequirements(text, [{ name: "setuptools", to: "78.1.1" }]);
    expect(r.applied).toEqual(["setuptools"]);
    expect(r.text.endsWith("# Added by Runway: minimum versions that fix known vulnerabilities.\nsetuptools>=78.1.1\n")).toBe(true);
  });
  it("does not append when told the file is not the install file", () => {
    const r = rewriteRequirements(text, [{ name: "setuptools", to: "78.1.1" }], false);
    expect(r.applied).toEqual([]);
    expect(r.text).toBe(text);
  });
  it("refuses hash-pinned files", () => {
    const hashed = "pillow==12.3.0 \\\n    --hash=sha256:abc\n";
    const r = rewriteRequirements(hashed, [{ name: "pillow", to: "13.0.0" }]);
    expect(r.applied).toEqual([]);
    expect(r.text).toBe(hashed);
    expect(r.skipped[0].reason).toContain("hashes");
  });
  it("leaves URL installs and option lines alone", () => {
    const urls = "-r base.txt\nmypkg @ https://example.com/mypkg.whl\n";
    const r = rewriteRequirements(urls, [{ name: "mypkg", to: "2.0.0" }]);
    expect(r.applied).toEqual([]);
    expect(r.text).toBe(urls);
  });
  it("keeps CRLF line endings", () => {
    const r = rewriteRequirements("pillow==12.3.0\r\nflask==3.0.0\r\n", [{ name: "pillow", to: "13.0.0" }]);
    expect(r.text).toBe("pillow==13.0.0\r\nflask==3.0.0\r\n");
  });
  it("requirementsMention matches normalised names only", () => {
    expect(requirementsMention(text, "PILLOW")).toBe(true);
    expect(requirementsMention(text, "pil")).toBe(false);
    expect(requirementsMention("typing_extensions>=4\n", "typing-extensions")).toBe(true);
  });
});

describe("rewritePackageJson", () => {
  const pkg = JSON.stringify(
    { name: "app", dependencies: { express: "^4.21.0", nodemailer: "^9.0.1", mine: "github:me/mine" } },
    null,
    2
  ) + "\n";

  it("raises the range of a direct dependency", () => {
    const r = rewritePackageJson(pkg, [{ name: "nodemailer", to: "10.0.6" }]);
    expect(r.applied).toEqual(["nodemailer"]);
    expect(JSON.parse(r.text).dependencies.nodemailer).toBe("^10.0.6");
    expect(JSON.parse(r.text).overrides).toBeUndefined();
  });
  it("forces a transitive dependency through overrides", () => {
    const r = rewritePackageJson(pkg, [{ name: "proxy-addr", to: "2.0.8" }]);
    expect(JSON.parse(r.text).overrides).toEqual({ "proxy-addr": "^2.0.8" });
    expect(JSON.parse(r.text).dependencies.express).toBe("^4.21.0");
  });
  it("keeps the file's indentation and trailing newline", () => {
    const tabbed = '{\n\t"name": "a",\n\t"dependencies": {\n\t\t"qs": "^6.0.0"\n\t}\n}\n';
    const r = rewritePackageJson(tabbed, [{ name: "qs", to: "6.16.1" }]);
    expect(r.text).toBe('{\n\t"name": "a",\n\t"dependencies": {\n\t\t"qs": "^6.16.1"\n\t}\n}\n');
  });
  it("skips dependencies that do not come from the registry by version", () => {
    const r = rewritePackageJson(pkg, [{ name: "mine", to: "2.0.0" }]);
    expect(r.applied).toEqual([]);
    expect(r.text).toBe(pkg);
    expect(r.skipped[0].reason).toContain("registry");
  });
  it("does not overwrite a nested override", () => {
    const withNested = JSON.stringify({ name: "a", overrides: { qs: { ".": "6.0.0" } } });
    const r = rewritePackageJson(withNested, [{ name: "qs", to: "6.16.1" }]);
    expect(r.applied).toEqual([]);
    expect(r.skipped[0].reason).toContain("nested override");
  });
  it("reports invalid JSON instead of throwing", () => {
    const r = rewritePackageJson("{nope", [{ name: "qs", to: "6.16.1" }]);
    expect(r.applied).toEqual([]);
    expect(r.skipped[0].reason).toContain("not valid JSON");
  });
});
