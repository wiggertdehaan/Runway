import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIDS_LIMIT,
  HARDENING_MODES,
  MAX_PIDS_LIMIT,
  MIN_PIDS_LIMIT,
  STANDARD_CAP_ADD,
  assertSafeHostConfig,
  buildHardening,
  parseHardeningMode,
  pidsLimitFromEnv,
  resolveHardening,
} from "./hardening.js";

describe("parseHardeningMode", () => {
  it("accepts the three profiles, case and whitespace insensitive", () => {
    expect(parseHardeningMode("standard")).toBe("standard");
    expect(parseHardeningMode(" STRICT ")).toBe("strict");
    expect(parseHardeningMode("Relaxed")).toBe("relaxed");
  });
  it("returns null for anything else", () => {
    for (const v of ["", "off", "none", "stricter", "relax", null, undefined]) {
      expect(parseHardeningMode(v as string | null | undefined)).toBeNull();
    }
  });
});

describe("resolveHardening", () => {
  it("defaults to standard", () => {
    expect(resolveHardening(null, {})).toEqual({ mode: "standard", source: "default" });
    expect(resolveHardening(undefined, { RUNWAY_HARDENING: "" })).toEqual({ mode: "standard", source: "default" });
  });
  it("uses the administrator's per-app profile over the instance default", () => {
    expect(resolveHardening("strict", { RUNWAY_HARDENING: "standard" })).toEqual({ mode: "strict", source: "app" });
  });
  it("uses RUNWAY_HARDENING=standard|strict as the instance default", () => {
    expect(resolveHardening(null, { RUNWAY_HARDENING: "strict" })).toEqual({ mode: "strict", source: "instance" });
  });
  it("RUNWAY_HARDENING=relaxed is an emergency brake that beats a per-app strict", () => {
    expect(resolveHardening("strict", { RUNWAY_HARDENING: "relaxed" })).toEqual({
      mode: "relaxed",
      source: "emergency-brake",
    });
    expect(resolveHardening("standard", { RUNWAY_HARDENING: "relaxed" }).mode).toBe("relaxed");
  });
  it("a per-app relaxed works without the brake", () => {
    expect(resolveHardening("relaxed", {})).toEqual({ mode: "relaxed", source: "app" });
  });
  it("a typo never turns hardening off", () => {
    expect(resolveHardening(null, { RUNWAY_HARDENING: "relax" }).mode).toBe("standard");
    expect(resolveHardening("relaxd", {}).mode).toBe("standard");
  });
});

describe("pidsLimitFromEnv", () => {
  it("defaults to 512", () => {
    expect(pidsLimitFromEnv({})).toBe(DEFAULT_PIDS_LIMIT);
    expect(DEFAULT_PIDS_LIMIT).toBe(512);
  });
  it("uses a valid value and clamps the rest", () => {
    expect(pidsLimitFromEnv({ RUNWAY_PIDS_LIMIT: "1024" })).toBe(1024);
    expect(pidsLimitFromEnv({ RUNWAY_PIDS_LIMIT: "1" })).toBe(MIN_PIDS_LIMIT);
    expect(pidsLimitFromEnv({ RUNWAY_PIDS_LIMIT: "999999" })).toBe(MAX_PIDS_LIMIT);
    expect(pidsLimitFromEnv({ RUNWAY_PIDS_LIMIT: "abc" })).toBe(DEFAULT_PIDS_LIMIT);
    expect(pidsLimitFromEnv({ RUNWAY_PIDS_LIMIT: "" })).toBe(DEFAULT_PIDS_LIMIT);
  });
});

describe("buildHardening", () => {
  it("standard drops ALL, adds back only the small list, and sets the rest", () => {
    const h = buildHardening({ mode: "standard", memoryBytes: 512 * 1024 * 1024 });
    expect(h.CapDrop).toEqual(["ALL"]);
    expect(h.CapAdd).toEqual([...STANDARD_CAP_ADD]);
    expect(h.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(h.PidsLimit).toBe(512);
    expect(h.MemorySwap).toBe(512 * 1024 * 1024);
    expect(h.LogConfig).toEqual({ Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } });
    expect(h.ReadonlyRootfs).toBeUndefined();
    expect(h.Tmpfs).toBeUndefined();
  });

  it("standard keeps NET_RAW, MKNOD, SETFCAP, SETPCAP, SYS_CHROOT out", () => {
    const h = buildHardening({ mode: "standard" });
    for (const cap of ["NET_RAW", "MKNOD", "SETFCAP", "SETPCAP", "SYS_CHROOT", "AUDIT_WRITE", "SYS_ADMIN", "NET_ADMIN"]) {
      expect(h.CapAdd).not.toContain(cap);
    }
  });

  it("strict drops ALL and adds nothing back", () => {
    const h = buildHardening({ mode: "strict" });
    expect(h.CapDrop).toEqual(["ALL"]);
    expect(h.CapAdd).toBeUndefined();
    expect(h.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(h.PidsLimit).toBe(512);
  });

  it("relaxed is Docker's capability defaults plus log rotation only", () => {
    const h = buildHardening({ mode: "relaxed", readonlyRootfs: true, memoryBytes: 1024 });
    expect(h).toEqual({ LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } } });
  });

  it("sets no swap rule when the app has no memory limit", () => {
    expect(buildHardening({ mode: "standard" }).MemorySwap).toBeUndefined();
    expect(buildHardening({ mode: "standard", memoryBytes: 0 }).MemorySwap).toBeUndefined();
  });

  it("read-only rootfs is opt-in and keeps /tmp writable", () => {
    expect(buildHardening({ mode: "standard" }).ReadonlyRootfs).toBeUndefined();
    const h = buildHardening({ mode: "strict", readonlyRootfs: true });
    expect(h.ReadonlyRootfs).toBe(true);
    expect(Object.keys(h.Tmpfs ?? {})).toEqual(["/tmp"]);
    expect(h.Tmpfs!["/tmp"]).toMatch(/size=\d+m/);
    expect(h.Tmpfs!["/tmp"]).toContain("nosuid");
  });

  it("uses a given PID limit", () => {
    expect(buildHardening({ mode: "standard", pidsLimit: 2048 }).PidsLimit).toBe(2048);
  });

  it("never produces anything assertSafeHostConfig refuses, in any combination", () => {
    for (const mode of HARDENING_MODES) {
      for (const readonlyRootfs of [false, true]) {
        for (const memoryBytes of [undefined, 256 * 1024 * 1024]) {
          const h = buildHardening({ mode, readonlyRootfs, memoryBytes });
          expect(() => assertSafeHostConfig({ NetworkMode: "runway-net-x", ...h })).not.toThrow();
        }
      }
    }
  });
});

describe("assertSafeHostConfig", () => {
  const ok = { NetworkMode: "runway-net-x", Binds: ["runway-vol-abc-data:/data"] };

  it("accepts a normal app config with a named volume", () => {
    expect(() => assertSafeHostConfig(ok)).not.toThrow();
  });

  it.each([
    ["Privileged", { Privileged: true }],
    ["host PID", { PidMode: "host" }],
    ["host IPC", { IpcMode: "host" }],
    ["host UTS", { UTSMode: "host" }],
    ["host user namespace", { UsernsMode: "host" }],
    ["host cgroup namespace", { CgroupnsMode: "host" }],
    ["host network", { NetworkMode: "host" }],
    ["another container's network", { NetworkMode: "container:runway-control" }],
    ["a mapped device", { Devices: [{ PathOnHost: "/dev/sda" }] }],
    ["Mounts", { Mounts: [{ Type: "bind", Source: "/", Target: "/host" }] }],
    ["the Docker socket as a bind", { Binds: ["/var/run/docker.sock:/var/run/docker.sock"] }],
    ["a host path as a bind", { Binds: ["/etc:/host-etc:ro"] }],
    ["a relative host path as a bind", { Binds: ["./data:/data"] }],
    ["an empty bind source", { Binds: [":/data"] }],
    ["SYS_ADMIN", { CapAdd: ["SYS_ADMIN"] }],
    ["NET_ADMIN", { CapAdd: ["NET_ADMIN"] }],
    ["ALL capabilities", { CapAdd: ["ALL"] }],
    ["NET_RAW added back", { CapAdd: ["NET_RAW"] }],
    ["unconfined seccomp", { SecurityOpt: ["seccomp=unconfined"] }],
    ["unconfined apparmor", { SecurityOpt: ["apparmor=unconfined"] }],
  ])("refuses %s", (_name, extra) => {
    expect(() => assertSafeHostConfig({ ...ok, ...extra })).toThrow(/Refusing to start an app container/);
  });

  it("allows a capability from the standard list and no-new-privileges", () => {
    expect(() =>
      assertSafeHostConfig({ ...ok, CapAdd: ["chown", "NET_BIND_SERVICE"], SecurityOpt: ["no-new-privileges:true"] })
    ).not.toThrow();
  });
});
