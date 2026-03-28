import { serve } from "@hono/node-server";
import { createCatalogServices } from "@chase-sets/catalog-authoring";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { resolveActorFromIdentityApi } from "@chase-sets/identity/server";
import { loadConfig } from "./config";
import { buildCatalogApp } from "./app";

const config = loadConfig();
const pool = createPgPool(config.databaseUrl);
const services = createCatalogServices(pool);
const app = buildCatalogApp(services, {
  resolveActor: (request) =>
    resolveActorFromIdentityApi({
      identityApiBaseUrl: config.identityApiBaseUrl,
      request,
    }),
});

const PROJECTION_INTERVAL_MS = 1_000;

startProjectorPolling(services.projectors, PROJECTION_INTERVAL_MS, (error) => {
  console.error("Projection error:", error);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Catalog API listening on port ${info.port}`);
});
