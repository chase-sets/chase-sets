import { serve } from "@hono/node-server";
import { resolveActorFromAuthApi } from "@chase-sets/auth-runtime";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { createInventoryServices } from "@chase-sets/inventory";
import { buildInventoryApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const pool = createPgPool(config.databaseUrl);
const services = createInventoryServices(pool);
const app = buildInventoryApp(services, {
  resolveActor: (request) =>
    resolveActorFromAuthApi({
      authApiBaseUrl: config.identityApiBaseUrl,
      request,
    }),
});

const PROJECTION_INTERVAL_MS = 1_000;

startProjectorPolling(services.projectors, PROJECTION_INTERVAL_MS, (error) => {
  console.error("Projection error:", error);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Inventory API listening on port ${info.port}`);
});
