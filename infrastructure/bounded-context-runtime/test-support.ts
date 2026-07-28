import { randomUUID } from "node:crypto";
import type { BcApiModule, BcSeedOptions } from "@chase-sets/bounded-context-module";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { Hono } from "hono";
import { afterEach, vi } from "vitest";
import {
  bootstrapContextDatabase,
  createProjectionAwarePool,
  drainContextRuntime,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  seedApiModuleIfEmpty,
  syncContextProjectionGroups,
  type ContextProjectionGroup,
  type ContextSubscriptionRunner,
  type MountedContextRuntimeEntry,
} from "./index";
import { createOwnedDatabaseUrl, ensureOwnedPostgresDatabases, parseOwnedDatabaseUrl } from "./provisioning";

type TestHonoEnv = {
  Variables: {
    actor: unknown;
    context: unknown;
  };
};

export type TestResolvedActor = Readonly<{
  sessionId: string;
  tenantId: string;
  userId: string;
  accountId: string;
  membershipId: string;
  roleKey: string;
  permissions: readonly string[];
}>;

export type TestActorOverrides = Partial<TestResolvedActor>;

export type TestRequestContext = Readonly<{
  actor: TestResolvedActor | null;
  context: EventStoreContext | null;
}>;

export type TestEventStoreContextOverrides = Readonly<{
  tenantId?: string;
  performedByUserId?: string;
  forAccountId?: string;
  trace?: EventStoreContext["trace"];
}>;

export type CreateTestAppOptions<TEnv extends TestHonoEnv> = Readonly<{
  actor: TEnv["Variables"]["actor"];
  context?: TEnv["Variables"]["context"] | ((actor: TEnv["Variables"]["actor"]) => TEnv["Variables"]["context"]);
  routes: (app: Hono<TEnv>) => void;
}>;

type MockResetTarget = Readonly<{
  mockReset: () => unknown;
}>;

const testSchemaResetConcurrency = 2;
const testDatabaseExtensions: Readonly<Record<string, readonly string[]>> = {
  discovery: ["vector"],
};

export function createAnonymousTestActor(): null {
  return null;
}

export function createAccountUserTestActor(overrides: TestActorOverrides = {}): TestResolvedActor {
  return {
    sessionId: "ses_test",
    tenantId: "tnt_identity",
    userId: "usr_test",
    accountId: "acc_test",
    membershipId: "mbr_test",
    roleKey: "owner",
    permissions: ["accounts.view", "accounts.manage"],
    ...overrides,
  };
}

export function createAdminTestActor(overrides: TestActorOverrides = {}): TestResolvedActor {
  return createAccountUserTestActor({
    sessionId: "ses_admin",
    userId: "usr_admin",
    accountId: "acc_admin",
    membershipId: "mbr_admin",
    roleKey: "platform-admin",
    permissions: ["accounts.view", "accounts.manage", "security.manage", "support.manage"],
    ...overrides,
  });
}

export function createInternalSystemTestActor(overrides: TestActorOverrides = {}): TestResolvedActor {
  return createAccountUserTestActor({
    sessionId: "system:test",
    userId: "usr_system",
    accountId: "acc_system",
    membershipId: "mbr_system",
    roleKey: "system",
    permissions: ["system"],
    ...overrides,
  });
}

export function createTestEventStoreContext(
  actor: TestResolvedActor,
  overrides: TestEventStoreContextOverrides = {},
): EventStoreContext {
  return {
    tenantId: (overrides.tenantId ?? actor.tenantId) as never,
    audit: {
      performedByUserId: (overrides.performedByUserId ?? actor.userId) as never,
      forAccountId: (overrides.forAccountId ?? actor.accountId) as never,
    },
    ...(overrides.trace !== undefined ? { trace: overrides.trace } : {}),
  };
}

export function createAnonymousTestRequestContext(): TestRequestContext {
  return {
    actor: createAnonymousTestActor(),
    context: null,
  };
}

export function createAccountUserTestRequestContext(
  options: Readonly<{
    actor?: TestActorOverrides;
    context?: TestEventStoreContextOverrides;
  }> = {},
): TestRequestContext {
  const actor = createAccountUserTestActor(options.actor);

  return {
    actor,
    context: createTestEventStoreContext(actor, options.context),
  };
}

export function createAdminTestRequestContext(
  options: Readonly<{
    actor?: TestActorOverrides;
    context?: TestEventStoreContextOverrides;
  }> = {},
): TestRequestContext {
  const actor = createAdminTestActor(options.actor);

  return {
    actor,
    context: createTestEventStoreContext(actor, options.context),
  };
}

export function createInternalSystemTestRequestContext(
  options: Readonly<{
    actor?: TestActorOverrides;
    context?: TestEventStoreContextOverrides;
  }> = {},
): TestRequestContext {
  const actor = createInternalSystemTestActor(options.actor);

  return {
    actor,
    context: createTestEventStoreContext(actor, options.context),
  };
}

function createDefaultTestContext(actor: unknown): EventStoreContext | null {
  if (!actor || typeof actor !== "object") {
    return null;
  }

  const candidate = actor as Partial<TestResolvedActor>;
  if (!candidate.tenantId || !candidate.userId || !candidate.accountId) {
    return null;
  }

  return createTestEventStoreContext(candidate as TestResolvedActor);
}

function resolveTestAppContext<TEnv extends TestHonoEnv>(
  options: CreateTestAppOptions<TEnv>,
): TEnv["Variables"]["context"] {
  if (options.context === undefined) {
    return createDefaultTestContext(options.actor) as TEnv["Variables"]["context"];
  }

  if (typeof options.context === "function") {
    const createContext = options.context as (actor: TEnv["Variables"]["actor"]) => TEnv["Variables"]["context"];
    return createContext(options.actor);
  }

  return options.context;
}

export function createTestApp<TEnv extends TestHonoEnv>(options: CreateTestAppOptions<TEnv>): Hono<TEnv> {
  const app = new Hono<TEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", options.actor as never);
    c.set("context", resolveTestAppContext(options) as never);
    await next();
  });

  options.routes(app);

  return app;
}

export function resetMockState(...resetTargets: readonly MockResetTarget[]): void {
  vi.clearAllMocks();

  for (const resetTarget of resetTargets) {
    resetTarget.mockReset();
  }
}

export function useMockReset(...resetTargets: readonly MockResetTarget[]): void {
  afterEach(() => {
    resetMockState(...resetTargets);
  });
}

export function createMultiContextTestDatabaseName(scope: string, contextName: string): string {
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

export function createMultiContextTestDatabaseUrls<TContextName extends string>(
  adminDatabaseUrl: string,
  contextNames: readonly TContextName[],
  scope: string,
): Readonly<Record<TContextName, string>> {
  return Object.fromEntries(
    contextNames.map((contextName) => {
      const databaseName = createMultiContextTestDatabaseName(scope, contextName);
      return [contextName, createOwnedDatabaseUrl(adminDatabaseUrl, databaseName, databaseName)];
    }),
  ) as Readonly<Record<TContextName, string>>;
}

export async function ensureMultiContextTestDatabases(
  adminDatabaseUrl: string,
  databaseUrls: Readonly<Record<string, string>>,
): Promise<void> {
  const adminPool: PgTransactionalPool = createPgPool(adminDatabaseUrl);

  try {
    await ensureOwnedPostgresDatabases(adminPool, databaseUrls);
  } finally {
    await (adminPool as unknown as { end: () => Promise<void> }).end();
  }

  for (const [contextName, databaseUrl] of Object.entries(databaseUrls)) {
    const spec = parseOwnedDatabaseUrl(databaseUrl);
    const extensions = testDatabaseExtensions[contextName] ?? testDatabaseExtensions[spec.roleName] ?? [];

    if (extensions.length === 0) {
      continue;
    }

    const extensionAdminUrl = new URL(adminDatabaseUrl);
    extensionAdminUrl.pathname = `/${spec.databaseName}`;

    const extensionPool: PgTransactionalPool = createPgPool(extensionAdminUrl.toString());

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

export async function resetMultiContextTestSchemas(pools: Readonly<Record<string, unknown>>): Promise<void> {
  const uniquePools = [...new Set(Object.values(pools).filter(isPgTransactionalPool))];

  await forEachWithConcurrency(uniquePools, testSchemaResetConcurrency, (pool) => {
    const resetPool: PgTransactionalPool = pool;

    return resetPool.query(
      "DROP OWNED BY CURRENT_USER CASCADE; GRANT ALL PRIVILEGES ON SCHEMA public TO CURRENT_USER;",
    );
  });
}

export async function closeMultiContextTestPools(pools: Readonly<Record<string, unknown>>): Promise<void> {
  await Promise.all(
    Object.values(pools)
      .filter(isPgTransactionalPool)
      .map((pool) => (pool as unknown as { end: () => Promise<void> }).end()),
  );
}

function isPgTransactionalPool(value: unknown): value is PgTransactionalPool {
  return Boolean(value && typeof value === "object" && "query" in value);
}

async function forEachWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<unknown>,
): Promise<void> {
  let nextIndex = 0;
  let firstFailure: Readonly<{ error: unknown }> | undefined;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex];
        nextIndex += 1;

        try {
          await action(value!);
        } catch (error) {
          firstFailure ??= { error };
        }
      }
    }),
  );

  if (firstFailure) {
    throw firstFailure.error;
  }
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
  ports: TPorts | ((services: Readonly<Record<string, unknown>>) => TPorts);
}>;

export type MountedContextTestRuntime<
  TDefinitions extends readonly MountedContextTestDefinition[] = readonly MountedContextTestDefinition[],
> = Readonly<{
  mountedContexts: readonly MountedContextRuntimeEntry[];
  services: Readonly<Record<TDefinitions[number]["contextName"], unknown>>;
  projectionGroups: readonly ContextProjectionGroup[];
  subscriptionRunners: readonly ContextSubscriptionRunner[];
}>;

export function createMountedContextTestRuntime<const TDefinitions extends readonly MountedContextTestDefinition[]>(
  definitions: TDefinitions,
): MountedContextTestRuntime<TDefinitions> {
  const resolvedServices: Record<string, unknown> = {};
  const mountedContexts: MountedContextRuntimeEntry[] = [];

  for (const definition of definitions) {
    const ports = typeof definition.ports === "function" ? definition.ports(resolvedServices) : definition.ports;
    const services = definition.module.createServices(createProjectionAwarePool(definition.pool as never), ports);
    const mountRole = definition.mountRole ?? "active";

    resolvedServices[definition.contextName] = services;
    mountedContexts.push({
      contextName: definition.contextName,
      mountRole,
      module: definition.module,
      services,
      pool: definition.pool,
      projectionHandlerSets:
        mountRole === "source-only" ? [] : (definition.module.projectionHandlerSets?.(services) ?? []),
    } satisfies MountedContextRuntimeEntry);
  }

  const subscriptionRunners = resolveModuleSubscriptions(mountedContexts);
  const projectionGroups = resolveModuleProjectionGroups(mountedContexts, subscriptionRunners);

  return {
    mountedContexts,
    services: resolvedServices as Readonly<Record<TDefinitions[number]["contextName"], unknown>>,
    projectionGroups,
    subscriptionRunners,
  };
}

export async function seedMountedContextTestRuntimeIfEmpty(
  runtime: MountedContextTestRuntime,
  lifecycleContextOrder: readonly string[],
  options?: BcSeedOptions,
): Promise<void> {
  const mountedContextsByName = new Map(runtime.mountedContexts.map((entry) => [entry.contextName, entry]));

  for (const context of runtime.mountedContexts) {
    await bootstrapContextDatabase(context.module, context.pool);
  }

  for (const contextName of lifecycleContextOrder) {
    const context = mountedContextsByName.get(contextName);
    if (!context) {
      throw new Error(`Runtime is missing mounted context '${contextName}' required by the test lifecycle order.`);
    }

    await syncContextProjectionGroups(runtime, context.contextName, {
      requiredOnly: true,
    });
    await seedApiModuleIfEmpty(context.module, context.pool, context.services, options);
    await syncContextProjectionGroups(runtime, context.contextName);
    await drainContextRuntime(runtime);
  }

  await drainContextRuntime(runtime);
}
