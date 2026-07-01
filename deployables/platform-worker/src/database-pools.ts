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
import { workerContextRegistry } from "./generated/worker-context-registry";

export function createPlatformWorkerPools(
  config: PlatformWorkerConfig,
): ContextPools<WorkerHostContextName<typeof workerContextRegistry>> {
  const platformWorkerPoolRegistry = {
    contextNames: getPlatformWorkerContextsForRuntimeProfile(config.runtimeProfile),
    getContextDatabaseEnvName,
  } satisfies ContextPoolRegistry<WorkerHostContextName<typeof workerContextRegistry>, PlatformWorkerConfig>;

  return createContextPools(platformWorkerPoolRegistry, config);
}

export const closePlatformWorkerPools = closeContextPools;
