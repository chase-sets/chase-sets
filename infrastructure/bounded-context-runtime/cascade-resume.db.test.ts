import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defineBoundedContextModule,
  type BcApiModule,
  type BcEventSubscription,
} from "@chase-sets/bounded-context-module";
import type { ProjectionRunContext } from "@chase-sets/event-core/projector";
import {
  createPostgresEventStore,
  runBoundedProjectionCascade,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase, createSubscriptionRunner } from "./index";
import { loadSubscriptionCheckpoint } from "./subscription-store";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "./test-support";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

type TestContextName = "source" | "target";
type TestServices = Readonly<{ pool: PgTransactionalPool }>;

const CASCADE_CHUNK_SIZE = 2;

const sourceModule = defineBoundedContextModule<TestServices, PgTransactionalPool, Record<string, never>>({
  manifest: { contextName: "source", apiBasePath: "/source", streamPrefix: "source." },
  schemaSql: "",
  createServices: (pool) => ({ pool }),
  buildApis: () => [],
});

function createCascadeSubscription(): BcEventSubscription {
  return {
    subscriptionName: "target.pages",
    sourceContextName: "source",
    projectionName: "pages",
    subscriptionVersion: 1,
    eventTypes: ["source.structure-changed", "source.marker"],
    streamPrefixes: ["source."],
    batchSize: 10,
    checkpointBatchSize: 1,
    projectionCascadeChunkSize: CASCADE_CHUNK_SIZE,
    handlers: {
      // A structural event fans out to every page — the discovery cascade shape.
      "source.structure-changed": async (_event, context) => {
        const db = context?.db;
        if (!db) {
          throw new Error("handler requires a db context");
        }
        const rows = await db.query<{ page_id: string }>(`SELECT page_id FROM cascade_pages ORDER BY page_id`);
        const pageIds = rows.rows.map((row) => row.page_id);
        await runBoundedProjectionCascade(pageIds, async (slice) => {
          for (const pageId of slice) {
            await db.query(`UPDATE cascade_pages SET refreshed_count = refreshed_count + 1 WHERE page_id = $1`, [
              pageId,
            ]);
          }
        });
      },
      // A later cheap event whose processing proves the checkpoint did not skip
      // over the in-progress cascade.
      "source.marker": async (event, context) => {
        const db = context?.db;
        if (!db) {
          throw new Error("handler requires a db context");
        }
        await db.query(`INSERT INTO cascade_markers (marker_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
          String(event.data.markerId),
        ]);
      },
    },
  };
}

function createTargetModule(): BcApiModule<TestServices, PgTransactionalPool, Record<string, never>> {
  return defineBoundedContextModule<TestServices, PgTransactionalPool, Record<string, never>>({
    manifest: {
      contextName: "target",
      apiBasePath: "/target",
      streamPrefix: "target.",
      eventSubscriptions: [
        {
          sourceContextName: "source",
          projectionName: "pages",
          subscriptionVersion: 1,
          projectionHandlerSetNames: ["pages"],
          eventTypes: ["source.structure-changed", "source.marker"],
          streamPrefixes: ["source."],
          batchSize: 10,
          checkpointBatchSize: 1,
          projectionCascadeChunkSize: CASCADE_CHUNK_SIZE,
        },
      ],
      projectionGroups: [
        {
          projectionName: "pages",
          sourceContextNames: ["source"],
          ownedTables: ["cascade_pages", "cascade_markers"],
          resetStrategy: "truncate-owned-tables",
        },
      ],
    },
    schemaSql: `
      CREATE TABLE IF NOT EXISTS cascade_pages (
        page_id text PRIMARY KEY,
        refreshed_count integer NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS cascade_markers (
        marker_id text PRIMARY KEY
      );
    `,
    createServices: (pool) => ({ pool }),
    buildApis: () => [],
    buildSubscriptions: () => [createCascadeSubscription()],
  });
}

function createProjectionRunContext(overrides: Partial<ProjectionRunContext> = {}): ProjectionRunContext {
  return {
    ownerId: "cascade-db-test",
    fencingToken: "1",
    throwIfLeaseLost: () => undefined,
    ...overrides,
  };
}

function createEventStoreContext() {
  return {
    tenantId: "tenant_test" as never,
    audit: { performedByUserId: "user_test" as never, forAccountId: "account_test" as never },
  };
}

describeDb("bounded cascade resume Postgres integration", () => {
  let pools: Readonly<Record<TestContextName, PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["source", "target"], "cascade_resume");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(sourceModule, pools.source);
    await bootstrapContextDatabase(createTargetModule(), pools.target);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function seedPages(count: number): Promise<void> {
    for (let index = 1; index <= count; index += 1) {
      await pools.target.query(`INSERT INTO cascade_pages (page_id, refreshed_count) VALUES ($1, 0)`, [`p${index}`]);
    }
  }

  async function readPages(): Promise<readonly { page_id: string; refreshed_count: number }[]> {
    const result = await pools.target.query<{ page_id: string; refreshed_count: number }>(
      `SELECT page_id, refreshed_count FROM cascade_pages ORDER BY page_id`,
    );
    return result.rows;
  }

  async function readMarkers(): Promise<readonly string[]> {
    const result = await pools.target.query<{ marker_id: string }>(
      `SELECT marker_id FROM cascade_markers ORDER BY marker_id`,
    );
    return result.rows.map((row) => row.marker_id);
  }

  function runner() {
    const runtime = createMountedContextTestRuntime([
      { contextName: "source", module: sourceModule, pool: pools.source, ports: {} },
      { contextName: "target", module: createTargetModule(), pool: pools.target, ports: {} },
    ]);
    return runtime.subscriptionRunners[0]!;
  }

  it("drains a large cascade across passes, advancing the checkpoint only once the cascade completes, exactly once", async () => {
    await seedPages(5);
    const sourceEventStore = createPostgresEventStore({ pool: pools.source });
    await sourceEventStore.appendToStream({
      streamId: "source.structure-a",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [{ eventType: "source.structure-changed", payload: {} }],
    });

    const context = createProjectionRunContext();
    const subscriptionRunner = runner();

    // Pass 1: only the first CHUNK pages refresh; the checkpoint stays pinned
    // before the event (it is not yet applied).
    const first = await subscriptionRunner.runOnce(context);
    expect(first.processed).toBeGreaterThan(0);
    expect(await loadSubscriptionCheckpoint(pools.target, subscriptionRunner.checkpointKey)).toBeNull();
    expect(await readPages()).toEqual([
      { page_id: "p1", refreshed_count: 1 },
      { page_id: "p2", refreshed_count: 1 },
      { page_id: "p3", refreshed_count: 0 },
      { page_id: "p4", refreshed_count: 0 },
      { page_id: "p5", refreshed_count: 0 },
    ]);

    // Pass 2: resume from the durable cursor.
    await subscriptionRunner.runOnce(context);
    expect(await loadSubscriptionCheckpoint(pools.target, subscriptionRunner.checkpointKey)).toBeNull();
    expect((await readPages()).map((row) => row.refreshed_count)).toEqual([1, 1, 1, 1, 0]);

    // Pass 3: the last page completes the cascade, the event is applied, and the
    // checkpoint finally advances. Every page refreshed exactly once (idempotent).
    await subscriptionRunner.runOnce(context);
    expect(await loadSubscriptionCheckpoint(pools.target, subscriptionRunner.checkpointKey)).toBe("1");
    expect((await readPages()).map((row) => row.refreshed_count)).toEqual([1, 1, 1, 1, 1]);

    // Cascade progress rows are cleaned up on completion.
    const progress = await pools.target.query(
      `SELECT 1 FROM event_projection_cascade_progress WHERE projection_key = $1`,
      [subscriptionRunner.checkpointKey],
    );
    expect(progress.rows).toHaveLength(0);

    // A further pass is a clean no-op (caught up).
    const afterCaughtUp = await subscriptionRunner.runOnce(context);
    expect(afterCaughtUp.processed).toBe(0);
  });

  it("does not process later events until the in-progress cascade completes", async () => {
    await seedPages(3);
    const sourceEventStore = createPostgresEventStore({ pool: pools.source });
    await sourceEventStore.appendToStream({
      streamId: "source.structure-a",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [{ eventType: "source.structure-changed", payload: {} }],
    });
    await sourceEventStore.appendToStream({
      streamId: "source.marker-a",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [{ eventType: "source.marker", payload: { markerId: "m1" } }],
    });

    const context = createProjectionRunContext();
    const subscriptionRunner = runner();

    // Pass 1: the cascade (3 pages, chunk size 2) is incomplete, so the later
    // marker event must NOT be processed and the checkpoint stays pinned.
    await subscriptionRunner.runOnce(context);
    expect(await loadSubscriptionCheckpoint(pools.target, subscriptionRunner.checkpointKey)).toBeNull();
    expect(await readMarkers()).toEqual([]);
    expect((await readPages()).map((row) => row.refreshed_count)).toEqual([1, 1, 0]);

    // Pass 2: the cascade completes (page 3), the structural event is applied,
    // and only then is the marker event processed in the same pass.
    await subscriptionRunner.runOnce(context);
    expect(await loadSubscriptionCheckpoint(pools.target, subscriptionRunner.checkpointKey)).toBe("2");
    expect(await readMarkers()).toEqual(["m1"]);
    expect((await readPages()).map((row) => row.refreshed_count)).toEqual([1, 1, 1]);
  });
});
