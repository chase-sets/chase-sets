import { serve } from "@hono/node-server";
import { resolveActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  drainContextRuntime,
  refreshProjectionReplaySummary,
} from "@chase-sets/bounded-context-runtime";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { loadConfig } from "./config";
import { buildCatalogApp } from "./app";
import { createContextRuntime } from "./context-runtime.generated";

const config = loadConfig();
const pools = {
  catalog: createPgPool(config.databaseUrls.catalog),
} as const;
const runtime = createContextRuntime(pools);
const app = buildCatalogApp(runtime.services.catalog, {
  drain: () => drainContextRuntime(runtime),
  getProjectionReplay: () => refreshProjectionReplaySummary(runtime),
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
startProjectorPolling(runtime.subscriptionRunners, PROJECTION_INTERVAL_MS, (error) => {
  console.error("Subscription error:", error);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Catalog API listening on port ${info.port}`);
});

