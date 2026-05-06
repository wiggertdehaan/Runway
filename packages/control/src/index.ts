import { serve } from "@hono/node-server";
import { migrate } from "./db/index.js";
import { app } from "./app.js";
import { writeDashboardRoute } from "./deploy/gateway.js";
import { deleteExpiredSessions } from "./db/sessions.js";
import { cleanupExpiredEntries } from "./middleware/rate-limit.js";
import { refreshDb } from "./deploy/scan.js";
import { startActivityTailer } from "./deploy/activity-tailer.js";
import { startPeriodicScanner } from "./deploy/periodic-scanner.js";
import { loadBuiltinSkills } from "./skills/builtin-loader.js";

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
}, 60 * 60 * 1000);
deleteExpiredSessions();

// Daily Trivy vulnerability DB refresh (every 24h, first run 60s after startup)
setTimeout(() => {
  refreshDb();
  setInterval(refreshDb, 24 * 60 * 60 * 1000);
}, 60 * 1000);

// Daily image rescan of every running app, so CVEs that the Trivy
// DB picks up after deploy still surface. Override the cadence with
// PERIODIC_SCAN_INTERVAL_HOURS for dev.
startPeriodicScanner();

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

const port = parseInt(process.env.PORT || "3000", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Runway Control running on http://localhost:${info.port}`);
});
