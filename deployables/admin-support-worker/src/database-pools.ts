import { getWorkerHostContextNames, type WorkerHostContextName } from "@chase-sets/platform-runtime/worker";
import {
  closeContextPools,
  createContextPools,
  type ContextPoolRegistry,
  type ContextPools,
} from "@chase-sets/platform-runtime/context-pools";
import { getContextDatabaseEnvName, type AdminSupportWorkerConfig } from "./config";
import { workerContextRegistry } from "./generated/worker-context-registry";

const adminSupportContexts = getWorkerHostContextNames(workerContextRegistry, "admin-support-worker");

const adminSupportWorkerPoolRegistry = {
  contextNames: adminSupportContexts,
  getContextDatabaseEnvName,
} satisfies ContextPoolRegistry<WorkerHostContextName<typeof workerContextRegistry>, AdminSupportWorkerConfig>;

export function createAdminSupportWorkerPools(
  config: AdminSupportWorkerConfig,
): ContextPools<WorkerHostContextName<typeof workerContextRegistry>> {
  return createContextPools(adminSupportWorkerPoolRegistry, config);
}

export const closeAdminSupportWorkerPools = closeContextPools;
