import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { createPool } from "./infrastructure/postgres";
import { createCatalogServices } from "./infrastructure/wiring";
import { buildCatalogApp } from "./app";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const services = createCatalogServices(pool);
const app = buildCatalogApp(services);

const PROJECTION_INTERVAL_MS = 1_000;

setInterval(async () => {
  for (const projector of services.projectors) {
    try {
      await projector.runOnce();
    } catch (error) {
      console.error("Projection error:", error);
    }
  }
}, PROJECTION_INTERVAL_MS);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Catalog API listening on port ${info.port}`);
});
