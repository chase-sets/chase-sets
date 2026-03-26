import { serve } from "@hono/node-server";
import { createDiscoveryServices } from "@chase-sets/discovery";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core/postgres";
import { loadConfig } from "./config";
import { buildMarketplaceApp } from "./app";

const config = loadConfig();
const pool = createPgPool(config.databaseUrl);
const services = createDiscoveryServices(pool);
const app = buildMarketplaceApp(services);

const PROJECTION_INTERVAL_MS = 1_000;

startProjectorPolling(services.projectors, PROJECTION_INTERVAL_MS, (error) => {
  console.error("Projection error:", error);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Marketplace API listening on port ${info.port}`);
});
