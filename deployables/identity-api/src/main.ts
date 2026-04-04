import { serve } from "@hono/node-server";
import { createAuthServices } from "@chase-sets/auth";
import { createIdentityServices } from "@chase-sets/identity";
import { startProjectorPolling } from "@chase-sets/event-core/projector-runner";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { buildIdentityApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const pool = createPgPool(config.databaseUrl);
const identity = createIdentityServices(pool);
const auth = createAuthServices(pool, identity);
const app = buildIdentityApp({ auth, identity });

startProjectorPolling([...identity.projectors, ...auth.projectors], 1_000, (error) => {
  console.error("Projection error:", error);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Identity API listening on port ${info.port}`);
});
