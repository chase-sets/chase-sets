import {
  composeSchemaSql,
  waitForDatabase,
} from "@chase-sets/bounded-context-runtime";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { loadConfig } from "./config";
import { seedContextRuntimeIfEmpty } from "./context-lifecycle.generated";
import { createContextRuntime } from "./context-runtime.generated";

async function bootstrap() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await waitForDatabase(pool, "Catalog");
    const runtime = createContextRuntime(pool);
    await pool.query(composeSchemaSql(runtime.mountedModules.map(({ module }) => module)));
    await seedContextRuntimeIfEmpty(pool, runtime);
    console.log("Catalog projections are up to date.");
    console.log("Catalog bootstrap complete.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void bootstrap().catch((error) => {
  console.error("Catalog bootstrap failed.", error);
  process.exit(1);
});

