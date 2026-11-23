/**
 * S06: an upload is streamed to disk under a hard cap. A body with no
 * Content-Length must be cut off as soon as it passes the cap, not after it
 * has been read in full, and no temp file may be left behind.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStaleUploads, receiveUpload, UploadTooLargeError } from "./upload.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runway-upload-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A stream that yields `count` chunks of `size` bytes and counts how many were pulled. */
function counting(count: number, size: number) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= count) return controller.close();
      pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(65));
    },
  });
  return { stream, pulled: () => pulled };
}

describe("receiveUpload", () => {
  it("writes the body to a file and reports its size", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello "));
        c.enqueue(new TextEncoder().encode("world"));
        c.close();
      },
    });
    const up = await receiveUpload(body, 1024, dir);
    expect(up.bytes).toBe(11);
    expect(readFileSync(up.path, "utf8")).toBe("hello world");
  });

  it("stops reading shortly after the cap, without buffering the rest", async () => {
    const { stream, pulled } = counting(500, 1024 * 1024); // 500 MB on offer
    await expect(receiveUpload(stream, 5 * 1024 * 1024, dir)).rejects.toBeInstanceOf(UploadTooLargeError);
    // Cap is 5 MB of 1 MB chunks: a handful of pulls (read-ahead included), never hundreds.
    expect(pulled()).toBeLessThan(40);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("accepts a body of exactly the cap", async () => {
    const { stream } = counting(4, 1024);
    const up = await receiveUpload(stream, 4096, dir);
    expect(up.bytes).toBe(4096);
  });

  it("removes the temp file when the client hangs up midway", async () => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        n += 1;
        if (n > 2) c.error(new Error("socket closed"));
        else c.enqueue(new Uint8Array(100));
      },
    });
    await expect(receiveUpload(body, 1024 * 1024, dir)).rejects.toThrow(/socket closed/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("treats a missing body as empty", async () => {
    const up = await receiveUpload(null, 1024, dir);
    expect(up.bytes).toBe(0);
    expect(existsSync(up.path)).toBe(false);
  });
});

describe("cleanupStaleUploads", () => {
  it("removes old upload files, keeps fresh ones and anything else", async () => {
    const old = join(dir, "upload-1-aabbcc.tar");
    const fresh = join(dir, "upload-2-ddeeff.tar");
    const other = join(dir, "notes.txt");
    for (const f of [old, fresh, other]) writeFileSync(f, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);
    utimesSync(other, twoHoursAgo, twoHoursAgo);
    expect(await cleanupStaleUploads(dir)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["notes.txt", "upload-2-ddeeff.tar"]);
  });

  it("copes with a folder that does not exist", async () => {
    expect(await cleanupStaleUploads(join(dir, "nope"))).toBe(0);
  });
});
