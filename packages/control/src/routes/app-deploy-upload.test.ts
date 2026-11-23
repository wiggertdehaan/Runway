/**
 * S06 at the route: POST /api/v1/app/deploy streams the body to disk under
 * the upload limit (also without Content-Length), refuses hostile or
 * compressed tars with a 400 before the deploy pipeline sees them, and never
 * leaves an upload file behind. Drives the real app; only deployApp is replaced.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const deployApp = vi.hoisted(() =>
  vi.fn(async (_input: { app: unknown; tar: unknown }) => ({
    app_id: "x",
    image_tag: "runway/x:1",
    container_id: "c",
    container_name: "runway-x",
    domain: null,
    log_tail: "",
    scan: { status: "passed", counts: {}, findings: [] },
    base_images: [],
  })),
);
vi.mock("../deploy/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../deploy/index.js")>();
  return { ...real, deployApp };
});

import { readdirSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { app } from "../app.js";
import { migrate } from "../db/index.js";
import { createApp, updateApp } from "../db/apps.js";
import { setSetting } from "../db/settings.js";
import { UPLOAD_DIR } from "../deploy/upload.js";

let key = "";
let unconfiguredKey = "";

beforeAll(() => {
  migrate();
  const a = createApp();
  updateApp(a.id, { name: "Shop", runtime: "node" } as never);
  key = a.api_key;
  unconfiguredKey = createApp().api_key;
});

beforeEach(() => {
  deployApp.mockClear();
  setSetting("max_upload_mb", "1");
});

const leftovers = () => (existsSync(UPLOAD_DIR) ? readdirSync(UPLOAD_DIR) : []);

function block(name: string, opts: { type?: string; data?: string; linkpath?: string } = {}): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) => h.write(s.slice(0, len), off, len, "latin1");
  const data = Buffer.from(opts.data ?? "", "latin1");
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(data.length.toString(8).padStart(11, "0") + "\0", 124, 12);
  put("00000000000\0", 136, 12);
  h.fill(0x20, 148, 156);
  put(opts.type ?? "0", 156, 1);
  if (opts.linkpath) put(opts.linkpath, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([h, data, Buffer.alloc(pad)]);
}
const tarOf = (...blocks: Buffer[]) => Buffer.concat([...blocks, Buffer.alloc(1024)]);

function deploy(body: BodyInit | null, headers: Record<string, string> = {}, k = key) {
  return app.request("/api/v1/app/deploy", {
    method: "POST",
    headers: { authorization: `Bearer ${k}`, "content-type": "application/x-tar", ...headers },
    body,
    // @ts-expect-error Node's fetch wants this for stream bodies
    duplex: "half",
  });
}

function chunked(chunks: number, size: number): ReadableStream<Uint8Array> {
  let n = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (n >= chunks) return c.close();
      n += 1;
      c.enqueue(new Uint8Array(size));
    },
  });
}

describe("POST /api/v1/app/deploy upload handling", () => {
  it("passes a normal tar to the deploy pipeline as a Buffer and leaves no file behind", async () => {
    const tar = tarOf(block("Dockerfile", { data: "FROM scratch\n" }), block("src/", { type: "5" }));
    const r = await deploy(tar);
    expect(r.status).toBe(200);
    expect(deployApp).toHaveBeenCalledTimes(1);
    const arg = deployApp.mock.calls[0][0] as { tar: Buffer };
    expect(Buffer.isBuffer(arg.tar)).toBe(true);
    expect(arg.tar.equals(tar)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it("answers 413 from Content-Length alone, before reading anything", async () => {
    const r = await deploy("x", { "content-length": String(5 * 1024 * 1024) });
    expect(r.status).toBe(413);
    expect(deployApp).not.toHaveBeenCalled();
  });

  it("answers 413 for a chunked body without Content-Length once it passes the limit", async () => {
    const r = await deploy(chunked(10, 512 * 1024)); // 5 MB, no length header
    expect(r.status).toBe(413);
    expect((await r.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("exceeds limit") });
    expect(deployApp).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });

  it("answers 400 when the client hangs up midway, and cleans up", async () => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        n += 1;
        if (n > 2) c.error(new Error("socket closed"));
        else c.enqueue(new Uint8Array(1000));
      },
    });
    const r = await deploy(body);
    expect(r.status).toBe(400);
    expect(deployApp).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });

  it("answers 400 for an empty body", async () => {
    const r = await deploy(new Uint8Array(0));
    expect(r.status).toBe(400);
    expect(deployApp).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });

  it.each([
    ["path traversal", tarOf(block("../../evil", { data: "x" })), "path"],
    ["an absolute path", tarOf(block("/etc/cron.d/x", { data: "x" })), "path"],
    ["a symlink out of the project", tarOf(block("esc", { type: "2", linkpath: "/" })), "link"],
    ["a hard link to the host", tarOf(block("h", { type: "1", linkpath: "/etc/passwd" })), "link"],
    ["a device node", tarOf(block("dev", { type: "3" })), "type"],
  ])("answers 400 with a reason for %s and never deploys", async (_label, tar, code) => {
    const r = await deploy(tar);
    expect(r.status).toBe(400);
    const j = (await r.json()) as { status: string; code: string; error: string };
    expect(j.status).toBe("rejected");
    expect(j.code).toBe(code);
    expect(j.error.length).toBeGreaterThan(5);
    expect(deployApp).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });

  it("refuses a gzip upload (the contract is a plain tar) without inflating it", async () => {
    const r = await deploy(gzipSync(Buffer.alloc(40 * 1024 * 1024)));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe("compressed");
    expect(deployApp).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });

  it("keeps the existing checks: wrong content type 415, unconfigured app 409, no key 401", async () => {
    expect((await deploy("x", { "content-type": "application/json" })).status).toBe(415);
    expect((await deploy(tarOf(), {}, unconfiguredKey)).status).toBe(409);
    const anon = await app.request("/api/v1/app/deploy", { method: "POST", body: "x" });
    expect(anon.status).toBe(401);
  });
});
