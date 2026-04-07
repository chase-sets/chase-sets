import { serve } from "@hono/node-server";
import {
  drainContextRuntime,
  refreshProjectionReplaySummary,
} from "@chase-sets/bounded-context-runtime";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { buildIdentityApp } from "./app";
import { loadConfig } from "./config";
import { createContextRuntime } from "./context-runtime.generated";

const config = loadConfig();
const pools = {
  auth: createPgPool(config.databaseUrls.auth),
  identity: createPgPool(config.databaseUrls.identity),
} as const;
const runtime = createContextRuntime(pools);
const app = buildIdentityApp(runtime.services, {
  drain: () => drainContextRuntime(runtime),
  getProjectionReplay: () => refreshProjectionReplaySummary(runtime),
});

startProjectorPolling(runtime.projectors, 1_000, (error) => {
  console.error("Projection error:", error);
});
startProjectorPolling(runtime.subscriptionRunners, 1_000, (error) => {
  console.error("Subscription error:", error);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Identity API listening on port ${info.port}`);
});
