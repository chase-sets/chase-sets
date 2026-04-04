import { serve } from "@hono/node-server";
import { resolveActorFromAuthApi } from "@chase-sets/auth-runtime";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { loadConfig } from "./config";
import { buildCatalogApp } from "./app";
import { createContextRuntime } from "./context-runtime.generated";

const config = loadConfig();
const pool = createPgPool(config.databaseUrl);
const runtime = createContextRuntime(pool);
const app = buildCatalogApp(runtime.services.catalog, {
  resolveActor: (request) =>
    resolveActorFromAuthApi({
      authApiBaseUrl: config.identityApiBaseUrl,
      request,
    }),
});

const PROJECTION_INTERVAL_MS = 1_000;

startProjectorPolling(runtime.projectors, PROJECTION_INTERVAL_MS, (error) => {
  console.error("Projection error:", error);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Catalog API listening on port ${info.port}`);
});

