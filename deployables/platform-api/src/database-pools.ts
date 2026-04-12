import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  getApiHostContextNames,
  type ApiHostContextName,
} from "@chase-sets/platform-runtime/api";
import {
  getContextDatabaseEnvName,
  type PlatformApiBaseConfig,
} from "./config";
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
    `Missing database URL for context '${contextName}'. Set ${getContextDatabaseEnvName(
      contextName,
    )} or DATABASE_URL.`,
  );
}

export function createPlatformApiPools(
  config: PlatformApiBaseConfig,
): Readonly<Record<ApiHostContextName<typeof apiContextRegistry>, PgTransactionalPool>> {
  const poolsByDatabaseUrl = new Map<string, PgTransactionalPool>();

  return Object.fromEntries(
    platformApiContexts.map((contextName) => {
      const databaseUrl = resolveContextDatabaseUrl(config, contextName);
      const existingPool = poolsByDatabaseUrl.get(databaseUrl);

      if (existingPool) {
        return [contextName, existingPool];
      }

      const pool = createPgPool(databaseUrl);
      poolsByDatabaseUrl.set(databaseUrl, pool);
      return [contextName, pool];
    }),
  ) as Readonly<Record<ApiHostContextName<typeof apiContextRegistry>, PgTransactionalPool>>;
}

export async function closePlatformApiPools(
  pools: Readonly<Record<string, PgTransactionalPool>>,
): Promise<void> {
  const uniquePools = [...new Set(Object.values(pools))];
  await Promise.all(
    uniquePools.map((pool) =>
      (pool as unknown as { end: () => Promise<void> }).end(),
    ),
  );
}
