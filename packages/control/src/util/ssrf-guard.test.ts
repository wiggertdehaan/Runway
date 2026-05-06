import { describe, it, expect } from "vitest";
import { isPrivateIp } from "./ssrf-guard.js";

describe("isPrivateIp — IPv4", () => {
  it("flags loopback", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.255.255.254")).toBe(true);
  });

  it("flags 0.0.0.0/8", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
    expect(isPrivateIp("0.1.2.3")).toBe(true);
  });

  it("flags RFC1918 ranges", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("172.16.5.5")).toBe(true);
    expect(isPrivateIp("172.31.255.254")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("does NOT flag 172.15 or 172.32 (just outside RFC1918)", () => {
    expect(isPrivateIp("172.15.0.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("flags link-local (incl. cloud metadata 169.254.169.254)", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    expect(isPrivateIp("169.254.0.1")).toBe(true);
  });

  it("flags CGNAT 100.64.0.0/10", () => {
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("100.127.255.254")).toBe(true);
    expect(isPrivateIp("100.63.0.1")).toBe(false); // just outside
    expect(isPrivateIp("100.128.0.1")).toBe(false); // just outside
  });

  it("flags multicast and reserved (>= 224.0.0.0)", () => {
    expect(isPrivateIp("224.0.0.1")).toBe(true);
    expect(isPrivateIp("239.255.255.255")).toBe(true);
    expect(isPrivateIp("255.255.255.255")).toBe(true);
  });

  it("allows public addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("104.21.0.1")).toBe(false);
  });
});

describe("isPrivateIp — IPv6", () => {
  it("flags IPv6 loopback", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("::")).toBe(true);
  });

  it("flags fe80::/10 link-local", () => {
    expect(isPrivateIp("fe80::1")).toBe(true);
    expect(isPrivateIp("febf:1234::abcd")).toBe(true);
  });

  it("flags fc00::/7 ULA", () => {
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fdff::abcd")).toBe(true);
  });

  it("flags IPv4-mapped addresses by underlying v4", () => {
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });

  it("allows public IPv6", () => {
    expect(isPrivateIp("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("isPrivateIp — invalid input", () => {
  it("treats non-IPs as unsafe (fail closed)", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
    expect(isPrivateIp("999.999.999.999")).toBe(true);
  });
});
