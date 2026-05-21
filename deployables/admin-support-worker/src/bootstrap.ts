import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { loadConfig } from "./config";
import { closeAdminSupportWorkerPools, createAdminSupportWorkerPools } from "./database-pools";
import { workerContextRegistry } from "./generated/worker-context-registry";

const config = loadConfig();
const pools = createAdminSupportWorkerPools(config);

try {
  await bootstrapPlatformControlPlane(pools.control);
  const runtime = createWorkerHost(workerContextRegistry, "admin-support-worker", { pools });

  for (const context of runtime.mountedContexts) {
    await bootstrapContextDatabase(context.module, context.pool);
  }

  console.log("Admin support worker bootstrap complete.");
} finally {
  await closeAdminSupportWorkerPools(pools);
}
