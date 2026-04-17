import { serve } from "@hono/node-server";
import { migrate } from "./db/index.js";
import { app } from "./app.js";
import { writeDashboardRoute } from "./deploy/gateway.js";

migrate();

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
