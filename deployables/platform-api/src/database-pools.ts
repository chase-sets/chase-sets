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
import { apiContextRegistry } from "./generated/api-context-registry";

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

export class SeedCommandDirectDatabaseUrlRequiredError extends Error {
  readonly code = "SEED_COMMAND_DIRECT_DATABASE_URL_REQUIRED";

  constructor(key: string) {
    super(`SEED_COMMAND_DIRECT_DATABASE_URL_REQUIRED: ${key} must be a direct database URL for schema bootstrap.`);
    this.name = "SeedCommandDirectDatabaseUrlRequiredError";
  }
}

/** Seed commands bootstrap schemas under a session lock; ordinary API pools are transaction-pooled. */
export function selectSeedCommandDatabaseConfig<T extends PlatformApiBaseConfig>(
  config: T,
  env: Readonly<Record<string, string | undefined>> = process.env,
): T {
  const managed = ["staging", "production", "preview"].includes(config.deploymentEnvironment ?? "");
  const managedCluster = config.deploymentEnvironment === "staging" || config.deploymentEnvironment === "production";
  const contexts = getPlatformApiContextsForRuntimeProfile(config.runtimeProfile);
  const contextDatabaseUrls = { ...config.contextDatabaseUrls };

  for (const contextName of contexts) {
    const key = `BOOTSTRAP_${getContextDatabaseEnvName(contextName)}`;
    // Standalone staging jobs export direct DATABASE_URL_* values; in-pod commands
    // receive pooled runtime URLs and dedicated BOOTSTRAP_* direct URLs.
    const directUrl = env[key]?.trim() || contextDatabaseUrls[contextName] || config.sharedDatabaseUrl;
    assertSessionCompatible(directUrl, key, managedCluster);
    contextDatabaseUrls[contextName] = directUrl;
  }

  const controlKey = "BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL";
  const controlUrl = env[controlKey]?.trim() || config.controlDatabaseUrl || config.sharedDatabaseUrl;
  assertSessionCompatible(controlUrl, controlKey, managedCluster);

  return {
    ...config,
    sharedDatabaseUrl: managed ? null : config.sharedDatabaseUrl,
    contextDatabaseUrls,
    controlDatabaseUrl: controlUrl,
  };
}

function assertSessionCompatible(
  url: string | null | undefined,
  key: string,
  managedCluster: boolean,
): asserts url is string {
  // DigitalOcean's managed transaction pools use port 25061; direct cluster URLs use 25060.
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    throw new SeedCommandDirectDatabaseUrlRequiredError(key);
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.port === "25061" ||
    (managedCluster && parsed.port !== "25060")
  ) {
    throw new SeedCommandDirectDatabaseUrlRequiredError(key);
  }
}

export function createSeedCommandPools(config: PlatformApiBaseConfig) {
  return createPlatformApiPools(selectSeedCommandDatabaseConfig(config));
}
