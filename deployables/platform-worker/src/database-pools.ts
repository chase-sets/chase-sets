import { type WorkerHostContextName } from "@chase-sets/platform-runtime/worker";
import {
  closeContextPools,
  createContextPools,
  type ContextPoolRegistry,
  type ContextPools,
} from "@chase-sets/platform-runtime/context-pools";
import {
  getContextDatabaseEnvName,
  getPlatformWorkerContextsForRuntimeProfile,
  type PlatformWorkerConfig,
} from "./config";
import { workerContextRegistry } from "./context-registry";

const PLATFORM_IDLE_TRANSACTION_TIMEOUT_MS = 15_000;

export function createPlatformWorkerPools(
  config: PlatformWorkerConfig,
): ContextPools<WorkerHostContextName<typeof workerContextRegistry>> {
  const platformWorkerPoolRegistry = {
    contextNames: getPlatformWorkerContextsForRuntimeProfile(config.runtimeProfile),
    getContextDatabaseEnvName,
    defaultPool: {
      max: 10,
      idleTimeoutMillis: 30_000,
      idleInTransactionSessionTimeoutMillis: PLATFORM_IDLE_TRANSACTION_TIMEOUT_MS,
      connectionTimeoutMillis: 5_000,
    },
  } satisfies ContextPoolRegistry<WorkerHostContextName<typeof workerContextRegistry>, PlatformWorkerConfig>;

  return createContextPools(platformWorkerPoolRegistry, config);
}

export const closePlatformWorkerPools = closeContextPools;
