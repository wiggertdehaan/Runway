import { getSetting } from "../db/settings.js";
import { assertSafeOutboundUrl } from "./ssrf-guard.js";

export async function notifyDeployFailure(
  appName: string,
  appId: string,
  error: string
): Promise<void> {
  const url = getSetting("webhook_url");
  if (!url) return;

  // Re-validate just before fetch to defeat DNS rebinding — a hostname
  // that passed validation at save time could now resolve to an
  // internal IP.
  const check = await assertSafeOutboundUrl(url);
  if (!check.ok) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Deploy failed for ${appName || appId}: ${error}`,
        app_id: appId,
        app_name: appName,
        error,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Best-effort — don't let webhook failures break deploys
  }
}
