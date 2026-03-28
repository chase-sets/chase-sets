import { serve } from "@hono/node-server";
import { createIdentityServices } from "@chase-sets/identity";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { buildIdentityApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const pool = createPgPool(config.databaseUrl);
const services = createIdentityServices(pool);
const app = buildIdentityApp(services);

startProjectorPolling(services.projectors, 1_000, (error) => {
  console.error("Projection error:", error);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Identity API listening on port ${info.port}`);
});
