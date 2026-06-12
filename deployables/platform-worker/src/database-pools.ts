import { getWorkerHostContextNames, type WorkerHostContextName } from "@chase-sets/platform-runtime/worker";
import {
  closeContextPools,
  createContextPools,
  type ContextPoolRegistry,
  type ContextPools,
} from "@chase-sets/platform-runtime/context-pools";
import { getContextDatabaseEnvName, type PlatformWorkerConfig } from "./config";
import { workerContextRegistry } from "./generated/worker-context-registry";

const platformWorkerContexts = getWorkerHostContextNames(workerContextRegistry, "platform-worker");

const platformWorkerPoolRegistry = {
  contextNames: platformWorkerContexts,
  getContextDatabaseEnvName,
} satisfies ContextPoolRegistry<WorkerHostContextName<typeof workerContextRegistry>, PlatformWorkerConfig>;

export function createPlatformWorkerPools(
  config: PlatformWorkerConfig,
): ContextPools<WorkerHostContextName<typeof workerContextRegistry>> {
  return createContextPools(platformWorkerPoolRegistry, config);
}

export const closePlatformWorkerPools = closeContextPools;
