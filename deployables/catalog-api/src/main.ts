import { serve } from "@hono/node-server";
import { startProjectorPolling } from "../../../contracts/event-core/projector-runner";
import { createCatalogServices } from "../../../bounded-contexts/catalog/authoring";
import { loadConfig } from "./config";
import { createPool } from "./infrastructure/postgres";
import { buildCatalogApp } from "./app";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const services = createCatalogServices(pool);
const app = buildCatalogApp(services);

const PROJECTION_INTERVAL_MS = 1_000;

startProjectorPolling(services.projectors, PROJECTION_INTERVAL_MS, (error) => {
  console.error("Projection error:", error);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Catalog API listening on port ${info.port}`);
});
