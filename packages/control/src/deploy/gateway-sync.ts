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

/**
 * S23: every app's route now starts with a middleware that drops a visitor's
 * X-Forwarded-User. Route files are only rewritten on deploy, so apps that
 * are already running would keep trusting a forged header until someone
 * redeploys them. At startup every app that already has a route file (and is
 * not quarantined) gets its route written again from the same inputs, which
 * is idempotent.
 *
 * Skipped on purpose: apps without a route file (writing one would expose an
 * undeployed app), quarantined apps (their hosts point at the maintenance
 * page) and apps with no domain.
 */
export function needsRouteRefresh(app: App): boolean {
  return !!app.domain && app.status !== "quarantined";
}

export interface RouteRefreshDeps extends SsoRepairDeps {
  /** App ids already rewritten in this start (the SSO repair), not done twice. */
  skip?: Iterable<string>;
}

/** Returns the ids of the apps whose route was rewritten. Never throws. */
export async function refreshAppRoutes(deps: RouteRefreshDeps): Promise<string[]> {
  const skip = new Set(deps.skip ?? []);
  const done: string[] = [];
  for (const app of deps.listApps()) {
    if (skip.has(app.id) || !needsRouteRefresh(app)) continue;
    try {
      if (!(await deps.routeExists(app.id))) continue;
      await deps.writeRoute(app);
      done.push(app.id);
    } catch (err) {
      deps.log?.(`Could not refresh the route of ${app.id}: ${String(err)}`);
    }
  }
  if (done.length > 0) {
    deps.log?.(`Refreshed the gateway route of ${done.length} app(s) (X-Forwarded-User is dropped from visitors)`);
  }
  return done;
}
