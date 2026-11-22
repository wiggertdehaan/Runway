import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyDepUpdates,
  lockSyncDockerfile,
  nodeImageOf,
  parseTarListing,
  requirementFiles,
  requirementsInDockerfile,
  safeMemberName,
  type LockSync,
} from "./dep-apply.js";
import type { DepUpdate } from "./dep-updates.js";

const work = mkdtempSync(join(tmpdir(), "runway-deptest-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
/** Build a real tar from a file map; a value of `{ link }` makes a symlink. */
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
  const names = Object.keys(files).map((f) => `${prefix}${f}`);
  execFileSync("tar", ["-cf", out, "-C", dir, ...names]);
  return readFileSync(out);
}
function readMember(tar: Buffer, name: string): string {
  const p = join(work, `r${n++}.tar`);
  writeFileSync(p, tar);
  return execFileSync("tar", ["-xOf", p, name]).toString("utf8");
}
function listMembers(tar: Buffer): string[] {
  const p = join(work, `l${n++}.tar`);
  writeFileSync(p, tar);
  return execFileSync("tar", ["-tf", p]).toString("utf8").trim().split("\n");
}

const upd = (ecosystem: DepUpdate["ecosystem"], name: string, from: string, to: string, kind: DepUpdate["kind"] = "compatible"): DepUpdate => ({
  ecosystem, name, from, to, kind, cves: [`CVE-${name}`],
});
const noLockSync: LockSync = async () => {
  throw new Error("lockSync must not be called");
};
const DOCKERFILE = "FROM python:3.12-alpine\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r /app/requirements.txt\n";

describe("parseTarListing", () => {
  it("reads names and file types from tar -tvf output", () => {
    const listing = [
      "drwxr-xr-x root/root         0 2026-11-22 10:00 ./",
      "-rw-r--r-- root/root       120 2026-11-22 10:00 ./requirements.txt",
      "lrwxrwxrwx root/root         0 2026-11-22 10:00 ./package.json -> /etc/passwd",
      "hrw-r--r-- root/root         0 2026-11-22 10:00 ./copy.txt link to ./requirements.txt",
      "-rw-r--r-- 1000/1000        12 2026-11-22 10:00 my file.txt",
    ].join("\n");
    expect(parseTarListing(listing)).toEqual([
      { name: "./", path: "", regular: false },
      { name: "./requirements.txt", path: "requirements.txt", regular: true },
      { name: "./package.json", path: "package.json", regular: false },
      { name: "./copy.txt", path: "copy.txt", regular: false },
      { name: "my file.txt", path: "my file.txt", regular: true },
    ]);
  });
});

describe("manifest discovery", () => {
  it("finds requirements files, shallowest first, outside vendored trees", () => {
    const members = parseTarListing(
      [
        "-rw-r--r-- r/r 1 2026-11-22 10:00 ./api/requirements.txt",
        "-rw-r--r-- r/r 1 2026-11-22 10:00 ./requirements-runtime.txt",
        "-rw-r--r-- r/r 1 2026-11-22 10:00 ./venv/lib/requirements.txt",
        "-rw-r--r-- r/r 1 2026-11-22 10:00 ./node_modules/x/requirements.txt",
        "-rw-r--r-- r/r 1 2026-11-22 10:00 ./a/b/c/requirements.txt",
        "lrwxrwxrwx r/r 0 2026-11-22 10:00 ./requirements.txt -> /etc/shadow",
      ].join("\n")
    );
    expect(requirementFiles(members).map((m) => m.path)).toEqual(["requirements-runtime.txt", "api/requirements.txt"]);
  });
  it("reads the files a Dockerfile installs from", () => {
    expect(requirementsInDockerfile(DOCKERFILE)).toEqual(["requirements.txt"]);
    expect(requirementsInDockerfile("RUN pip install --target=/install -r requirements-runtime.txt")).toEqual(["requirements-runtime.txt"]);
    expect(requirementsInDockerfile(null)).toEqual([]);
  });
  it("picks the app's own node image for the lockfile build", () => {
    expect(nodeImageOf("FROM node:22-alpine AS deps\nRUN npm ci\nFROM node:22-alpine\n")).toBe("node:22-alpine");
    expect(nodeImageOf("FROM alpine:3.22\n")).toBe("node:24-alpine");
    expect(nodeImageOf("FROM evil.example/node:22 AS x\n")).toBe("node:24-alpine");
    expect(nodeImageOf(null)).toBe("node:24-alpine");
  });
  it("runs npm without scripts and exports only the lockfile", () => {
    const df = lockSyncDockerfile("node:22-alpine");
    expect(df).toContain("FROM node:22-alpine AS sync");
    expect(df).toContain("--package-lock-only --ignore-scripts");
    expect(df).toContain("FROM scratch");
  });
});

describe("applyDepUpdates", () => {
  it("raises a python requirement and leaves every other file untouched", async () => {
    const tar = makeTar({
      "Dockerfile": DOCKERFILE,
      "requirements.txt": "fastapi>=0.110,<1.0\nPillow>=12.2,<13.0\n",
      "app/main.py": "print('hi')\n",
    });
    const r = await applyDepUpdates(tar, [upd("python", "pillow", "12.3.0", "13.0.0", "major")], {
      appId: "a1", dockerfile: DOCKERFILE, lockSync: noLockSync,
    });
    expect(r.applied.map((u) => u.name)).toEqual(["pillow"]);
    expect(r.files).toEqual(["requirements.txt"]);
    expect(readMember(r.tar, "./requirements.txt")).toBe("fastapi>=0.110,<1.0\nPillow>=13.0.0\n");
    expect(readMember(r.tar, "./app/main.py")).toBe("print('hi')\n");
    expect(readMember(r.tar, "./Dockerfile")).toBe(DOCKERFILE);
    // Replaced, not duplicated.
    expect(listMembers(r.tar).filter((m) => m.endsWith("requirements.txt"))).toEqual(["./requirements.txt"]);
    // The stored source buffer itself is not modified.
    expect(readMember(tar, "./requirements.txt")).toContain("<13.0");
  });

  it("works for tars whose members have no ./ prefix", async () => {
    const tar = makeTar({ "requirements.txt": "pillow==12.3.0\n" }, "");
    const r = await applyDepUpdates(tar, [upd("python", "pillow", "12.3.0", "13.0.0")], {
      appId: "a1", dockerfile: null, lockSync: noLockSync,
    });
    expect(readMember(r.tar, "requirements.txt")).toBe("pillow==13.0.0\n");
    expect(listMembers(r.tar)).toEqual(["requirements.txt"]);
  });

  it("appends an unlisted package to the file the Dockerfile installs from", async () => {
    const df = "FROM python:3.12-alpine\nRUN pip install -r requirements-runtime.txt\n";
    const tar = makeTar({
      "requirements-dev.txt": "pytest\n",
      "requirements-runtime.txt": "flask==3.0.0\n",
    });
    const r = await applyDepUpdates(tar, [upd("python", "setuptools", "70.3.0", "78.1.1")], {
      appId: "a1", dockerfile: df, lockSync: noLockSync,
    });
    expect(r.files).toEqual(["requirements-runtime.txt"]);
    expect(readMember(r.tar, "./requirements-runtime.txt")).toContain("setuptools>=78.1.1");
    expect(readMember(r.tar, "./requirements-dev.txt")).toBe("pytest\n");
  });

  it("skips python updates when there is no requirements file", async () => {
    const tar = makeTar({ "pyproject.toml": "[project]\n" });
    const r = await applyDepUpdates(tar, [upd("python", "pillow", "12.3.0", "13.0.0")], {
      appId: "a1", dockerfile: null, lockSync: noLockSync,
    });
    expect(r.applied).toEqual([]);
    expect(r.tar).toBe(tar);
    expect(r.skipped[0].reason).toContain("no requirements.txt");
  });

  it("never reads or writes through a symlinked manifest", async () => {
    const tar = makeTar({ "requirements.txt": { link: "/etc/hostname" }, "package.json": { link: "/etc/hostname" } });
    const r = await applyDepUpdates(
      tar,
      [upd("python", "pillow", "12.3.0", "13.0.0"), upd("node", "qs", "6.14.2", "6.16.1")],
      { appId: "a1", dockerfile: null, lockSync: noLockSync }
    );
    expect(r.applied).toEqual([]);
    expect(r.tar).toBe(tar);
    expect(r.skipped).toHaveLength(2);
  });

  it("edits package.json alone when there is no lockfile", async () => {
    const pkg = JSON.stringify({ name: "a", dependencies: { express: "^4.21.0" } }, null, 2) + "\n";
    const tar = makeTar({ "package.json": pkg, "server.js": "//\n" });
    const r = await applyDepUpdates(tar, [upd("node", "proxy-addr", "2.0.7", "2.0.8")], {
      appId: "a1", dockerfile: "FROM node:22-alpine\n", lockSync: noLockSync,
    });
    expect(r.files).toEqual(["package.json"]);
    expect(JSON.parse(readMember(r.tar, "./package.json")).overrides).toEqual({ "proxy-addr": "^2.0.8" });
  });

  it("regenerates the lockfile from the edited package.json", async () => {
    const pkg = JSON.stringify({ name: "a", dependencies: { nodemailer: "^9.0.1" } }, null, 2) + "\n";
    const tar = makeTar({ "package.json": pkg, "package-lock.json": '{"lockfileVersion":3,"old":true}\n', ".npmrc": "fund=false\n" });
    const seen: Parameters<LockSync>[0][] = [];
    const lockSync: LockSync = async (input) => {
      seen.push(input);
      return '{"lockfileVersion":3,"new":true}\n';
    };
    const r = await applyDepUpdates(tar, [upd("node", "nodemailer", "9.0.1", "10.0.6", "major")], {
      appId: "a1", dockerfile: "FROM node:22-alpine AS deps\nRUN npm ci\n", lockSync,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].nodeImage).toBe("node:22-alpine");
    expect(JSON.parse(seen[0].packageJson).dependencies.nodemailer).toBe("^10.0.6");
    expect(seen[0].packageLock).toContain('"old":true');
    expect(seen[0].npmrc).toBe("fund=false\n");
    expect(r.files.sort()).toEqual(["package-lock.json", "package.json"]);
    expect(readMember(r.tar, "./package-lock.json")).toContain('"new":true');
  });

  it("changes nothing when the lockfile cannot be regenerated", async () => {
    const pkg = JSON.stringify({ name: "a", dependencies: { nodemailer: "^9.0.1" } });
    const tar = makeTar({ "package.json": pkg, "package-lock.json": "{}" });
    const r = await applyDepUpdates(tar, [upd("node", "nodemailer", "9.0.1", "10.0.6", "major")], {
      appId: "a1", dockerfile: null, lockSync: async () => { throw new Error("registry down"); },
    });
    expect(r.applied).toEqual([]);
    expect(r.tar).toBe(tar);
    expect(r.skipped[0].reason).toContain("registry down");
  });

  it("skips node updates for lockfiles it does not understand", async () => {
    const tar = makeTar({ "package.json": "{}", "yarn.lock": "" });
    const r = await applyDepUpdates(tar, [upd("node", "qs", "6.14.2", "6.16.1")], {
      appId: "a1", dockerfile: null, lockSync: noLockSync,
    });
    expect(r.applied).toEqual([]);
    expect(r.skipped[0].reason).toContain("yarn.lock");
  });

  it("applies python and node updates in one pass", async () => {
    const tar = makeTar({
      "requirements.txt": "pillow==12.3.0\n",
      "package.json": JSON.stringify({ dependencies: { qs: "^6.14.0" } }),
    });
    const r = await applyDepUpdates(
      tar,
      [upd("python", "pillow", "12.3.0", "13.0.0"), upd("node", "qs", "6.14.2", "6.16.1")],
      { appId: "a1", dockerfile: null, lockSync: noLockSync }
    );
    expect(r.applied.map((u) => u.name).sort()).toEqual(["pillow", "qs"]);
    expect(r.files.sort()).toEqual(["package.json", "requirements.txt"]);
  });
});

describe("untrusted member names", () => {
  it("accepts ordinary names", () => {
    for (const ok of ["requirements.txt", "./requirements.txt", "api/requirements.txt", "./a/b.c/package.json", "my file.txt"]) {
      expect(safeMemberName(ok)).toBe(true);
    }
  });
  it("rejects names tar would read as an option", () => {
    expect(safeMemberName("--to-command=sh -c id #/requirements.txt")).toBe(false);
    expect(safeMemberName("-rf")).toBe(false);
  });
  it("rejects absolute paths and parent-directory segments", () => {
    expect(safeMemberName("/etc/requirements.txt")).toBe(false);
    expect(safeMemberName("../../requirements.txt")).toBe(false);
    expect(safeMemberName("./a/../../requirements.txt")).toBe(false);
    expect(safeMemberName("")).toBe(false);
    expect(safeMemberName("a\nb")).toBe(false);
  });
  it("never treats such a member as a manifest", () => {
    const members = parseTarListing(
      [
        "-rw-r--r-- 0/0 9 2026-11-22 10:00 --to-command=touch /tmp/pwned #/requirements.txt",
        "-rw-r--r-- 0/0 9 2026-11-22 10:00 ../../requirements.txt",
        "-rw-r--r-- 0/0 9 2026-11-22 10:00 /abs/requirements.txt",
      ].join("\n")
    );
    expect(members.every((m) => !m.regular)).toBe(true);
    expect(requirementFiles(members)).toEqual([]);
  });
  it("does not run a command smuggled in as a member name", async () => {
    const marker = join(work, "pwned");
    const evil = `--to-command=touch ${marker} #`;
    // Build the tar by hand: a directory whose name is the payload.
    const dir = join(work, "evilsrc");
    mkdirSync(join(dir, evil), { recursive: true });
    writeFileSync(join(dir, evil, "requirements.txt"), "pillow==12.3.0\n");
    const out = join(work, "evil.tar");
    execFileSync("tar", ["-cf", out, "-C", dir, "--", `${evil}/requirements.txt`]);
    const tar = readFileSync(out);
    const r = await applyDepUpdates(tar, [upd("python", "pillow", "12.3.0", "13.0.0")], {
      appId: "a1", dockerfile: null, lockSync: noLockSync,
    });
    expect(r.applied).toEqual([]);
    expect(r.tar).toBe(tar);
    expect(() => readFileSync(marker)).toThrow();
  });
  it("says so when the manifest already asks for the fixed version", async () => {
    const tar = makeTar({ "requirements.txt": "setuptools>=78.1.1\n" });
    const r = await applyDepUpdates(tar, [upd("python", "setuptools", "70.3.0", "78.1.1")], {
      appId: "a1", dockerfile: null, lockSync: noLockSync,
    });
    expect(r.applied).toEqual([]);
    expect(r.tar).toBe(tar);
    expect(r.skipped[0].reason).toContain("already asks for it");
  });
});
