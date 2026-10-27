import {
  defineBoundedContextModule,
  defineBcProjectionGroupReset,
  type BcApiEntry,
  type BcApiModule,
  type BcProjectionGroup,
} from "@chase-sets/bounded-context-module";
import { createPostgresEventStore, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase } from "../bounded-context-runtime/index";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createApiHost,
  createProjectionGroupLeasePort,
  seedApiHostIfEmpty,
  type ApiContextRegistry,
  type ApiHostSeedOptions,
} from "./api";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
  platformControlPlaneSchemaSql,
  type PlatformControlPlane,
  type PlatformLease,
} from "./control-plane";

export const TARGET_GROUP = { targetContextName: "target", projectionName: "items" } as const;
export const TARGET_LEASE_NAME = "projection-group:target.items";
export const TARGET_CHECKPOINT_KEY = "items:target:v1";
export const SEED_OWNER = "seed:platform-api";

export type InlineSeedDbPools = Readonly<Record<"platform" | "target", PgTransactionalPool>>;

/** Hooks the synthetic target projection calls inside its leased transactions. */
export type TargetProjectionHooks = {
  beforeProject?: (itemId: string) => Promise<void>;
  onReset?: (db: PgQueryable) => Promise<void>;
};

const NO_API_ENTRIES: readonly BcApiEntry[] = [];
type TargetServices = Readonly<{ pool: PgTransactionalPool }>;
type TargetHostPorts = Readonly<Record<string, never>>;

/**
 * One active context whose local `items` projection owns `projected_items`: a truncate-owned group
 * required during bootstrap, so the seed's required sync, drains, and revision-stale reset all run
 * through the real projection-groups.ts and subscription store on Postgres.
 */
export function createTargetRegistry(hooks: TargetProjectionHooks, projectionRevision = 1): ApiContextRegistry {
  const base = defineBoundedContextModule<TargetServices, PgTransactionalPool, TargetHostPorts>({
    manifest: { contextName: "target", apiBasePath: "/target", streamPrefix: "target." },
    schemaSql: "CREATE TABLE IF NOT EXISTS projected_items (item_id text PRIMARY KEY);",
    createServices: (pool) => ({ pool }),
    buildApis: () => NO_API_ENTRIES,
  });
  const group: BcProjectionGroup = {
    projectionName: "items",
    projectionRevision,
    sourceContextNames: ["target"],
    ownedTables: ["projected_items"],
    resetStrategy: "truncate-owned-tables",
    requiredDuringBootstrap: true,
    ...(hooks.onReset ? { reset: defineBcProjectionGroupReset(async (db: PgQueryable) => hooks.onReset!(db)) } : {}),
  };
  const module: BcApiModule<TargetServices, PgTransactionalPool, TargetHostPorts> = {
    ...base,
    seedProfiles: ["critical-bootstrap"],
    seed: async () => undefined,
    buildProjectionGroups: () => [group],
    projectionHandlerSets: () => [
      {
        projectionName: "items",
        eventTypes: ["target.item-recorded"],
        handlers: {
          "target.item-recorded": async (event, context) => {
            const itemId = String((event.data as { itemId: string }).itemId);
            await hooks.beforeProject?.(itemId);
            await context!.db!.query("INSERT INTO projected_items (item_id) VALUES ($1)", [itemId]);
          },
        },
      },
    ],
  };
  return [
    {
      contextName: "target",
      packageName: "@chase-sets/synthetic-target",
      manifest: { contextName: "target", apiDeployables: ["platform-api"] },
      module,
    },
  ];
}

export function createInlineSeedDbFixture(databasePrefix: string) {
  const adminDatabaseUrl = process.env.TEST_DATABASE_URL!;
  let pools!: InlineSeedDbPools;
  return {
    pools: () => pools,
    beforeAll: async () => {
      const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl, ["platform", "target"], databasePrefix);
      await ensureMultiContextTestDatabases(adminDatabaseUrl, urls);
      pools = createMultiContextTestPools(urls);
    },
    beforeEach: async () => {
      await resetMultiContextTestSchemas(pools);
      await pools.platform.query(platformControlPlaneSchemaSql);
      await bootstrapPlatformControlPlane(pools.platform);
      await bootstrapContextDatabase(createTargetRegistry({})[0]!.module, pools.target);
    },
    afterAll: async () => {
      await closeMultiContextTestPools(pools);
    },
  };
}

export type LeaseTraceEntry = Readonly<{
  operation: "acquired" | "missed" | "renewed" | "renewal-refused" | "released";
  ownerId: string;
  fencingToken: string | null;
}>;

/** Wraps the real Postgres control plane and records every lease call in order. */
export function createRecordingControlPlane(pool: PgTransactionalPool) {
  const controlPlane = createPostgresPlatformControlPlane(pool);
  const trace: LeaseTraceEntry[] = [];
  const renewals: Promise<boolean>[] = [];
  const recording: PlatformControlPlane = {
    ...controlPlane,
    acquireLease: async (input) => {
      const lease = await controlPlane.acquireLease(input);
      trace.push({
        operation: lease ? "acquired" : "missed",
        ownerId: input.ownerId,
        fencingToken: lease?.fencingToken ?? null,
      });
      return lease;
    },
    renewLease: (lease, ttlMs) => {
      const renewal = controlPlane.renewLease(lease, ttlMs).then((renewed) => {
        trace.push({
          operation: renewed ? "renewed" : "renewal-refused",
          ownerId: lease.ownerId,
          fencingToken: lease.fencingToken,
        });
        return renewed;
      });
      renewals.push(renewal);
      return renewal;
    },
    releaseLease: async (lease) => {
      await controlPlane.releaseLease(lease);
      trace.push({ operation: "released", ownerId: lease.ownerId, fencingToken: lease.fencingToken });
    },
  };
  const seedAttempts = () =>
    trace.filter(
      (entry) => entry.ownerId === SEED_OWNER && (entry.operation === "acquired" || entry.operation === "missed"),
    ).length;
  return { controlPlane, recording, trace, renewals, seedAttempts };
}

export async function appendTargetItem(pools: InlineSeedDbPools, itemId: string): Promise<void> {
  await createPostgresEventStore({ pool: pools.target }).appendToStream({
    streamId: `target.item-${itemId}`,
    expectedVersion: "no_stream",
    context: {
      tenantId: "tenant_test" as never,
      audit: { performedByUserId: "user_test" as never, forAccountId: "account_test" as never },
    },
    events: [{ eventType: "target.item-recorded", payload: { itemId } }],
  });
}

export function seedTarget(
  pools: InlineSeedDbPools,
  registry: ApiContextRegistry,
  controlPlane: PlatformControlPlane,
  options: Partial<Pick<ApiHostSeedOptions, "substepTimeoutMs">> = {},
): Promise<void> {
  return seedApiHostIfEmpty(registry, "platform-api", createApiHost(registry, "platform-api", { pools }), {
    enabledDataProfiles: ["critical-bootstrap"],
    environmentName: "test",
    fullBootstrapDrain: true,
    ...options,
    projectionGroupLeasePort: createProjectionGroupLeasePort(controlPlane, "platform-api"),
  });
}

export async function readProjectedItems(pools: InlineSeedDbPools): Promise<readonly string[]> {
  const result = await pools.target.query<{ item_id: string }>("SELECT item_id FROM projected_items ORDER BY item_id");
  return result.rows.map((row) => row.item_id);
}

export async function readTargetCheckpoint(pools: InlineSeedDbPools) {
  const result = await pools.target.query<{
    checkpoint: string | number | bigint;
    lease_owner_id: string | null;
    lease_fencing_token: string | number | bigint | null;
  }>(
    `SELECT last_global_position AS checkpoint, lease_owner_id, lease_fencing_token
     FROM event_subscription_checkpoints WHERE checkpoint_key = $1`,
    [TARGET_CHECKPOINT_KEY],
  );
  const row = result.rows[0];
  return row
    ? {
        checkpoint: String(row.checkpoint),
        ownerId: row.lease_owner_id,
        fencingToken: row.lease_fencing_token == null ? null : String(row.lease_fencing_token),
      }
    : null;
}

export async function readTargetLeases(controlPlane: PlatformControlPlane) {
  return (await controlPlane.listLeases())
    .filter((lease) => lease.lease_name === TARGET_LEASE_NAME)
    .map((lease) => ({ ownerId: lease.owner_id, fencingToken: String(lease.fencing_token) }));
}

/** A held lease another owner keeps until `release()`; `ttlMs` without renewal lets it expire. */
export async function holdTargetLease(
  controlPlane: PlatformControlPlane,
  ownerId: string,
  options: Readonly<{ ttlMs?: number; metadata?: Record<string, unknown> }> = {},
) {
  const lease: PlatformLease | null = await controlPlane.acquireLease({
    leaseName: TARGET_LEASE_NAME,
    ownerId,
    ttlMs: options.ttlMs ?? 120_000,
    metadata: options.metadata,
  });
  if (!lease) throw new Error(`Test holder '${ownerId}' could not acquire ${TARGET_LEASE_NAME}.`);
  return { lease, release: () => controlPlane.releaseLease(lease) };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
