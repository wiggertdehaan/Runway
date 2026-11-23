import { serve } from "@hono/node-server";
import { migrate } from "./db/index.js";
import { app } from "./app.js";
import {
  writeDashboardRoute,
  writeAppRoute,
  appRouteExists,
  appBasicAuth,
} from "./deploy/gateway.js";
import { repairSsoRoutes } from "./deploy/gateway-sync.js";
import { listApps } from "./db/apps.js";
import { appContainerName } from "./deploy/index.js";
import { deleteExpiredSessions } from "./db/sessions.js";
import { cleanupExpiredEntries } from "./middleware/rate-limit.js";
import { sweepTokenLimits } from "./middleware/token-limit.js";
import { pruneAttempts } from "./auth/twofa-limit.js";
import { pruneApiAudit } from "./db/audit.js";
import { refreshDb } from "./deploy/scan.js";
import { startActivityTailer } from "./deploy/activity-tailer.js";
import { startPeriodicScanner } from "./deploy/periodic-scanner.js";
import { startCachePruner } from "./deploy/cache-pruner.js";
import { startRebuildScheduler } from "./deploy/rebuild-scheduler.js";
import { startQuarantineMonitor } from "./deploy/quarantine.js";
import { startHealthWatch } from "./deploy/health-watch.js";
import { pruneEvents } from "./db/events.js";
import { loadBuiltinSkills } from "./skills/builtin-loader.js";
import { cleanupStaleUploads } from "./deploy/upload.js";
import { docker } from "./deploy/docker.js";
import { startGatewayNetworkReconciler, type NetworkDocker } from "./deploy/networks.js";

migrate();
loadBuiltinSkills();

// Tail Traefik's access log so the dashboard can show per-app
// activity (idle vs active) and a 7-day request sparkline. No-op
// when the log file is absent (dev / first boot).
startActivityTailer();

// Hourly housekeeping
setInterval(() => {
  deleteExpiredSessions();
  cleanupExpiredEntries();
  sweepTokenLimits();
  pruneAttempts();
  pruneApiAudit();
  pruneEvents();
}, 60 * 60 * 1000);
deleteExpiredSessions();
pruneApiAudit();
pruneEvents();

// Deploy uploads are removed by the deploy itself; this catches what a crash
// in the middle of an upload left in the upload folder.
void cleanupStaleUploads().then((n) => {
  if (n > 0) console.log(`Removed ${n} stale upload file(s)`);
});

// Daily Trivy vulnerability DB refresh (every 24h, first run 60s after startup)
setTimeout(() => {
  refreshDb();
  setInterval(refreshDb, 24 * 60 * 60 * 1000);
}, 60 * 1000);

// Daily image rescan of every running app, so CVEs that the Trivy
// DB picks up after deploy still surface. Override the cadence with
// PERIODIC_SCAN_INTERVAL_HOURS for dev.
startPeriodicScanner();

// Weekly BuildKit cache eviction. Image-level retention covers loaded
// images; this covers the builder side, which is what fills disk fastest
// on busy installs.
startCachePruner();

// Weekly automatic rebuild of apps with exploited / fixable-critical
// vulnerabilities (Sunday 05:00 Europe/Amsterdam by default).
startRebuildScheduler();

// KEV quarantine: minute tick evaluating running apps against the CISA
// KEV list (term, final rebuild attempt, quarantine, automatic return).
startQuarantineMonitor();

// A change in whether a running app is healthy becomes an event (one look a
// minute, a change believed after three). HEALTH_WATCH_INTERVAL_MS=0 turns it off.
startHealthWatch();

const dashboardDomain = process.env.DASHBOARD_DOMAIN;
if (dashboardDomain) {
  try {
    await writeDashboardRoute(dashboardDomain);
    console.log(`Wrote Traefik dashboard route for ${dashboardDomain}`);
  } catch (err) {
    console.error("Failed to write gateway dashboard route:", err);
  }
} else {
  console.warn(
    "DASHBOARD_DOMAIN not set; skipping Traefik dashboard route bootstrap."
  );
}

// Routes written by an older version leave an SSO app's custom domain open;
// rewrite them now so the fix does not wait for the next deploy.
try {
  await repairSsoRoutes({
    listApps,
    routeExists: appRouteExists,
    writeRoute: (a) =>
      writeAppRoute({
        appId: a.id,
        containerName: appContainerName(a.id),
        domain: a.domain!,
        customDomain: a.custom_domain,
        port: a.port,
        basicAuth: appBasicAuth(a),
        ssoEnabled: !!a.sso_enabled,
      }),
    log: (m) => console.log(m),
  });
} catch (err) {
  console.error("SSO route repair failed:", err);
}

// Each app has its own network; the gateway is attached to them at runtime, so
// recreating the gateway container (docker compose up) detaches it from all of
// them. Reattach at startup and every minute, and sweep networks of deleted apps.
startGatewayNetworkReconciler({
  docker: docker as unknown as NetworkDocker,
  appIds: () => new Set(listApps().map((a) => a.id)),
  log: (m) => console.log(m),
});

const port = parseInt(process.env.PORT || "3000", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Runway Control running on http://localhost:${info.port}`);
});
