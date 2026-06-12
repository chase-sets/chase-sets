import { getApiHostContextNames, type ApiHostContextName } from "@chase-sets/platform-runtime/api";
import {
  closeContextPools,
  createContextPools,
  type ContextPoolRegistry,
  type ContextPools,
} from "@chase-sets/platform-runtime/context-pools";
import { getContextDatabaseEnvName, type AdminSupportApiConfig } from "./config";
import { apiContextRegistry } from "./generated/api-context-registry";

const adminSupportContexts = getApiHostContextNames(apiContextRegistry, "admin-support-api");

const adminSupportApiPoolRegistry = {
  contextNames: adminSupportContexts,
  getContextDatabaseEnvName,
} satisfies ContextPoolRegistry<ApiHostContextName<typeof apiContextRegistry>, AdminSupportApiConfig>;

export function createAdminSupportApiPools(
  config: AdminSupportApiConfig,
): ContextPools<ApiHostContextName<typeof apiContextRegistry>> {
  return createContextPools(adminSupportApiPoolRegistry, config);
}

export const closeAdminSupportApiPools = closeContextPools;
