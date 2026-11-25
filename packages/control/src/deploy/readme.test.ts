import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readmeDescription } from "./readme.js";

const work = mkdtempSync(join(tmpdir(), "runway-readmetest-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
function makeTar(files: Record<string, string | { link: string }>, prefix = "./"): Buffer {
  const dir = join(work, `src${n++}`);
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    if (typeof body === "string") writeFileSync(p, body);
    else symlinkSync(body.link, p);
  }
  const out = join(work, `t${n}.tar`);
  execFileSync("tar", ["-cf", out, "-C", dir, ...Object.keys(files).map((f) => `${prefix}${f}`)]);
  return readFileSync(out);
}

describe("readmeDescription", () => {
  it("reads README.md at the root (with and without ./ prefix)", () => {
    const files = { Dockerfile: "FROM x", "README.md": "# App\n\nDoes the thing for the team.\n" };
    expect(readmeDescription(makeTar(files))).toBe("Does the thing for the team.");
    expect(readmeDescription(makeTar(files, ""))).toBe("Does the thing for the team.");
  });
  it("accepts another case of the name", () => {
    expect(readmeDescription(makeTar({ "readme.md": "# A\n\nLower case file." }))).toBe("Lower case file.");
  });
  it("no README gives null", () => {
    expect(readmeDescription(makeTar({ Dockerfile: "FROM x" }))).toBeNull();
  });
  it("only a README in a subfolder does not count", () => {
    expect(readmeDescription(makeTar({ "docs/README.md": "# A\n\nNested." }))).toBeNull();
  });
  it("README without a paragraph gives null", () => {
    expect(readmeDescription(makeTar({ "README.md": "# Only a title\n" }))).toBeNull();
  });
  it("a README that is a symlink is never followed", () => {
    expect(readmeDescription(makeTar({ "README.md": { link: "/etc/hostname" } }))).toBeNull();
  });
  it("garbage that is not a tar gives null instead of throwing", () => {
    expect(readmeDescription(Buffer.from("this is not a tar file at all"))).toBeNull();
    expect(readmeDescription(Buffer.alloc(0))).toBeNull();
  });
  it("a very large README still yields its first paragraph", () => {
    const big = `# Big\n\nFirst paragraph is here.\n\n${"filler line\n".repeat(60_000)}`;
    expect(readmeDescription(makeTar({ "README.md": big }))).toBe("First paragraph is here.");
  });
});
