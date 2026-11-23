/**
 * S06: a tar made the way the MCP client makes it (tar.create, portable,
 * long names, a hard link, an inside symlink) must pass the new checks and
 * unpack faithfully. Guards against the checks refusing legitimate uploads.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { extractTarSafe, inspectTarFile, tarLimits } from "./safe-tar.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runway-roundtrip-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function packProject(root: string, files: string[]): Promise<string> {
  const out = join(dir, "ctx.tar");
  await create({ file: out, cwd: root, gzip: false, portable: true, prefix: "" }, files);
  return out;
}

describe("a client-made tar", () => {
  it("passes the checks and unpacks with content, symlink and hardlink intact", async () => {
    const root = join(dir, "proj");
    const longDir = join(root, "d".repeat(60), "e".repeat(60));
    mkdirSync(longDir, { recursive: true });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
    writeFileSync(join(root, "src/app.js"), "console.log(1)\n");
    writeFileSync(join(longDir, "x".repeat(80) + ".txt"), "long name\n"); // > 100 chars in total: pax header
    symlinkSync("app.js", join(root, "src/alias"));
    linkSync(join(root, "src/app.js"), join(root, "src/hard.js"));

    const files = [
      "Dockerfile",
      "src/app.js",
      "src/alias",
      "src/hard.js",
      `${"d".repeat(60)}/${"e".repeat(60)}/${"x".repeat(80)}.txt`,
    ];
    const tar = await packProject(root, files);
    const limits = tarLimits(10 * 1024 * 1024);

    const stats = await inspectTarFile(tar, limits);
    expect(stats.entries).toBeGreaterThanOrEqual(files.length);

    const dest = join(dir, "out");
    await extractTarSafe(tar, dest, limits);
    expect(readFileSync(join(dest, "Dockerfile"), "utf8")).toBe("FROM scratch\n");
    expect(readFileSync(join(dest, "src/hard.js"), "utf8")).toBe("console.log(1)\n");
    expect(readlinkSync(join(dest, "src/alias"))).toBe("app.js");
    expect(readFileSync(join(dest, files[4]), "utf8")).toBe("long name\n");
  });

  it("owns the unpacked files as nobody when run as root", async () => {
    if (process.getuid?.() !== 0) return; // only meaningful where chown is allowed (the container)
    const root = join(dir, "proj");
    mkdirSync(root);
    writeFileSync(join(root, "a.txt"), "a");
    const tar = await packProject(root, ["a.txt"]);
    const dest = join(dir, "out");
    await extractTarSafe(tar, dest, tarLimits(1024 * 1024));
    const st = lstatSync(join(dest, "a.txt"));
    expect(st.uid).toBe(65534);
    expect(st.gid).toBe(65534);
  });
});
