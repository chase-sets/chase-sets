import { createPgPool, type PgPoolOptions, type PgTransactionalPool } from "@chase-sets/event-core-postgres";

export type ContextPoolConfig<TContextName extends string> = Readonly<{
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl?: string | null;
  workSignalDatabaseUrl?: string | null;
  contextDatabaseUrls: Readonly<Partial<Record<TContextName, string>>>;
  contextWaiterDatabaseUrls?: Readonly<Partial<Record<TContextName, string>>>;
  pool?: PgPoolOptions;
}>;

export type ContextPools<TContextName extends string> = Readonly<Record<TContextName, PgTransactionalPool>> &
  Readonly<{
    control: PgTransactionalPool;
    workSignal: PgTransactionalPool;
    contextWaiters: Readonly<Record<TContextName, PgTransactionalPool>>;
  }>;

export type ContextPoolRegistry<
  TContextName extends string,
  TConfig extends ContextPoolConfig<TContextName> = ContextPoolConfig<TContextName>,
> = Readonly<{
  contextNames: readonly TContextName[];
  getContextDatabaseEnvName: (contextName: TContextName) => string;
  defaultPool?: PgPoolOptions;
  resolveControlDatabaseUrl?: (input: {
    config: TConfig;
    contextNames: readonly TContextName[];
    resolveContextDatabaseUrl: (contextName: TContextName) => string;
  }) => string;
}>;

export function createContextPools<TContextName extends string, TConfig extends ContextPoolConfig<TContextName>>(
  contextRegistry: ContextPoolRegistry<TContextName, TConfig>,
  config: TConfig,
): ContextPools<TContextName> {
  const poolsByDatabaseUrl = new Map<string, PgTransactionalPool>();
  const poolOptions = { ...contextRegistry.defaultPool, ...config.pool };
  const resolvePool = (databaseUrl: string) => {
    const existingPool = poolsByDatabaseUrl.get(databaseUrl);

    if (existingPool) {
      return existingPool;
    }

    const pool = createPgPool(databaseUrl, poolOptions);
    poolsByDatabaseUrl.set(databaseUrl, pool);
    return pool;
  };
  const resolveContextDatabaseUrl = (contextName: TContextName) => {
    const contextDatabaseUrl = config.contextDatabaseUrls[contextName];

    if (contextDatabaseUrl) {
      return contextDatabaseUrl;
    }

    if (config.sharedDatabaseUrl) {
      return config.sharedDatabaseUrl;
    }

    throw new Error(
      `Missing database URL for context '${contextName}'. Set ${contextRegistry.getContextDatabaseEnvName(
        contextName,
      )} or DATABASE_URL.`,
    );
  };
  const contextPools = Object.fromEntries(
    contextRegistry.contextNames.map((contextName) => [
      contextName,
      resolvePool(resolveContextDatabaseUrl(contextName)),
    ]),
  ) as Readonly<Record<TContextName, PgTransactionalPool>>;
  const contextWaiters = Object.fromEntries(
    contextRegistry.contextNames.map((contextName) => [
      contextName,
      resolvePool(config.contextWaiterDatabaseUrls?.[contextName] ?? resolveContextDatabaseUrl(contextName)),
    ]),
  ) as Readonly<Record<TContextName, PgTransactionalPool>>;

  const controlDatabaseUrl = resolveControlDatabaseUrl(contextRegistry, config, resolveContextDatabaseUrl);
  const controlPool = resolvePool(controlDatabaseUrl);

  return {
    ...contextPools,
    control: controlPool,
    workSignal: resolvePool(config.workSignalDatabaseUrl ?? controlDatabaseUrl),
    contextWaiters,
  };
}

export async function closeContextPools(pools: Readonly<Record<string, unknown>>): Promise<void> {
  const contextWaiters =
    "contextWaiters" in pools
      ? Object.values(pools.contextWaiters as Readonly<Record<string, PgTransactionalPool>>)
      : [];
  const uniquePools = [...new Set([...Object.values(pools), ...contextWaiters])].filter(isPgTransactionalPool);
  await Promise.all(uniquePools.map((pool) => (pool as PgTransactionalPool & { end: () => Promise<void> }).end()));
}

function isPgTransactionalPool(value: unknown): value is PgTransactionalPool {
  return Boolean(value && typeof value === "object" && "query" in value && "connect" in value);
}

function resolveControlDatabaseUrl<TContextName extends string, TConfig extends ContextPoolConfig<TContextName>>(
  contextRegistry: ContextPoolRegistry<TContextName, TConfig>,
  config: TConfig,
  resolveContextDatabaseUrl: (contextName: TContextName) => string,
): string {
  if (contextRegistry.resolveControlDatabaseUrl) {
    return contextRegistry.resolveControlDatabaseUrl({
      config,
      contextNames: contextRegistry.contextNames,
      resolveContextDatabaseUrl,
    });
  }

  if (config.controlDatabaseUrl) {
    return config.controlDatabaseUrl;
  }

  throw new Error(
    "Missing database URL for platform control-plane. Set PLATFORM_CONTROL_DATABASE_URL or DATABASE_URL.",
  );
}
