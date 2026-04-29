import { randomUUID } from "node:crypto";
import type { BcApiModule, BcProjector } from "@chase-sets/bounded-context-module";
import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  seedApiModuleIfEmpty,
  syncContextProjectionGroups,
  type ContextProjectionGroup,
  type ContextSubscriptionRunner,
  type MountedContextRuntimeEntry,
} from "./index";
import {
  createOwnedDatabaseUrl,
  ensureOwnedPostgresDatabases,
  parseOwnedDatabaseUrl,
} from "./provisioning";

type QueryablePool = PgTransactionalPool & {
  query: <TRow = unknown>(
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: TRow[] }>;
};

const testDatabaseExtensions: Readonly<Record<string, readonly string[]>> = {
  discovery: ["vector"],
};

export function createMultiContextTestDatabaseName(
  scope: string,
  contextName: string,
): string {
  const normalizedScope = scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  const normalizedContext = contextName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 16);

  return `${normalizedScope}_${normalizedContext}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

export function createMultiContextTestDatabaseUrls<
  TContextName extends string,
>(
  adminDatabaseUrl: string,
  contextNames: readonly TContextName[],
  scope: string,
): Readonly<Record<TContextName, string>> {
  return Object.fromEntries(
    contextNames.map((contextName) => {
      const databaseName = createMultiContextTestDatabaseName(scope, contextName);
      return [
        contextName,
        createOwnedDatabaseUrl(
          adminDatabaseUrl,
          databaseName,
          databaseName,
        ),
      ];
    }),
  ) as Readonly<Record<TContextName, string>>;
}

export async function ensureMultiContextTestDatabases(
  adminDatabaseUrl: string,
  databaseUrls: Readonly<Record<string, string>>,
): Promise<void> {
  const adminPool = createPgPool(adminDatabaseUrl) as QueryablePool;

  try {
    await ensureOwnedPostgresDatabases(adminPool, databaseUrls);
  } finally {
    await (adminPool as unknown as { end: () => Promise<void> }).end();
  }

  for (const [contextName, databaseUrl] of Object.entries(databaseUrls)) {
    const spec = parseOwnedDatabaseUrl(databaseUrl);
    const extensions =
      testDatabaseExtensions[contextName] ??
      testDatabaseExtensions[spec.roleName] ??
      [];

    if (extensions.length === 0) {
      continue;
    }

    const extensionAdminUrl = new URL(adminDatabaseUrl);
    extensionAdminUrl.pathname = `/${spec.databaseName}`;

    const extensionPool = createPgPool(extensionAdminUrl.toString()) as QueryablePool;

    try {
      for (const extensionName of extensions) {
        await extensionPool.query(`CREATE EXTENSION IF NOT EXISTS "${extensionName}"`);
      }
    } finally {
      await (extensionPool as unknown as { end: () => Promise<void> }).end();
    }
  }
}

export function createMultiContextTestPools<TContextName extends string>(
  databaseUrls: Readonly<Record<TContextName, string>>,
): Readonly<Record<TContextName, PgTransactionalPool>> {
  return Object.fromEntries(
    (Object.entries(databaseUrls) as [TContextName, string][]).map(([contextName, databaseUrl]) => [
      contextName,
      createPgPool(databaseUrl),
    ]),
  ) as Readonly<Record<TContextName, PgTransactionalPool>>;
}

export async function resetMultiContextTestSchemas(
  pools: Readonly<Record<string, PgTransactionalPool>>,
): Promise<void> {
  await Promise.all(
    Object.values(pools).map((pool) =>
      (pool as QueryablePool).query(
        "DROP OWNED BY CURRENT_USER CASCADE; GRANT ALL PRIVILEGES ON SCHEMA public TO CURRENT_USER;",
      ),
    ),
  );
}

export async function closeMultiContextTestPools(
  pools: Readonly<Record<string, PgTransactionalPool>>,
): Promise<void> {
  await Promise.all(
    Object.values(pools).map((pool) =>
      (pool as unknown as { end: () => Promise<void> }).end(),
    ),
  );
}

export type MountedContextTestDefinition<
  TContextName extends string = string,
  TServices = unknown,
  TPool = PgTransactionalPool,
  TPorts = unknown,
> = Readonly<{
  contextName: TContextName;
  mountRole?: "active" | "source-only";
  module: BcApiModule<TServices, TPool, TPorts>;
  pool: TPool;
  ports:
    | TPorts
    | ((services: Readonly<Record<string, unknown>>) => TPorts);
}>;

export type MountedContextTestRuntime<
  TDefinitions extends readonly MountedContextTestDefinition[] = readonly MountedContextTestDefinition[],
> = Readonly<{
  mountedContexts: readonly MountedContextRuntimeEntry[];
  services: Readonly<Record<TDefinitions[number]["contextName"], unknown>>;
  projectors: readonly BcProjector[];
  projectionGroups: readonly ContextProjectionGroup[];
  subscriptionRunners: readonly ContextSubscriptionRunner[];
}>;

export function createMountedContextTestRuntime<
  const TDefinitions extends readonly MountedContextTestDefinition[],
>(
  definitions: TDefinitions,
): MountedContextTestRuntime<TDefinitions> {
  const resolvedServices: Record<string, unknown> = {};
  const mountedContexts: MountedContextRuntimeEntry[] = [];

  for (const definition of definitions) {
    const ports =
      typeof definition.ports === "function"
        ? definition.ports(resolvedServices)
        : definition.ports;
    const services = definition.module.createServices(definition.pool, ports);
    const mountRole = definition.mountRole ?? "active";

    resolvedServices[definition.contextName] = services;
    mountedContexts.push({
      contextName: definition.contextName,
      mountRole,
      module: definition.module,
      services,
      pool: definition.pool,
      projectors:
        mountRole === "source-only"
          ? []
          : definition.module.projectors(services),
    } satisfies MountedContextRuntimeEntry);
  }

  const subscriptionRunners = resolveModuleSubscriptions(mountedContexts);
  const projectionGroups = resolveModuleProjectionGroups(
    mountedContexts,
    subscriptionRunners,
  );

  return {
    mountedContexts,
    services: resolvedServices as Readonly<Record<TDefinitions[number]["contextName"], unknown>>,
    projectors: mountedContexts
      .filter((entry) => entry.mountRole !== "source-only")
      .flatMap((entry) => entry.projectors),
    projectionGroups,
    subscriptionRunners,
  };
}

export async function seedMountedContextTestRuntimeIfEmpty(
  runtime: MountedContextTestRuntime,
  lifecycleContextOrder: readonly string[],
): Promise<void> {
  const mountedContextsByName = new Map(
    runtime.mountedContexts.map((entry) => [entry.contextName, entry]),
  );

  for (const context of runtime.mountedContexts) {
    await bootstrapContextDatabase(context.module, context.pool);
  }

  for (const contextName of lifecycleContextOrder) {
    const context = mountedContextsByName.get(contextName);
    if (!context) {
      throw new Error(
        `Runtime is missing mounted context '${contextName}' required by the test lifecycle order.`,
      );
    }

    await syncContextProjectionGroups(runtime, context.contextName, {
      requiredOnly: true,
    });
    await seedApiModuleIfEmpty(context.module, context.pool, context.services);
    await syncContextProjectionGroups(runtime, context.contextName);
    await drainContextRuntime(runtime);
  }

  await drainContextRuntime(runtime);
}
