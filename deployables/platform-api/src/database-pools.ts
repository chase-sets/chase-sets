import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { getApiHostContextNames, type ApiHostContextName } from "@chase-sets/platform-runtime/api";
import { getContextDatabaseEnvName, type PlatformApiBaseConfig } from "./config";
import { apiContextRegistry } from "./generated/api-context-registry";

const platformApiContexts = getApiHostContextNames(apiContextRegistry, "platform-api");

function resolveContextDatabaseUrl(
  config: PlatformApiBaseConfig,
  contextName: ApiHostContextName<typeof apiContextRegistry>,
) {
  const contextDatabaseUrl = config.contextDatabaseUrls[contextName];

  if (contextDatabaseUrl) {
    return contextDatabaseUrl;
  }

  if (config.sharedDatabaseUrl) {
    return config.sharedDatabaseUrl;
  }

  throw new Error(
    `Missing database URL for context '${contextName}'. Set ${getContextDatabaseEnvName(contextName)} or DATABASE_URL.`,
  );
}

export function createPlatformApiPools(
  config: PlatformApiBaseConfig,
): Readonly<Record<ApiHostContextName<typeof apiContextRegistry>, PgTransactionalPool>> &
  Readonly<{ control: PgTransactionalPool }> {
  const poolsByDatabaseUrl = new Map<string, PgTransactionalPool>();
  const resolvePool = (databaseUrl: string) => {
    const existingPool = poolsByDatabaseUrl.get(databaseUrl);

    if (existingPool) {
      return existingPool;
    }

    const pool = createPgPool(databaseUrl, config.pool ?? DEFAULT_POOL_CONFIG);
    poolsByDatabaseUrl.set(databaseUrl, pool);
    return pool;
  };

  const contextPools = Object.fromEntries(
    platformApiContexts.map((contextName) => {
      const databaseUrl = resolveContextDatabaseUrl(config, contextName);
      return [contextName, resolvePool(databaseUrl)];
    }),
  ) as Readonly<Record<ApiHostContextName<typeof apiContextRegistry>, PgTransactionalPool>>;

  return {
    ...contextPools,
    control: resolvePool(
      config.controlDatabaseUrl ??
        config.sharedDatabaseUrl ??
        resolveContextDatabaseUrl(config, platformApiContexts[0]),
    ),
  };
}

const DEFAULT_POOL_CONFIG = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

export async function closePlatformApiPools(pools: Readonly<Record<string, PgTransactionalPool>>): Promise<void> {
  const uniquePools = [...new Set(Object.values(pools))];
  await Promise.all(uniquePools.map((pool) => (pool as unknown as { end: () => Promise<void> }).end()));
}
