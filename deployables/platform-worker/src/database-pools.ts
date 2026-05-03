import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  getWorkerHostContextNames,
  type WorkerHostContextName,
} from "@chase-sets/platform-runtime/worker";
import {
  getContextDatabaseEnvName,
  type PlatformWorkerConfig,
} from "./config";
import { workerContextRegistry } from "./generated/worker-context-registry";

const platformWorkerContexts = getWorkerHostContextNames(
  workerContextRegistry,
  "platform-worker",
);

function resolveContextDatabaseUrl(
  config: PlatformWorkerConfig,
  contextName: WorkerHostContextName<typeof workerContextRegistry>,
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

export function createPlatformWorkerPools(
  config: PlatformWorkerConfig,
): Readonly<Record<WorkerHostContextName<typeof workerContextRegistry>, PgTransactionalPool>> &
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
    platformWorkerContexts.map((contextName) => [
      contextName,
      resolvePool(resolveContextDatabaseUrl(config, contextName)),
    ]),
  ) as Readonly<Record<WorkerHostContextName<typeof workerContextRegistry>, PgTransactionalPool>>;

  return {
    ...contextPools,
    control: resolvePool(config.controlDatabaseUrl),
  };
}

export async function closePlatformWorkerPools(
  pools: Readonly<Record<string, PgTransactionalPool>>,
): Promise<void> {
  const uniquePools = [...new Set(Object.values(pools))];
  await Promise.all(
    uniquePools.map((pool) =>
      (pool as unknown as { end: () => Promise<void> }).end(),
    ),
  );
}
