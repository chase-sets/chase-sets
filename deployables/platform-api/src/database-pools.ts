import { type ApiHostContextName } from "@chase-sets/platform-runtime/api";
import {
  closeContextPools,
  createContextPools,
  type ContextPoolRegistry,
  type ContextPools,
} from "@chase-sets/platform-runtime/context-pools";
import {
  getContextDatabaseEnvName,
  getPlatformApiContextsForRuntimeProfile,
  type PlatformApiBaseConfig,
} from "./config";
import { apiContextRegistry } from "./context-registry";

const PLATFORM_IDLE_TRANSACTION_TIMEOUT_MS = 15_000;

export function createPlatformApiPools(
  config: PlatformApiBaseConfig,
): ContextPools<ApiHostContextName<typeof apiContextRegistry>> {
  const platformApiPoolRegistry = {
    contextNames: getPlatformApiContextsForRuntimeProfile(config.runtimeProfile),
    getContextDatabaseEnvName,
    defaultPool: {
      max: 10,
      idleTimeoutMillis: 30_000,
      idleInTransactionSessionTimeoutMillis: PLATFORM_IDLE_TRANSACTION_TIMEOUT_MS,
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

  return createContextPools(platformApiPoolRegistry, config);
}

export const closePlatformApiPools = closeContextPools;
