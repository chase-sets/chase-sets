import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { getWorkerHostEntries } from "@chase-sets/platform-runtime/worker";
import { loadConfig } from "./config";
import { closePlatformWorkerPools, createPlatformWorkerPools } from "./database-pools";
import { workerContextRegistry } from "./generated/worker-context-registry";

const config = loadConfig();
const pools = createPlatformWorkerPools(config);

try {
  await bootstrapPlatformControlPlane(pools.control);
  const contextPools = pools as unknown as Readonly<Record<string, PgTransactionalPool | undefined>>;
  for (const context of getWorkerHostEntries(workerContextRegistry, "platform-worker", config.runtimeProfile)) {
    const pool = contextPools[context.contextName];
    if (!pool) {
      throw new Error(`Platform worker bootstrap is missing the '${context.contextName}' database pool.`);
    }
    await bootstrapContextDatabase(context.module, pool);
  }

  console.log("platform-worker bootstrap complete.");
} finally {
  await closePlatformWorkerPools(pools);
}
