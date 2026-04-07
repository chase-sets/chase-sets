import { drainContextRuntime } from "@chase-sets/bounded-context-runtime";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { loadConfig } from "./config";
import { seedContextRuntimeIfEmpty } from "./context-lifecycle.generated";
import { createContextRuntime } from "./context-runtime.generated";

async function bootstrap() {
  const config = loadConfig();
  const pools = {
    catalog: createPgPool(config.databaseUrls.catalog),
  } as const;

  try {
    const runtime = createContextRuntime(pools);
    await seedContextRuntimeIfEmpty(pools, runtime);
    await drainContextRuntime(runtime);
    console.log("Catalog projections are up to date.");
    console.log("Catalog bootstrap complete.");
  } finally {
    await Promise.all(
      Object.values(pools).map((pool) =>
        (pool as unknown as { end: () => Promise<void> }).end(),
      ),
    );
  }
}

void bootstrap().catch((error) => {
  console.error("Catalog bootstrap failed.", error);
  process.exit(1);
});

