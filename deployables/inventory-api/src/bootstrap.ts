import { createPgPool } from "@chase-sets/event-core-postgres";
import {
  composeSchemaSql,
  drainProjectors,
  seedApiModulesIfEmpty,
  waitForDatabase,
} from "@chase-sets/bounded-context-runtime";
import { loadConfig } from "./config";
import { createContextRuntime } from "./context-runtime.generated";

async function bootstrap() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await waitForDatabase(pool, "Inventory");
    const runtime = createContextRuntime(pool);
    await pool.query(composeSchemaSql(runtime.mountedModules.map(({ module }) => module)));
    await seedApiModulesIfEmpty(runtime.mountedModules.map(({ module }) => module), pool);
    await drainProjectors(runtime.projectors);
    console.log("Inventory projections are up to date.");
    console.log("Inventory bootstrap complete.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void bootstrap().catch((error) => {
  console.error("Inventory bootstrap failed.", error);
  process.exit(1);
});
