import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { threadId } from "node:worker_threads";
import type { BcApiModule, BcSeedOptions } from "@chase-sets/bounded-context-module";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPgPool, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { Hono } from "hono";
import { afterEach, expect, vi } from "vitest";
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
  discovery: ["vector", "pg_trgm"],
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
  const poolsByDatabaseTarget = new Map<unknown, PgTransactionalPool>();

  for (const pool of Object.values(pools).filter(isPgTransactionalPool)) {
    const databaseTarget = resolvePgPoolDatabaseTarget(pool);
    if (!poolsByDatabaseTarget.has(databaseTarget)) {
      poolsByDatabaseTarget.set(databaseTarget, pool);
    }
  }

  await forEachWithConcurrency([...poolsByDatabaseTarget.values()], testSchemaResetConcurrency, (pool) => {
    return pool.query("DROP OWNED BY CURRENT_USER CASCADE; GRANT ALL PRIVILEGES ON SCHEMA public TO CURRENT_USER;");
  });
}

// DROP OWNED BY CURRENT_USER is database-wide, not pool-scoped, so distinct pools targeting the same database must collapse to one reset to avoid a lock-order deadlock (40P01).
function resolvePgPoolDatabaseTarget(pool: PgTransactionalPool): unknown {
  const connectionString = (pool as unknown as { options?: { connectionString?: unknown } }).options?.connectionString;

  if (typeof connectionString !== "string") {
    return pool;
  }

  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return pool;
  }
}

// Scratch DDL-reset Probe arm B (never landed): opt-in once-per-file bootstrap with a per-test data reset.
// The first reset runs the default DDL reset and bootstrap, then records one baseline per database
// target. Later resets are dependency-ordered row DELETE, re-insert of bootstrap-written rows and
// nontransactional setval of owned sequence/identity positions: no relation rewrite or index build.
// A catalog that differs from the baseline (a schema-mutating test ran) restores through the
// retained DDL reset and bootstrap instead, so schema and upgrade tests keep their DDL semantics.
export type MultiContextTestDataReset = Readonly<{ reset: () => Promise<void> }>;

type TestDataResetKind = "ddl-bootstrap" | "ddl-restore" | "data";

type TestDataBaseline = Readonly<{
  pool: PgTransactionalPool;
  catalog: string;
  resetSql: string;
}>;

const testDataResetLedgerDirectory = fileURLToPath(new URL("../../artifacts/9344-reset-ledger/", import.meta.url));

export function createMultiContextTestDataReset(
  resolvePools: () => Readonly<Record<string, unknown>>,
  bootstrap: () => Promise<void>,
): MultiContextTestDataReset {
  let baselines: readonly TestDataBaseline[] | undefined;

  return {
    async reset() {
      const pools = resolvePools();
      const targets = testDataResetTargetPools(pools);
      const current =
        baselines &&
        baselines.length === targets.length &&
        baselines.every((baseline, index) => baseline.pool === targets[index])
          ? baselines
          : undefined;
      if (current) {
        const catalogs = await Promise.all(current.map((baseline) => readTestCatalogFingerprint(baseline.pool)));
        if (catalogs.every((catalog, index) => catalog === current[index]!.catalog)) {
          recordTestDataReset("data");
          await forEachWithConcurrency(current, testSchemaResetConcurrency, (baseline: TestDataBaseline) =>
            baseline.pool.query(baseline.resetSql),
          );
          return;
        }
      }

      recordTestDataReset(current ? "ddl-restore" : "ddl-bootstrap");
      baselines = undefined;
      await resetMultiContextTestSchemas(pools);
      await bootstrap();
      baselines = await Promise.all(targets.map(captureTestDataBaseline));
    },
  };
}

// Same database-target dedup as resetMultiContextTestSchemas (the 40P01 lock-order guard).
function testDataResetTargetPools(pools: Readonly<Record<string, unknown>>): readonly PgTransactionalPool[] {
  const poolsByDatabaseTarget = new Map<unknown, PgTransactionalPool>();

  for (const pool of Object.values(pools).filter(isPgTransactionalPool)) {
    const databaseTarget = resolvePgPoolDatabaseTarget(pool);
    if (!poolsByDatabaseTarget.has(databaseTarget)) {
      poolsByDatabaseTarget.set(databaseTarget, pool);
    }
  }

  return [...poolsByDatabaseTarget.values()];
}

function recordTestDataReset(kind: TestDataResetKind): void {
  const state = expect.getState();
  mkdirSync(testDataResetLedgerDirectory, { recursive: true });
  appendFileSync(
    `${testDataResetLedgerDirectory}${process.pid}-${threadId}.jsonl`,
    `${JSON.stringify({ kind, file: state.testPath ?? "", test: state.currentTestName ?? "" })}\n`,
  );
}

const ownedRole = "(SELECT oid FROM pg_roles WHERE rolname = current_user)";
const ownedRelations = `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relowner = ${ownedRole} AND n.nspname NOT LIKE 'pg\\_toast%'`;

// Every owned catalog object a test could add, drop or alter, keyed by name rather than oid so a
// test that rebuilds the identical schema still matches.
const testCatalogFingerprintSql = `SELECT md5(coalesce(string_agg(item, E'\\n' ORDER BY item), '')) AS catalog FROM (
  SELECT format('rel %s.%s %s %s %s %s %s', n.nspname, c.relname, c.relkind, c.relpersistence, c.reloptions, c.relacl, c.relrowsecurity)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid IN (${ownedRelations})
  UNION ALL
  SELECT format('col %s %s %s %s %s %s %s %s', c.relname, a.attnum, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
      a.attidentity, a.attgenerated, pg_get_expr(d.adbin, d.adrelid))
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid IN (${ownedRelations}) AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT format('con %s %s %s %s', c.relname, co.conname, co.convalidated, pg_get_constraintdef(co.oid))
    FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid WHERE co.conrelid IN (${ownedRelations})
  UNION ALL
  SELECT format('idx %s %s %s', pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready)
    FROM pg_index i WHERE i.indexrelid IN (${ownedRelations})
  UNION ALL
  SELECT format('trg %s %s %s', c.relname, t.tgenabled, pg_get_triggerdef(t.oid))
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND t.tgrelid IN (${ownedRelations})
  UNION ALL
  SELECT format('rule %s %s', c.relname, md5(pg_get_ruledef(r.oid)))
    FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE r.ev_class IN (${ownedRelations})
  UNION ALL
  SELECT format('pol %s %s %s', c.relname, p.polname, p.polcmd)
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE p.polrelid IN (${ownedRelations})
  UNION ALL
  SELECT format('seq %s %s %s %s %s %s %s %s', c.relname, s.seqtypid::regtype, s.seqstart, s.seqincrement, s.seqmax, s.seqmin,
      s.seqcache, s.seqcycle)
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid WHERE s.seqrelid IN (${ownedRelations})
  UNION ALL
  SELECT format('fn %s.%s(%s) %s %s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prokind, md5(p.prosrc))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proowner = ${ownedRole}
  UNION ALL
  SELECT format('type %s.%s %s', n.nspname, t.typname, t.typtype)
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typowner = ${ownedRole} AND t.typrelid = 0 AND t.typelem = 0
  UNION ALL
  SELECT format('enum %s %s %s', e.enumtypid::regtype, e.enumsortorder, e.enumlabel)
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typowner = ${ownedRole}
  UNION ALL
  SELECT format('nsp %s %s %s', n.nspname, n.nspowner = ${ownedRole}, n.nspacl)
    FROM pg_namespace n WHERE n.nspowner = ${ownedRole} OR n.nspname = 'public'
  UNION ALL
  SELECT format('lo %s', count(*)) FROM pg_largeobject_metadata WHERE lomowner = ${ownedRole}
) items(item)`;

async function readTestCatalogFingerprint(pool: PgTransactionalPool): Promise<string> {
  const result = await pool.query<{ catalog: string }>(testCatalogFingerprintSql);
  return result.rows[0]!.catalog;
}

async function captureTestDataBaseline(pool: PgTransactionalPool): Promise<TestDataBaseline> {
  const catalog = await readTestCatalogFingerprint(pool);
  const unsupported = await pool.query<{ item: string }>(
    `SELECT format('%s %s', c.relkind, c.relname) AS item FROM pg_class c
      WHERE c.oid IN (${ownedRelations}) AND c.relkind IN ('m', 'f')
     UNION ALL
     SELECT format('trigger %s', t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN (${ownedRelations})
     UNION ALL
     SELECT format('rule %s', r.rulename) FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
      WHERE r.ev_class IN (${ownedRelations}) AND c.relkind IN ('r', 'p')`,
  );
  if (unsupported.rows.length > 0) {
    throw new Error(
      `#9344 data reset cannot preserve equivalence over ${unsupported.rows.map((row) => row.item).join(", ")}; this site must opt out.`,
    );
  }

  const tables = await pool.query<{ oid: number; name: string; columns: string[] }>(
    `SELECT c.oid::int AS oid, format('%I.%I', n.nspname, c.relname) AS name,
       ARRAY(SELECT quote_ident(a.attname) FROM pg_attribute a
         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
         ORDER BY a.attnum) AS columns
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.oid IN (${ownedRelations}) AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
     ORDER BY 2`,
  );
  const references = await pool.query<{ child: number; parent: number }>(
    `SELECT conrelid::int AS child, confrelid::int AS parent FROM pg_constraint
     WHERE contype = 'f' AND conrelid <> confrelid AND conrelid IN (${ownedRelations}) AND confrelid IN (${ownedRelations})`,
  );
  const deleteOrder = orderTablesReferencingFirst(
    tables.rows.map((table) => table.oid),
    references.rows,
  ).map((oid) => tables.rows.find((table) => table.oid === oid)!);

  const baselineRows =
    tables.rows.length === 0
      ? []
      : (
          await pool.query<{ name: string; rows: string | null }>(
            tables.rows
              .map(
                (table) =>
                  `SELECT ${quoteSqlLiteral(table.name)} AS name, (SELECT json_agg(b9344_row)::text FROM ${table.name} b9344_row) AS rows`,
              )
              .join("\nUNION ALL\n"),
          )
        ).rows;
  const rowsByTable = new Map(baselineRows.filter((row) => row.rows !== null).map((row) => [row.name, row.rows!]));

  const sequences = await pool.query<{ name: string; position: string }>(
    `SELECT quote_literal(format('%I.%I', schemaname, sequencename)) AS name,
       CASE WHEN last_value IS NULL THEN format('%s, false', start_value) ELSE format('%s, true', last_value) END AS position
     FROM pg_sequences WHERE sequenceowner = current_user ORDER BY 1`,
  );

  const statements = [
    ...deleteOrder.map((table) => `DELETE FROM ${table.name};`),
    ...[...deleteOrder]
      .reverse()
      .filter((table) => rowsByTable.has(table.name))
      .map((table) => {
        const columns = table.columns.join(", ");
        return `INSERT INTO ${table.name} (${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM json_populate_recordset(NULL::${table.name}, ${quoteSqlDollar(rowsByTable.get(table.name)!)}::json);`;
      }),
    ...(sequences.rows.length === 0
      ? []
      : [
          `SELECT ${sequences.rows.map((sequence) => `setval(${sequence.name}::regclass, ${sequence.position})`).join(", ")};`,
        ]),
  ];

  return { pool, catalog, resetSql: statements.join("\n") };
}

function orderTablesReferencingFirst(
  oids: readonly number[],
  references: readonly Readonly<{ child: number; parent: number }>[],
): number[] {
  const referencers = new Map(oids.map((oid) => [oid, new Set<number>()]));
  for (const reference of references) {
    referencers.get(reference.parent)?.add(reference.child);
  }

  const ordered: number[] = [];
  const remaining = new Set(oids);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((oid) => [...referencers.get(oid)!].every((child) => !remaining.has(child)));
    if (ready.length === 0) {
      throw new Error("#9344 data reset found a foreign-key cycle; this site must opt out.");
    }
    for (const oid of ready) {
      remaining.delete(oid);
      ordered.push(oid);
    }
  }

  return ordered;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteSqlDollar(value: string): string {
  let tag = "$b9344$";
  while (value.includes(tag)) {
    tag = `$b9344${randomUUID().replaceAll("-", "")}$`;
  }

  return `${tag}${value}${tag}`;
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
