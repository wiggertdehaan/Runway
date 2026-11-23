/**
 * S06: checks on an uploaded build context. The pure entry checks, then real
 * (hand-built, hostile) tars through the streaming inspection and the unpack.
 * tar.create refuses to write most of these on purpose, so the archives are
 * assembled byte by byte.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  checkEntry,
  extractTarSafe,
  inspectTarFile,
  tarLimits,
  UnsafeTarError,
  type TarLimits,
  type TarStats,
} from "./safe-tar.js";

const LIMITS: TarLimits = { maxBytes: 1024 * 1024, maxEntries: 50, maxPathLength: 200, maxDepth: 10 };
const fresh = (): TarStats => ({ entries: 0, bytes: 0 });

function check(entry: { path: string; type: string; size?: number; linkpath?: string }, limits = LIMITS) {
  checkEntry({ size: 0, ...entry }, fresh(), limits);
}
function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof UnsafeTarError ? e.code : `other:${String(e)}`;
  }
}

describe("checkEntry (pure)", () => {
  it("accepts ordinary files, folders and inside links", () => {
    expect(codeOf(() => check({ path: "src/index.js", type: "File", size: 10 }))).toBeNull();
    expect(codeOf(() => check({ path: "src/", type: "Directory" }))).toBeNull();
    expect(codeOf(() => check({ path: "./a/b.txt", type: "OldFile", size: 1 }))).toBeNull();
    expect(codeOf(() => check({ path: "a/link", type: "SymbolicLink", linkpath: "b.txt" }))).toBeNull();
    expect(codeOf(() => check({ path: "a/b/link", type: "SymbolicLink", linkpath: "../c.txt" }))).toBeNull();
    expect(codeOf(() => check({ path: "a/b/link", type: "SymbolicLink", linkpath: "../../c.txt" }))).toBeNull();
    expect(codeOf(() => check({ path: "copy", type: "Link", linkpath: "src/index.js" }))).toBeNull();
  });

  it.each([
    ["/etc/passwd"],
    ["\\windows\\x"],
    ["C:\\x"],
    ["C:/x"],
    ["../x"],
    ["a/../../x"],
    ["a/..\\..\\x"],
    ["a/\0b"],
    [""],
  ])("refuses the path %j", (path) => {
    expect(codeOf(() => check({ path, type: "File" }))).toBe("path");
  });

  it("limits path length and depth", () => {
    expect(codeOf(() => check({ path: "a".repeat(201), type: "File" }))).toBe("path");
    expect(codeOf(() => check({ path: Array(11).fill("d").join("/") + "/f", type: "File" }))).toBe("path");
    expect(codeOf(() => check({ path: Array(9).fill("d").join("/") + "/f", type: "File" }))).toBeNull();
  });

  it.each(["CharacterDevice", "BlockDevice", "FIFO", "SparseFile", "GNUDumpDir", "Unsupported", "ContinuationFile"])(
    "refuses entry type %s",
    (type) => {
      expect(codeOf(() => check({ path: "x", type }))).toBe("type");
    },
  );

  it("refuses symlinks that leave the project or are absolute", () => {
    expect(codeOf(() => check({ path: "link", type: "SymbolicLink", linkpath: "/etc" }))).toBe("link");
    expect(codeOf(() => check({ path: "link", type: "SymbolicLink", linkpath: "C:\\x" }))).toBe("link");
    expect(codeOf(() => check({ path: "link", type: "SymbolicLink", linkpath: ".." }))).toBe("link");
    expect(codeOf(() => check({ path: "a/link", type: "SymbolicLink", linkpath: "../.." }))).toBe("link");
    expect(codeOf(() => check({ path: "a/link", type: "SymbolicLink", linkpath: "../../etc/passwd" }))).toBe("link");
    expect(codeOf(() => check({ path: "link", type: "SymbolicLink", linkpath: "" }))).toBe("link");
  });

  it("refuses '..' after a real segment even when it looks like it stays inside", () => {
    // a/b may itself be a link back to the root: a/b/.. would then be outside.
    expect(codeOf(() => check({ path: "s", type: "SymbolicLink", linkpath: "a/b/.." }))).toBe("link");
    expect(codeOf(() => check({ path: "s", type: "SymbolicLink", linkpath: "a/../b" }))).toBe("link");
  });

  it("refuses hard links that point outside or are absolute", () => {
    expect(codeOf(() => check({ path: "h", type: "Link", linkpath: "/etc/shadow" }))).toBe("link");
    expect(codeOf(() => check({ path: "h", type: "Link", linkpath: "../x" }))).toBe("link");
    expect(codeOf(() => check({ path: "h", type: "Link", linkpath: "" }))).toBe("link");
  });

  it("counts entries and unpacked bytes", () => {
    const stats = fresh();
    const limits = { ...LIMITS, maxEntries: 3, maxBytes: 100 };
    checkEntry({ path: "a", type: "File", size: 60 }, stats, limits);
    expect(() => checkEntry({ path: "b", type: "File", size: 41 }, stats, limits)).toThrow(/unpacks to more than/);
    const s2 = fresh();
    for (const n of ["a", "b", "c"]) checkEntry({ path: n, type: "Directory", size: 0 }, s2, limits);
    expect(() => checkEntry({ path: "d", type: "Directory", size: 0 }, s2, limits)).toThrow(/more than 3 entries/);
  });

  it("refuses an invalid size", () => {
    expect(codeOf(() => check({ path: "x", type: "File", size: -1 }))).toBe("size");
    expect(codeOf(() => check({ path: "x", type: "File", size: Number.NaN }))).toBe("size");
  });

  it("does not echo control characters of a hostile name", () => {
    try {
      check({ path: "/x\u001b[31m\nred", type: "File" });
    } catch (e) {
      expect((e as Error).message).not.toMatch(/[\u001b\n]/);
    }
  });
});

describe("tarLimits", () => {
  it("uses the upload limit and sane defaults", () => {
    const l = tarLimits(123);
    expect(l.maxBytes).toBe(123);
    expect(l.maxEntries).toBeGreaterThan(1000);
    expect(l.maxPathLength).toBe(1024);
    expect(l.maxDepth).toBe(128);
  });
});

// ── a tiny ustar writer, so hostile archives can be made ─────────────────

interface TarSpec {
  name: string;
  type?: "0" | "1" | "2" | "3" | "4" | "5" | "6" | "S";
  data?: string;
  linkpath?: string;
  /** Claim this size in the header without providing the bytes. */
  claimSize?: number;
}

function header(spec: TarSpec): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) => h.write(s.slice(0, len), off, len, "latin1");
  const data = spec.data ?? "";
  const size = spec.claimSize ?? data.length;
  put(spec.name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  put("00000000000\0", 136, 12);
  h.fill(0x20, 148, 156); // checksum placeholder = spaces
  put(spec.type ?? "0", 156, 1);
  if (spec.linkpath) put(spec.linkpath, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

function makeTar(specs: TarSpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    parts.push(header(spec));
    if (spec.claimSize === undefined) {
      const data = Buffer.from(spec.data ?? "", "latin1");
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runway-safetar-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, buf: Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}
async function rejection(p: Promise<unknown>): Promise<UnsafeTarError | null> {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof UnsafeTarError) return e;
    throw e;
  }
}

describe("inspectTarFile", () => {
  it("accepts a normal project and counts it", async () => {
    const tar = makeTar([
      { name: "Dockerfile", data: "FROM scratch\n" },
      { name: "src/", type: "5" },
      { name: "src/app.js", data: "console.log(1)\n" },
      { name: "src/link", type: "2", linkpath: "app.js" },
    ]);
    const stats = await inspectTarFile(write("ok.tar", tar), LIMITS);
    expect(stats.entries).toBe(4);
    expect(stats.bytes).toBe("FROM scratch\n".length + "console.log(1)\n".length);
  });

  it("rejects path traversal and absolute paths before anything is written", async () => {
    const e1 = await rejection(inspectTarFile(write("t1.tar", makeTar([{ name: "../../evil", data: "x" }])), LIMITS));
    expect(e1?.code).toBe("path");
    const e2 = await rejection(inspectTarFile(write("t2.tar", makeTar([{ name: "/etc/cron.d/x", data: "x" }])), LIMITS));
    expect(e2?.code).toBe("path");
  });

  it("rejects a symlink out of the project, and a hardlink out of it", async () => {
    const e1 = await rejection(inspectTarFile(write("l1.tar", makeTar([{ name: "esc", type: "2", linkpath: "/" }])), LIMITS));
    expect(e1?.code).toBe("link");
    const e2 = await rejection(inspectTarFile(write("l2.tar", makeTar([{ name: "h", type: "1", linkpath: "/etc/passwd" }])), LIMITS));
    expect(e2?.code).toBe("link");
  });

  it("rejects device nodes and fifos", async () => {
    for (const type of ["3", "4", "6"] as const) {
      const e = await rejection(inspectTarFile(write(`d${type}.tar`, makeTar([{ name: "x", type }])), LIMITS));
      expect(e?.code, `type ${type}`).toBe("type");
    }
  });

  it("never sees a GNU sparse entry: the parser skips it, so it is neither counted nor unpacked", async () => {
    const p = write("sparse.tar", makeTar([{ name: "ok", data: "x" }, { name: "sp", type: "S", data: "y" }]));
    const stats = await inspectTarFile(p, LIMITS);
    expect(stats.entries).toBe(1);
    const dest = join(dir, "out-sparse");
    await extractTarSafe(p, dest, LIMITS);
    expect(existsSync(join(dest, "sp"))).toBe(false);
  });

  it("calls an archive without any entry empty or invalid", async () => {
    const e = await rejection(inspectTarFile(write("none.tar", makeTar([])), LIMITS));
    expect(e?.code).toBe("corrupt");
  });

  it("rejects too many entries", async () => {
    const specs = Array.from({ length: 60 }, (_, i) => ({ name: `f${i}`, data: "x" }));
    const e = await rejection(inspectTarFile(write("many.tar", makeTar(specs)), LIMITS));
    expect(e?.code).toBe("entries");
  });

  it("rejects a file that claims to be huge from its header alone (bomb-like), without reading it", async () => {
    // 10 GiB claimed, no data present: the size check fires on the header.
    const tar = Buffer.concat([header({ name: "big.bin", claimSize: 10 * 1024 ** 3 })]);
    const e = await rejection(inspectTarFile(write("claim.tar", tar), LIMITS));
    expect(e?.code).toBe("size");
  });

  it("rejects the total unpacked size across many small files", async () => {
    const limits = { ...LIMITS, maxBytes: 2000 };
    const specs = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: "x".repeat(600) }));
    const e = await rejection(inspectTarFile(write("sum.tar", makeTar(specs)), limits));
    expect(e?.code).toBe("size");
  });

  it("rejects a gzip-compressed upload without decompressing it", async () => {
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024)); // ~50 KB on disk, 50 MB when inflated
    expect(bomb.length).toBeLessThan(200 * 1024);
    const e = await rejection(inspectTarFile(write("bomb.tar.gz", bomb), LIMITS));
    expect(e?.code).toBe("compressed");
    const zstd = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0, 0]);
    expect((await rejection(inspectTarFile(write("z.tar", zstd), LIMITS)))?.code).toBe("compressed");
  });

  it("reports garbage as a corrupt archive, not a crash", async () => {
    const e = await rejection(inspectTarFile(write("junk.tar", Buffer.from("this is not a tar file ".repeat(100))), LIMITS));
    expect(e).toBeInstanceOf(UnsafeTarError);
    expect(e?.code).toBe("corrupt");
  });

  it("stops at the first violation even when it is followed by more data", async () => {
    const tar = makeTar([
      { name: "ok", data: "x" },
      { name: "../bad", data: "x" },
      ...Array.from({ length: 100 }, (_, i) => ({ name: `later${i}`, data: "x" })),
    ]);
    const e = await rejection(inspectTarFile(write("early.tar", tar), LIMITS));
    expect(e?.code).toBe("path");
  });
});

describe("extractTarSafe", () => {
  it("unpacks a normal project, keeping an inside symlink", async () => {
    const tar = makeTar([
      { name: "Dockerfile", data: "FROM scratch\n" },
      { name: "src/", type: "5" },
      { name: "src/app.js", data: "console.log(1)\n" },
      { name: "src/alias", type: "2", linkpath: "app.js" },
    ]);
    const dest = join(dir, "out");
    const stats = await extractTarSafe(write("ok.tar", tar), dest, LIMITS);
    expect(stats.entries).toBe(4);
    expect(readFileSync(join(dest, "Dockerfile"), "utf8")).toBe("FROM scratch\n");
    expect(readFileSync(join(dest, "src/app.js"), "utf8")).toBe("console.log(1)\n");
    expect(lstatSync(join(dest, "src/alias")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, "src/alias"))).toBe("app.js");
  });

  it("writes nothing at all for a hostile archive (traversal after a good file)", async () => {
    const dest = join(dir, "out");
    const outside = join(dir, "evil");
    const tar = makeTar([
      { name: "good.txt", data: "fine" },
      { name: "../evil", data: "owned" },
    ]);
    const e = await rejection(extractTarSafe(write("h.tar", tar), dest, LIMITS));
    expect(e?.code).toBe("path");
    expect(existsSync(outside)).toBe(false);
    // The check runs before the unpack: not even the good file is written.
    expect(existsSync(join(dest, "good.txt"))).toBe(false);
  });

  it("does not write through a symlink pointing outside (classic link-then-file attack)", async () => {
    const dest = join(dir, "out");
    const target = join(dir, "victim");
    const tar = makeTar([
      { name: "link", type: "2", linkpath: target },
      { name: "link/pwned", data: "owned" },
    ]);
    const e = await rejection(extractTarSafe(write("lw.tar", tar), dest, LIMITS));
    expect(e?.code).toBe("link");
    expect(existsSync(join(target, "pwned"))).toBe(false);
  });

  it("does not write through a relative link that escapes via '..'", async () => {
    const dest = join(dir, "out");
    const tar = makeTar([
      { name: "a/", type: "5" },
      { name: "a/up", type: "2", linkpath: "../.." },
      { name: "a/up/pwned", data: "owned" },
    ]);
    const e = await rejection(extractTarSafe(write("up.tar", tar), dest, LIMITS));
    expect(e?.code).toBe("link");
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  it("an inside link pointing at a folder does not let a later entry escape the unpack folder", async () => {
    const dest = join(dir, "out");
    const tar = makeTar([
      { name: "d/", type: "5" },
      { name: "d/back", type: "2", linkpath: ".." }, // = the project root: allowed
      { name: "d/back/ok.txt", data: "stays inside" },
    ]);
    await extractTarSafe(write("in.tar", tar), dest, LIMITS).catch(() => undefined);
    // Wherever it landed (or was refused), nothing is outside dest.
    expect(existsSync(join(dir, "ok.txt"))).toBe(false);
  });

  it("creates the destination folder when it does not exist", async () => {
    const dest = join(dir, "nested/out");
    await extractTarSafe(write("one.tar", makeTar([{ name: "a.txt", data: "a" }])), dest, LIMITS);
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("a");
  });
});
