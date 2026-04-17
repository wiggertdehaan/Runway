import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SsrfError =
  | "invalid_url"
  | "bad_scheme"
  | "bad_host"
  | "private_target"
  | "dns_failure";

export type SsrfCheckResult =
  | { ok: true }
  | { ok: false; error: SsrfError; detail?: string };

/**
 * Validate a user-supplied outbound URL (webhooks, callbacks, ...)
 * against common SSRF targets. Rejects non-https schemes, hostnames
 * that resolve to loopback / link-local / RFC1918 / CGNAT IPs, and
 * IPv6 loopback + ULA + link-local.
 *
 * DNS is re-resolved on every call: callers should invoke this once
 * on save (to reject obviously bad input early) and once more just
 * before the outbound fetch (to defeat DNS rebinding).
 */
export async function assertSafeOutboundUrl(
  raw: string
): Promise<SsrfCheckResult> {
  if (!raw || typeof raw !== "string") {
    return { ok: false, error: "invalid_url" };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "invalid_url" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, error: "bad_scheme", detail: url.protocol };
  }

  const host = url.hostname;
  if (!host) return { ok: false, error: "bad_host" };

  // Hostnames that are obviously internal even before DNS resolution.
  const lowered = host.toLowerCase();
  if (
    lowered === "localhost" ||
    lowered.endsWith(".localhost") ||
    lowered.endsWith(".internal") ||
    lowered.endsWith(".local")
  ) {
    return { ok: false, error: "private_target", detail: host };
  }

  // If the host is a literal IP, check directly; otherwise resolve.
  let addresses: { address: string; family: number }[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      return { ok: false, error: "dns_failure", detail: host };
    }
  }

  for (const a of addresses) {
    if (isPrivateIp(a.address)) {
      return { ok: false, error: "private_target", detail: a.address };
    }
  }

  return { ok: true };
}

export function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isPrivateIPv4(ip);
  if (fam === 6) return isPrivateIPv6(ip);
  return true; // not a valid IP — treat as unsafe
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lowered = ip.toLowerCase();
  if (lowered === "::" || lowered === "::1") return true;
  if (lowered.startsWith("fe8") || lowered.startsWith("fe9") ||
      lowered.startsWith("fea") || lowered.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (lowered.startsWith("fc") || lowered.startsWith("fd")) {
    return true; // fc00::/7 ULA
  }
  // IPv4-mapped: ::ffff:a.b.c.d — fall through to IPv4 check
  const mapped = lowered.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}
