import { resolve4 } from "node:dns/promises";

/**
 * Check if a wildcard DNS record for the base domain resolves
 * correctly. Instead of comparing against local network interfaces
 * (which show Docker internal IPs), we resolve the dashboard domain
 * to find the server's public IP and compare against that.
 */
export async function checkWildcardDns(
  baseDomain: string
): Promise<{ ok: boolean; message: string }> {
  const testHost = `_runway-check.${baseDomain}`;
  const dashboardDomain = process.env.DASHBOARD_DOMAIN;

  // Find the server's public IP by resolving the dashboard domain
  let serverIp: string | undefined;
  if (dashboardDomain) {
    try {
      const ips = await resolve4(dashboardDomain);
      serverIp = ips[0];
    } catch {
      // Can't resolve dashboard domain — skip IP comparison
    }
  }

  try {
    const resolved = await resolve4(testHost);

    if (!serverIp) {
      // Can't determine server IP, but wildcard resolves — good enough
      return { ok: true, message: `Wildcard DNS resolves to ${resolved[0]}.` };
    }

    if (resolved.includes(serverIp)) {
      return {
        ok: true,
        message: `Wildcard DNS is correctly configured (${resolved[0]} matches this server).`,
      };
    }

    return {
      ok: false,
      message: `*.${baseDomain} resolves to ${resolved.join(", ")} but this server is ${serverIp}. Update your DNS records.`,
    };
  } catch (err: any) {
    if (err.code === "ENOTFOUND" || err.code === "ENODATA") {
      return {
        ok: false,
        message: `*.${baseDomain} does not resolve. Add a wildcard DNS A record pointing to this server${serverIp ? ` (${serverIp})` : ""}.`,
      };
    }
    return {
      ok: false,
      message: `DNS check failed: ${err.message}`,
    };
  }
}
