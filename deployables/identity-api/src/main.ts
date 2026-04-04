import { serve } from "@hono/node-server";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { buildIdentityApp } from "./app";
import { loadConfig } from "./config";
import { createContextRuntime } from "./context-runtime.generated";

const config = loadConfig();
const pool = createPgPool(config.databaseUrl);
const runtime = createContextRuntime(pool);
const app = buildIdentityApp(runtime.services);

startProjectorPolling(runtime.projectors, 1_000, (error) => {
  console.error("Projection error:", error);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Identity API listening on port ${info.port}`);
});
