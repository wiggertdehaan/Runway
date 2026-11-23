/**
 * Client side of S06: leave out symlinks that point outside the project (the
 * server refuses the whole upload for one), and stop early at the upload limit.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeLinkTarget, maxUploadBytes, tarProjectDetailed, UploadTooLargeLocalError } from "./tar.js";

describe("isSafeLinkTarget", () => {
  it("accepts links that stay inside", () => {
    expect(isSafeLinkTarget("link", "file.txt")).toBe(true);
    expect(isSafeLinkTarget("a/link", "../file.txt")).toBe(true);
    expect(isSafeLinkTarget("a/b/link", "../../file.txt")).toBe(true);
    expect(isSafeLinkTarget("a/link", "./c")).toBe(true);
  });
  it("refuses links that leave, are absolute, or use .. after a real segment", () => {
    expect(isSafeLinkTarget("link", "/etc/passwd")).toBe(false);
    expect(isSafeLinkTarget("link", "..")).toBe(false);
    expect(isSafeLinkTarget("a/link", "../../x")).toBe(false);
    expect(isSafeLinkTarget("link", "a/b/..")).toBe(false);
    expect(isSafeLinkTarget("link", "C:\\x")).toBe(false);
    expect(isSafeLinkTarget("link", "")).toBe(false);
  });
});

describe("maxUploadBytes", () => {
  it("defaults to 100 MB and follows RUNWAY_MAX_UPLOAD_MB", () => {
    expect(maxUploadBytes({})).toBe(100 * 1024 * 1024);
    expect(maxUploadBytes({ RUNWAY_MAX_UPLOAD_MB: "250" })).toBe(250 * 1024 * 1024);
    expect(maxUploadBytes({ RUNWAY_MAX_UPLOAD_MB: "nope" })).toBe(100 * 1024 * 1024);
    expect(maxUploadBytes({ RUNWAY_MAX_UPLOAD_MB: "-5" })).toBe(100 * 1024 * 1024);
  });
});

describe("tarProjectDetailed", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "runway-mcp-tar-"));
    writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/app.js"), "1\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("packs a project and keeps an inside symlink", async () => {
    symlinkSync("app.js", join(root, "src/alias"));
    const r = await tarProjectDetailed(root);
    expect(r.skippedLinks).toEqual([]);
    expect(r.fileCount).toBe(3);
    expect(r.buffer.length).toBeGreaterThan(0);
  });

  it("leaves out symlinks that point outside, and says which", async () => {
    symlinkSync("/etc/passwd", join(root, "abs"));
    symlinkSync("../../outside", join(root, "src/up"));
    symlinkSync("app.js", join(root, "src/alias"));
    const r = await tarProjectDetailed(root);
    expect(r.skippedLinks.sort()).toEqual(["abs", "src/up"]);
    expect(r.fileCount).toBe(3); // Dockerfile, app.js, alias
  });

  it("stops with a clear message when the tar would pass the limit", async () => {
    writeFileSync(join(root, "big.bin"), Buffer.alloc(300 * 1024));
    await expect(tarProjectDetailed(root, 100 * 1024)).rejects.toBeInstanceOf(UploadTooLargeLocalError);
    await expect(tarProjectDetailed(root, 100 * 1024)).rejects.toThrow(/upload limit/);
  });
});
