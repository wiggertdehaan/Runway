import type { App } from "../db/apps.js";

/**
 * Route files live in a volume and are only rewritten on deploy, so an app
 * whose route was written by an older Runway keeps the old (open) custom
 * domain router until someone redeploys it. At startup we rewrite the route
 * of every SSO app that has a custom domain, so the fix does not depend on a
 * redeploy.
 *
 * Skipped on purpose: apps that never got a route file (nothing to repair, and
 * writing one would expose an undeployed app) and quarantined apps (their hosts
 * point at the maintenance page, which must stay).
 */
export function needsSsoRouteRepair(app: App): boolean {
  return (
    !!app.sso_enabled &&
    !!app.domain &&
    !!app.custom_domain &&
    app.status !== "quarantined"
  );
}

export interface SsoRepairDeps {
  listApps: () => App[];
  routeExists: (appId: string) => Promise<boolean>;
  writeRoute: (app: App) => Promise<void>;
  log?: (msg: string) => void;
}

/** Returns the ids of the apps whose route was rewritten. Never throws. */
export async function repairSsoRoutes(deps: SsoRepairDeps): Promise<string[]> {
  const fixed: string[] = [];
  for (const app of deps.listApps()) {
    if (!needsSsoRouteRepair(app)) continue;
    try {
      if (!(await deps.routeExists(app.id))) continue;
      await deps.writeRoute(app);
      fixed.push(app.id);
    } catch (err) {
      deps.log?.(`Could not rewrite the route of ${app.id}: ${String(err)}`);
    }
  }
  if (fixed.length > 0) {
    deps.log?.(`Rewrote the gateway route of ${fixed.length} SSO app(s) with a custom domain`);
  }
  return fixed;
}
