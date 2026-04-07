import { createPgPool } from "@chase-sets/event-core-postgres";
import { drainContextRuntime } from "@chase-sets/bounded-context-runtime";
import { loadConfig } from "./config";
import { seedContextRuntimeIfEmpty } from "./context-lifecycle.generated";
import { createContextRuntime } from "./context-runtime.generated";

const config = loadConfig();
const pools = {
  auth: createPgPool(config.databaseUrls.auth),
  identity: createPgPool(config.databaseUrls.identity),
} as const;

const runtime = createContextRuntime(pools);

seedContextRuntimeIfEmpty(pools, runtime)
  .then(async () => {
    await drainContextRuntime(runtime);
    console.log("Identity runtime seeded.");
  })
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() =>
    Promise.all(
      Object.values(pools).map((pool) =>
        (pool as unknown as { end: () => Promise<void> }).end(),
      ),
    ),
  );
