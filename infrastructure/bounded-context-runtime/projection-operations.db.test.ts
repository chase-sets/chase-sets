import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineBoundedContextModule, type BcApiModule } from "@chase-sets/bounded-context-module";
import type { ProjectionRunContext } from "@chase-sets/event-core/projector";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { bootstrapContextDatabase, rebuildContextProjectionGroup, retryProjectionBlockedStream } from "./index";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "./test-support";
import { withProjectionTransaction } from "./projection-transactions";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = adminDatabaseUrl ? describe : describe.skip;

type TestContextName = "source" | "target";
type TestServices = Readonly<{ pool: PgTransactionalPool }>;
type TestPorts = { failProjectionOnce?: () => boolean };

const sourceModule = defineBoundedContextModule<TestServices, PgTransactionalPool, TestPorts>({
  manifest: {
    contextName: "source",
    apiBasePath: "/source",
    streamPrefix: "source.",
  },
  schemaSql: "",
  createServices: (pool) => ({ pool }),
  buildApis: () => [],
});

function createTargetModule(): BcApiModule<TestServices, PgTransactionalPool, TestPorts> {
  return defineBoundedContextModule<TestServices, PgTransactionalPool, TestPorts>({
    manifest: {
      contextName: "target",
      apiBasePath: "/target",
      streamPrefix: "target.",
      projectionGroups: [
        {
          projectionName: "items",
          sourceContextNames: ["source"],
          ownedTables: ["projected_items"],
          resetStrategy: "truncate-owned-tables",
        },
      ],
    },
    schemaSql: `
      CREATE TABLE IF NOT EXISTS projected_items (
        item_id text PRIMARY KEY,
        seen_count integer NOT NULL
      );
    `,
    createServices: (pool) => ({ pool }),
    buildApis: () => [],
    buildSubscriptions: () => [
      {
        subscriptionName: "target.items",
        sourceContextName: "source",
        projectionName: "items",
        subscriptionVersion: 1,
        eventTypes: ["source.item-recorded"],
        streamPrefixes: ["source.item-"],
        batchSize: 10,
        checkpointBatchSize: 1,
        handlers: {
          "source.item-recorded": async (event, context) => {
            if (targetPorts.failProjectionOnce?.()) {
              throw new Error("first projection attempt failed");
            }
            if (!context?.db) {
              throw new Error("Projection handler requires a database context.");
            }

            await context.db.query(
              `INSERT INTO projected_items (item_id, seen_count)
               VALUES ($1, 1)
               ON CONFLICT (item_id)
               DO UPDATE SET seen_count = projected_items.seen_count + 1`,
              [String(event.data.itemId)],
            );
          },
        },
      },
    ],
  });
}

const targetPorts: TestPorts = {};

describeDb("projection operations Postgres integration", () => {
  let pools: Readonly<Record<TestContextName, PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      ["source", "target"],
      "projection_operations",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
  });

  beforeEach(async () => {
    targetPorts.failProjectionOnce = undefined;
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(sourceModule, pools.source);
    await bootstrapContextDatabase(createTargetModule(), pools.target);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("rebuilds a projection group and retries a blocked stream with statementTimeoutMs set", async () => {
    const runtime = createMountedContextTestRuntime([
      { contextName: "source", module: sourceModule, pool: pools.source, ports: {} },
      { contextName: "target", module: createTargetModule(), pool: pools.target, ports: targetPorts },
    ]);
    const sourceEventStore = createPostgresEventStore({ pool: pools.source });
    const context = createProjectionRunContext();

    await sourceEventStore.appendToStream({
      streamId: "source.item-1",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [
        {
          eventType: "source.item-recorded",
          payload: { itemId: "item-1" },
        },
      ],
    });

    await expect(rebuildContextProjectionGroup(runtime, "target", "items", context)).resolves.toBeUndefined();
    await expect(readProjectedItems()).resolves.toEqual([{ item_id: "item-1", seen_count: 1 }]);

    let shouldFail = true;
    targetPorts.failProjectionOnce = () => {
      const result = shouldFail;
      shouldFail = false;
      return result;
    };
    await sourceEventStore.appendToStream({
      streamId: "source.item-2",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [
        {
          eventType: "source.item-recorded",
          payload: { itemId: "item-2" },
        },
      ],
    });

    const runner = runtime.subscriptionRunners[0];
    await expect(runner.runOnce(context)).resolves.toMatchObject({
      processed: 1,
      blockedStreams: 1,
      poisonEvents: 1,
    });

    await expect(
      retryProjectionBlockedStream(runtime, runner.checkpointKey, "source.item-2", context),
    ).resolves.toMatchObject({
      projectionKey: runner.checkpointKey,
      streamId: "source.item-2",
      state: "resolved",
      inspectedEvents: 1,
      appliedEvents: 1,
      errorMessage: null,
    });
    await expect(readProjectedItems()).resolves.toEqual([
      { item_id: "item-1", seen_count: 1 },
      { item_id: "item-2", seen_count: 1 },
    ]);
  });

  it("applies statementTimeoutMs inside the active transaction", async () => {
    await expect(
      withProjectionTransaction(
        pools.target,
        createProjectionRunContext({ statementTimeoutMs: 25 }),
        async (client) => {
          await client.query("SELECT pg_sleep(1)");
        },
      ),
    ).rejects.toMatchObject({ code: "57014" });
  });

  async function readProjectedItems(): Promise<readonly { item_id: string; seen_count: number }[]> {
    const result = await pools.target.query<{ item_id: string; seen_count: number }>(
      `SELECT item_id, seen_count
       FROM projected_items
       ORDER BY item_id`,
    );
    return result.rows;
  }
});

function createProjectionRunContext(overrides: Partial<ProjectionRunContext> = {}): ProjectionRunContext {
  return {
    operationId: "op_statement_timeout_test",
    ownerId: "projection-db-test",
    fencingToken: "1",
    statementTimeoutMs: 250,
    throwIfLeaseLost: () => undefined,
    ...overrides,
  };
}

function createEventStoreContext() {
  return {
    tenantId: "tenant_test" as never,
    audit: {
      performedByUserId: "user_test" as never,
      forAccountId: "account_test" as never,
    },
  };
}
