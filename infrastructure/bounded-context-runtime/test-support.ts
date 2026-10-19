import { randomUUID } from "node:crypto";
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

type DataResetForeignKey = Readonly<{ child: string; parent: string; columns: string[]; referenced: string[] }>;
type DataResetTable = Readonly<{ name: string; columns: string[]; rows: string }>;
type DataResetSequence = Readonly<{ name: string; value: string; called: boolean }>;
type DataResetSnapshot = Readonly<{
  catalog: string;
  tables: readonly DataResetTable[];
  foreignKeys: readonly DataResetForeignKey[];
  sequences: readonly DataResetSequence[];
}>;
type DataResetGroup = {
  pools: Readonly<Record<string, unknown>>;
  targets: PgTransactionalPool[];
  snapshots: Map<unknown, DataResetSnapshot>;
  bootstrap: () => Promise<void>;
  previousOptOut: boolean;
};

const dataResetGroups = new WeakMap<PgTransactionalPool, DataResetGroup>();

export const dataResetOptOuts: readonly Readonly<{ file: string; test: string; reason: string }>[] = [
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-inbound.db.test.ts",
    test: "connector-ingest-replay / connector-ingest-admission-and-authority recreates the boot-owned transport shape through its migration alone and resumes inertly",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 248,249.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-liveness-authority-read.db.test.ts",
    test: "connector-liveness-authority-read boot idempotently backfills pre-table pairings without inventing heartbeat",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 126.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-liveness-authority-read.db.test.ts",
    test: "connector-liveness-authority-read migration idempotently backfills pre-table pairings without inventing heartbeat",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 126.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-live-code-binding: missing, expired and consumed codes refuse without writes and audit once",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-live-code-binding: two own live codes are ambiguous; expired siblings are not candidates",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-live-code-binding: another member's code never grants the requesting user",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-live-code-binding: another account's code is not a candidate even for the same user",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-live-code-binding: permission and current membership are independent gates",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-live-code-binding: concurrent HTTP authorization has one grant and one conflict audit",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-live-code-binding: consume CAS refuses a changed read revision before publishing",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-live-code-binding: paused connection binds both exact token responses and supersession revokes",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-live-code-binding: disconnected and closed pairings never become candidates",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle consumes one ten-minute code once with one concurrent winner",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle refuses expired codes without publishing a grant and remains inert the next day",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle rotates PKCE and refresh credentials and refuses wrong verifiers without consuming the code",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-authority-operation-matrix: active retains only ingest after membership loss",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-authority-operation-matrix: paused retains only ingest after membership loss",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle revokes before replacement and stale unpair cannot close the newer pairing",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle failed revocation cannot falsely close or publish a replacement, then recovery revokes before close",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle disconnect races regeneration and never leaves live authority, including after boot twice",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle consume and disconnect race: consume-first",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle consume and disconnect race: disconnect-first",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle unpair cleanup and re-pair race: cleanup-first",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle unpair cleanup and re-pair race: re-pair-first",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-feed-scope-isolation: foreign and missing targets refuse equally and call no consumer",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle grant expiry invalidates authority before closing and last-seen stays null",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle connector-feed-bootstrap-and-manifest: migrations and repeated boot produce identical tables and indexes",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle an admitted consumer completes before concurrent revoke on the real connection stream",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle concurrent revoke wins before a waiting consumer and the next-day runtime stays closed",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle consume and supersession race: consume-first",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle consume and supersession race: cleanup-first",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle cleans an Auth-committed grant after Channels rollback before allowing regeneration",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle withheld, pending setup, disconnected, and unpaired states never admit a consumer",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle rechecks connection authority even when credential cleanup has not run",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle actual Auth composition validates lifetime overrides before issuing rotating connector tokens",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle Auth boot and migrations agree for connector tables and the live-grant uniqueness fence",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/connector-pairing-lifecycle.db.test.ts",
    test: "connector-pairing-lifecycle rejects recursively malformed authorization inputs before grant or pairing writes",
    reason:
      "The inventory target is intentionally unbootstrapped, with service-owned lazy bootstrap; equivalence across this target is unknown for each identity.",
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/tests/staged-import-floor-policy-production.db.test.ts",
    test: "staged-import-floor-policy-production upgrades the existing audit constraint without changing retained rows or weakening route closure",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 128,130.",
  },
  {
    file: "bounded-contexts/channels/features/listing-composition/tests/channel-listing-projections.db.test.ts",
    test: "channel-projection-concurrent-write publish_quantity_cap migration and read-back upgrades the previous schema and round-trips null and 2",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 64.",
  },
  {
    file: "bounded-contexts/channels/features/listing-composition/tests/channel-listing-projections.db.test.ts",
    test: "channel-projection-concurrent-write low_stock_withhold_units migration and read-back preserves old replay and pre-buffer resolver flags",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 185.",
  },
  {
    file: "bounded-contexts/channels/features/live-export-snapshot/tests/live-export-snapshot-bootstrap.db.test.ts",
    test: "live-export-snapshot-bootstrap upgrades old rows and catalog-named checks, matches fresh boot, and boots twice inertly",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 73,76,44.",
  },
  {
    file: "bounded-contexts/channels/features/order-fulfillment-observations/tests/accepted-rts-membership.db.test.ts",
    test: "accepted RTS owner accepted-rts-upgrade-retention: ledger-only upgrade matches fresh boot and does not infer old RTS from active/history",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 326.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/live-export-producer.db.test.ts",
    test: "live-export-producer channels-bootstrap-and-migrations: ledger-only upgrade and repeated boot preserve retained queues",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 290.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/order-pull-producer.db.test.ts",
    test: "order-pull-scheduler-and-claim / order-pull-subject-feed-contract AC3 checkpoint/chunk/successor roll back on a losing generation, then report-only recovery commits once",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 411,414,419.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/order-pull-producer.db.test.ts",
    test: "order-pull-producer-schema-and-profiles AC4 the ledgered migration adds the producer tables to a retained queue without touching pending listing operations",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 984.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/order-pull-producer.db.test.ts",
    test: "order-pull-producer-schema-and-profiles excludes lookalike interpretation tables and their indexes from the producer census",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 990,991.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings outbound-per-listing-ordering / outbound-claimed-lane-parking preserves fences without a budget",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings serializes concurrent same-lane desires and leaves the highest producer sequence",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings outbound-coalescing-latest-state-wins replaces a queued update with a higher-sequence delist",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings orders equal-time desired work before its deterministic repair on claimed and inline paths",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings supersedes an obsolete pending repush before the newer desired state reaches the claimed claim path",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings supersedes an obsolete pending repush before the newer desired state reaches the inline claim path",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings reads only the exact connection-owned operation IDs in one closed bounded batch",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings rolls back obsolete-operation supersession when a candidate revision changes before write-back",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings outbound-stale-success-sequence-adoption",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings rolls back publication recomposition when the outer outbound settlement fails",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings outbound-coalescing-latest-state-wins gives a pending replacement its own full retry budget",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings keeps boot-twice and the idle day-after runner byte-inert",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings reserves concurrent lanes disjointly and refuses a partial acknowledgement without writing",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings outbound-poison-isolation blocks only the unknown lane until a fenced clear",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings runs the four provider admission states through the durable engine",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings outbound-inline-execution-owner-inventory invokes only the exact operation wrapper",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings refuses an isolated invalid locked provider rate-state before admission without changing the operation or lane",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings enforces a durable per-connection cap while a fair neighboring connection advances",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings retries only proven non-application and isolates an unknown provider result",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings fences a late inline success after the attempt lease becomes outcome-unknown",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings turns an inline wrapper timeout into terminal uncertainty without retry",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings outbound-claimed-acknowledgement-totality settles composed expiry from the immutable member vector",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings turns causal awaiting-verification expiry into unknown without a pending interval",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings outbound-claimed-acknowledgement-totality admits the same-claimant exception once across an expiry race",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings connector-settlement-refusal-replay: refuses a nonterminal composed omission with unchanged members, then settles once",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings connector-settlement-refusal-replay: refuses a nonterminal claimed omission with unchanged members, then settles once",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings connector-settlement-refusal-replay: refuses a nonterminal awaiting-verification omission with unchanged members, then settles once",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings outbound-operation-log-completeness / outbound-event-to-ack-latency pages to the independent total",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-claimed-reservation-interleavings.db.test.ts",
    test: "outbound-transition-matrix / outbound-steady-state-and-restart / outbound-claimed-reservation-interleavings outbound-backlog-fairness-drill drains 10,000 listings while a provider neighbor advances",
    reason:
      "Each identity runs a non-idempotent CREATE TABLE fixture after normal bootstrap; data-reset equivalence is unknown.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-schema-upgrade.db.test.ts",
    test: "outbound-sync schema upgrades boots the retained last-good outbound schema through production Channels with data, guards and fresh parity",
    reason: "Each identity bootstraps a predecessor or incomplete schema inside the test; needs an empty DDL reset.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-schema-upgrade.db.test.ts",
    test: "outbound-sync schema upgrades rejects the compatibility-omitted production boot with exactly PostgreSQL 42703 before migrations",
    reason: "Each identity bootstraps a predecessor or incomplete schema inside the test; needs an empty DDL reset.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-schema-upgrade.db.test.ts",
    test: "outbound-sync schema upgrades upgrades the exact predecessor ledger and replays a durable reservation receipt",
    reason: "Each identity bootstraps a predecessor or incomplete schema inside the test; needs an empty DDL reset.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-schema-upgrade.db.test.ts",
    test: "outbound-sync schema upgrades keeps the current fresh schema and migration ledger inert across two boots",
    reason: "Each identity bootstraps a predecessor or incomplete schema inside the test; needs an empty DDL reset.",
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/tests/outbound-schema-upgrade.db.test.ts",
    test: "outbound-sync schema upgrades upgrades a populated pending queue through the index migration with fresh-boot parity",
    reason: "Each identity bootstraps a predecessor or incomplete schema inside the test; needs an empty DDL reset.",
  },
  {
    file: "bounded-contexts/channels/features/reconciliation/tests/channel-reconciliation-runtime.db.test.ts",
    test: "Channel Reconciliation guarded production path claimed-snapshot-age-schema-upgrade retains existing findings and policy history across ledgered upgrade and two boots",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 1358.",
  },
  {
    file: "bounded-contexts/channels/features/reconciliation/tests/channel-reconciliation-runtime.db.test.ts",
    test: "Channel Reconciliation guarded production path drift-detail applies the owning index migration to retained rows and survives repeated boot",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 2383,2384,2385.",
  },
  {
    file: "bounded-contexts/channels/features/reconciliation/tests/channel-reconciliation-runtime.db.test.ts",
    test: "Channel Reconciliation guarded production path S6 retained old schema requires the owning migration and survives repeated real boot",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 2975.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease tcgplayer-compose-operation-identity composes before the link projector runs",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease tcgplayer-compose-reference-controls preserves catalog cardinality 0",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease tcgplayer-compose-reference-controls preserves catalog cardinality 1",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease tcgplayer-compose-reference-controls preserves catalog cardinality 2",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease tcgplayer-compose-reference-controls preserves product cardinality 0 and selected options",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease tcgplayer-compose-reference-controls preserves product cardinality 1 and selected options",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease tcgplayer-compose-reference-controls preserves product cardinality 2 and selected options",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease tcgplayer-compose-condition-operation-identity resolves graded inputs without snapshot masking",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease tcgplayer-compose-read-caller-closure batches distinct identities and retains provider/connection scope",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease snapshot-read-cap-boundary limits SQL materialization and returned rows on both paths",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease snapshot-read-membership-not-census rejects overflow, missing and partial membership",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease snapshot-read-callers-retained isolates two connections and surfaces while retaining generation order",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease boots twice and admits only one non-terminal run per connection",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease retains immutable listing identity and fences stale run writes",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease rejects manual runs without the captured lease policy snapshot and connector runs with one",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease replays run composition and transitions twice without duplicate writes",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease atomically rolls back reservation and composed event failures before restart, expiry, and a two-claimant race",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease discovers one canonical graded condition mapping through the production reservation boundary",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease refuses every ingest grammar arm with zero snapshot, row, or schema-pin persistence",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease snapshot-read-callers-retained proves two-row application and cap mismatch behavior through the real database runtime",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease retains the exact manual lease snapshot across restart and recomposes released work",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease drives missing, first, never-verified, equal, and newer Staged basis generations",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease splits repeated N+1 reservations into ordered N then one without in-flight residue",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease serializes two claimant families across three cap-sized sets and restarts",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease settles claimed and upload-verify lease boundaries once through the genuine run port",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease settles every member durably when an awaiting run reports a second upload attempt",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease settles the mixed member partition through upload-to-verify expiry exactly once",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease settles a genuine composed, refused, and already-satisfied member partition by member proof",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease recomposes superseded and stale-basis work on the day after without mutating terminal audit",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/tests/tcgplayer-run-order-and-lease.db.test.ts",
    test: "tcgplayer-run-order-and-lease second-run-after-applied-composes-clamp-paused-revert",
    reason:
      "The file has dynamically injected schema/trigger helper paths; equivalence is unknown for each identity pending a separate call-graph proof.",
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-orders/tests/tcgplayer-orders.db.test.ts",
    test: "TCGplayer connector sale interpretation tcgplayer-order-target-resolution: ledgered index includes Links that predate its creation",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 172.",
  },
  {
    file: "bounded-contexts/channels/tests/channel-publication-browser-support.db.test.ts",
    test: "channel publication browser support fails closed for direct calls outside the owned local seed",
    reason: "Schema/upgrade mutation or explicit in-test DDL reset at H 191.",
  },
];

export function isDataResetOptOut(
  testPath: string | undefined,
  currentTestName: string | undefined,
  entries: readonly Readonly<{ file: string; test: string }>[] = dataResetOptOuts,
): boolean {
  const file = testPath?.replaceAll("\\", "/");
  const name = currentTestName?.split(" > ").join(" ");
  return entries.some((entry) => file?.endsWith(entry.file) === true && name === entry.test);
}

function quoteDataResetIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function orderDataResetTables(
  names: readonly string[],
  foreignKeys: readonly Readonly<{ child: string; parent: string }>[],
): string[] {
  const remaining = new Set(names);
  for (const key of foreignKeys) {
    if (!remaining.has(key.child) || !remaining.has(key.parent)) throw new Error("uncaptured table in foreign key");
  }
  const result: string[] = [];
  while (remaining.size > 0) {
    const next = [...remaining]
      .sort()
      .find(
        (name) => !foreignKeys.some((key) => key.parent === name && key.child !== name && remaining.has(key.child)),
      );
    if (!next) throw new Error("unsafe foreign-key cycle");
    result.push(next);
    remaining.delete(next);
  }
  return result;
}

async function readDataResetCatalog(pool: PgTransactionalPool): Promise<string> {
  const result = await pool.query<{ catalog: string }>(`WITH owned AS (
    SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relowner=current_user::regrole AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
  ) SELECT jsonb_build_object(
    'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relpersistence,c.reloptions,c.relacl,c.relrowsecurity) ORDER BY n.nspname,c.relname)
      FROM owned c JOIN pg_namespace n ON n.oid=c.relnamespace),
    'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attidentity,a.attgenerated,
      pg_get_expr(d.adbin,d.adrelid),a.attacl) ORDER BY c.relname,a.attnum) FROM owned c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname)
      FROM owned c JOIN pg_constraint k ON k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM owned c JOIN pg_index i ON i.indrelid=c.oid),
    'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname,t.tgname) FROM owned c JOIN pg_trigger t ON t.tgrelid=c.oid WHERE NOT t.tgisinternal),
    'rules',(SELECT jsonb_agg(pg_get_ruledef(r.oid) ORDER BY c.relname,r.rulename) FROM owned c JOIN pg_rewrite r ON r.ev_class=c.oid),
    'sequences',(SELECT jsonb_agg(jsonb_build_array(c.relname,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle) ORDER BY c.relname)
      FROM owned c JOIN pg_sequence s ON s.seqrelid=c.oid),
    'schemas',(SELECT jsonb_agg(jsonb_build_array(nspname,nspacl) ORDER BY nspname) FROM pg_namespace WHERE nspowner=current_user::regrole),
    'extensions',(SELECT jsonb_agg(jsonb_build_array(extname,extversion) ORDER BY extname) FROM pg_extension),
    'functions',(SELECT jsonb_agg(jsonb_build_array(pg_get_functiondef(p.oid),p.proacl) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.proowner=current_user::regrole AND n.nspname !~ '^pg_' AND p.prokind IN ('f','p')
        AND NOT EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')),
    'enums',(SELECT jsonb_agg(jsonb_build_array(n.nspname,t.typname,e.enumlabel) ORDER BY n.nspname,t.typname,e.enumsortorder)
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE t.typowner=current_user::regrole),
    'role',(SELECT jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolconfig)
      FROM pg_roles WHERE rolname=current_user)
  )::text AS catalog`);
  if (result.rows.length !== 1) throw new Error("missing captured catalog");
  return result.rows[0]!.catalog;
}

async function captureDataResetSnapshot(pool: PgTransactionalPool): Promise<DataResetSnapshot> {
  const relations = await pool.query<{ name: string; kind: string; unsafe: boolean }>(`SELECT
    format('%I.%I',n.nspname,c.relname) AS name,c.relkind AS kind,
    (c.relrowsecurity OR EXISTS(SELECT FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
      OR EXISTS(SELECT FROM pg_rewrite r WHERE r.ev_class=c.oid AND r.rulename<>'_RETURN')) AS unsafe
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relowner=current_user::regrole AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
      AND c.relkind IN ('r','p','m','f','S')
      AND NOT EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
    ORDER BY name`);
  if (relations.rows.some((row) => row.unsafe || !["r", "S"].includes(row.kind))) {
    throw new Error(
      "unsupported data reset shape: materialized view, partition, foreign table, rule, trigger or row security",
    );
  }
  const keys = await pool.query<DataResetForeignKey>(`SELECT
    format('%I.%I',cn.nspname,child.relname) AS child,format('%I.%I',pn.nspname,parent.relname) AS parent,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,position)
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY position) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,position)
      JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY position) AS referenced
    FROM pg_constraint k JOIN pg_class child ON child.oid=k.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace
    JOIN pg_class parent ON parent.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace
    WHERE k.contype='f' AND child.relowner=current_user::regrole AND cn.nspname !~ '^pg_' ORDER BY child,k.conname`);
  const names = relations.rows.filter((r) => r.kind === "r").map((r) => r.name);
  const ordered = orderDataResetTables(names, keys.rows);
  const tables: DataResetTable[] = [];
  for (const name of ordered) {
    const columns = await pool.query<{ name: string }>(
      `SELECT attname AS name FROM pg_attribute
      WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`,
      [name],
    );
    const rows = await pool.query<{ rows: string }>(
      `SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb)::text AS rows FROM ${name} t`,
    );
    tables.push({ name, columns: columns.rows.map((c) => c.name), rows: rows.rows[0]!.rows });
  }
  const sequences: DataResetSequence[] = [];
  for (const relation of relations.rows.filter((r) => r.kind === "S")) {
    const owned = await pool.query(
      `SELECT 1 FROM pg_depend WHERE classid='pg_class'::regclass AND objid=$1::regclass AND deptype IN ('a','i')`,
      [relation.name],
    );
    if (owned.rows.length !== 1) throw new Error("unsupported data reset shape: unowned sequence");
    const value = await pool.query<{ value: string; called: boolean }>(
      `SELECT last_value::text AS value,is_called AS called FROM ${relation.name}`,
    );
    sequences.push({ name: relation.name, ...value.rows[0]! });
  }
  return { catalog: await readDataResetCatalog(pool), tables, foreignKeys: keys.rows, sequences };
}

async function restoreDataResetSnapshot(pool: PgTransactionalPool, snapshot: DataResetSnapshot): Promise<void> {
  for (const table of snapshot.tables) {
    const selfKeys = snapshot.foreignKeys.filter((key) => key.child === table.name && key.parent === table.name);
    if (selfKeys.length > 0) {
      const referencedByChild = selfKeys
        .map(
          (key) =>
            `EXISTS (SELECT FROM ${table.name} child WHERE child.ctid<>parent.ctid AND ${key.columns
              .map(
                (column, index) =>
                  `child.${quoteDataResetIdentifier(column)}=parent.${quoteDataResetIdentifier(key.referenced[index]!)}`,
              )
              .join(" AND ")})`,
        )
        .join(" OR ");
      while ((await pool.query(`SELECT 1 FROM ${table.name} LIMIT 1`)).rows.length > 0) {
        const removed = await pool.query(
          `DELETE FROM ${table.name} parent WHERE NOT (${referencedByChild}) RETURNING 1`,
        );
        if (removed.rows.length === 0) throw new Error("unsafe self-referencing row cycle");
      }
    } else {
      await pool.query(`DELETE FROM ${table.name}`);
    }
  }
  for (const table of [...snapshot.tables].reverse()) {
    if (table.rows === "[]") continue;
    const columns = table.columns.map(quoteDataResetIdentifier).join(",");
    await pool.query(
      `INSERT INTO ${table.name} (${columns}) OVERRIDING SYSTEM VALUE
      SELECT ${columns} FROM jsonb_populate_recordset(NULL::${table.name},$1::jsonb)`,
      [table.rows],
    );
  }
  for (const sequence of snapshot.sequences) {
    await pool.query("SELECT setval($1::regclass,$2::bigint,$3::boolean)", [
      sequence.name,
      sequence.value,
      sequence.called,
    ]);
  }
}

export async function resetMultiContextTestData(
  pools: Readonly<Record<string, unknown>>,
  bootstrap: () => Promise<void>,
): Promise<void> {
  const targets = [
    ...new Map(
      Object.values(pools)
        .filter(isPgTransactionalPool)
        .map((pool) => [resolvePgPoolDatabaseTarget(pool), pool]),
    ).values(),
  ];
  if (targets.length === 0) throw new Error("data reset requires database targets");
  const existing = targets.map((pool) => dataResetGroups.get(pool));
  let group = existing[0];
  if (
    existing.some((entry) => entry !== group) ||
    (group && targets.some((pool) => !group!.snapshots.has(resolvePgPoolDatabaseTarget(pool))))
  ) {
    throw new Error("target without a captured snapshot");
  }
  const state = expect.getState();
  const optedOut = isDataResetOptOut(state.testPath, state.currentTestName);
  if (!group) {
    await resetMultiContextTestSchemas(pools);
    await bootstrap();
    if (optedOut) return;
    group = { pools, targets, snapshots: new Map(), bootstrap, previousOptOut: optedOut };
    for (const pool of targets)
      group.snapshots.set(resolvePgPoolDatabaseTarget(pool), await captureDataResetSnapshot(pool));
    for (const pool of Object.values(pools).filter(isPgTransactionalPool)) dataResetGroups.set(pool, group);
    return;
  }
  if (group.previousOptOut || optedOut) {
    await resetMultiContextTestSchemas(pools);
    await bootstrap();
    for (const pool of targets) {
      const current = await captureDataResetSnapshot(pool);
      if (current.catalog !== group.snapshots.get(resolvePgPoolDatabaseTarget(pool))!.catalog)
        throw new Error("opt-out bootstrap catalog differs");
      group.snapshots.set(resolvePgPoolDatabaseTarget(pool), current);
    }
  } else {
    for (const pool of targets) {
      const snapshot = group.snapshots.get(resolvePgPoolDatabaseTarget(pool));
      if (!snapshot) throw new Error("target without a captured snapshot");
      await restoreDataResetSnapshot(pool, snapshot);
    }
    await bootstrap();
  }
  group.previousOptOut = optedOut;
}

export async function assertMultiContextTestDataCatalog(pools: Readonly<Record<string, unknown>>): Promise<void> {
  const groups = new Set(
    Object.values(pools)
      .filter(isPgTransactionalPool)
      .map((pool) => dataResetGroups.get(pool)),
  );
  for (const group of groups) {
    if (!group) continue;
    if (group.previousOptOut) {
      await resetMultiContextTestSchemas(group.pools);
      await group.bootstrap();
    }
    for (const pool of group.targets) {
      if ((await readDataResetCatalog(pool)) !== group.snapshots.get(resolvePgPoolDatabaseTarget(pool))!.catalog)
        throw new Error("unlisted file-end catalog drift");
    }
  }
}

export async function closeMultiContextTestPools(pools: Readonly<Record<string, unknown>>): Promise<void> {
  try {
    await assertMultiContextTestDataCatalog(pools);
  } finally {
    await Promise.all(
      Object.values(pools)
        .filter(isPgTransactionalPool)
        .map((pool) => (pool as unknown as { end: () => Promise<void> }).end()),
    );
  }
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
