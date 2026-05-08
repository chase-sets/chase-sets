import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  getApiHostContextNames,
  type ApiHostContextName,
} from "@chase-sets/platform-runtime/api";
import {
  getContextDatabaseEnvName,
  type AdminSupportApiConfig,
} from "./config";
import { apiContextRegistry } from "./generated/api-context-registry";

const adminSupportContexts = getApiHostContextNames(
  apiContextRegistry,
  "admin-support-api",
);

function resolveContextDatabaseUrl(
  config: AdminSupportApiConfig,
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

export function createAdminSupportApiPools(
  config: AdminSupportApiConfig,
): Readonly<Record<ApiHostContextName<typeof apiContextRegistry>, PgTransactionalPool>> &
  Readonly<{ control: PgTransactionalPool }> {
  const poolsByDatabaseUrl = new Map<string, PgTransactionalPool>();
  const resolvePool = (databaseUrl: string) => {
    const existingPool = poolsByDatabaseUrl.get(databaseUrl);

    if (existingPool) {
      return existingPool;
    }

    const pool = createPgPool(databaseUrl, config.pool);
    poolsByDatabaseUrl.set(databaseUrl, pool);
    return pool;
  };
  const contextPools = Object.fromEntries(
    adminSupportContexts.map((contextName) => [
      contextName,
      resolvePool(resolveContextDatabaseUrl(config, contextName)),
    ]),
  ) as Readonly<Record<ApiHostContextName<typeof apiContextRegistry>, PgTransactionalPool>>;

  return {
    ...contextPools,
    control: resolvePool(config.controlDatabaseUrl),
  };
}

export async function closeAdminSupportApiPools(
  pools: Readonly<Record<string, PgTransactionalPool>>,
): Promise<void> {
  const uniquePools = [...new Set(Object.values(pools))];
  await Promise.all(
    uniquePools.map((pool) =>
      (pool as unknown as { end: () => Promise<void> }).end(),
    ),
  );
}
