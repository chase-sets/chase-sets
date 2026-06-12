import { getApiHostContextNames, type ApiHostContextName } from "@chase-sets/platform-runtime/api";
import {
  closeContextPools,
  createContextPools,
  type ContextPoolRegistry,
  type ContextPools,
} from "@chase-sets/platform-runtime/context-pools";
import { getContextDatabaseEnvName, type PlatformApiBaseConfig } from "./config";
import { apiContextRegistry } from "./generated/api-context-registry";

const platformApiContexts = getApiHostContextNames(apiContextRegistry, "platform-api");

const platformApiPoolRegistry = {
  contextNames: platformApiContexts,
  getContextDatabaseEnvName,
  defaultPool: {
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  },
  resolveControlDatabaseUrl: ({ config, contextNames, resolveContextDatabaseUrl }) => {
    const firstContextName = contextNames[0];
    if (config.controlDatabaseUrl) {
      return config.controlDatabaseUrl;
    }
    if (config.sharedDatabaseUrl) {
      return config.sharedDatabaseUrl;
    }
    if (!firstContextName) {
      throw new Error("Platform API has no registered contexts to use as a control database fallback.");
    }

    return resolveContextDatabaseUrl(firstContextName);
  },
} satisfies ContextPoolRegistry<ApiHostContextName<typeof apiContextRegistry>, PlatformApiBaseConfig>;

export function createPlatformApiPools(
  config: PlatformApiBaseConfig,
): ContextPools<ApiHostContextName<typeof apiContextRegistry>> {
  return createContextPools(platformApiPoolRegistry, config);
}

export const closePlatformApiPools = closeContextPools;
