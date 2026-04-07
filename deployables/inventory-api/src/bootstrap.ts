import { createPgPool } from "@chase-sets/event-core-postgres";
import { drainContextRuntime } from "@chase-sets/bounded-context-runtime";
import { loadConfig } from "./config";
import { seedContextRuntimeIfEmpty } from "./context-lifecycle.generated";
import { createContextRuntime } from "./context-runtime.generated";

async function bootstrap() {
  const config = loadConfig();
  const pools = {
    catalog: createPgPool(config.databaseUrls.catalog),
    identity: createPgPool(config.databaseUrls.identity),
    inventory: createPgPool(config.databaseUrls.inventory),
    ordering: createPgPool(config.databaseUrls.ordering),
  } as const;

  try {
    const runtime = createContextRuntime(pools);
    await seedContextRuntimeIfEmpty(pools, runtime);
    await drainContextRuntime(runtime);
    console.log("Inventory projections are up to date.");
    console.log("Inventory bootstrap complete.");
  } finally {
    await Promise.all(
      Object.values(pools).map((pool) =>
        (pool as unknown as { end: () => Promise<void> }).end(),
      ),
    );
  }
}

void bootstrap().catch((error) => {
  console.error("Inventory bootstrap failed.", error);
  process.exit(1);
});
