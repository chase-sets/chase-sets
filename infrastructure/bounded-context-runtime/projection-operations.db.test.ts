import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defineBoundedContextModule,
  type BcApiModule,
  type BcEventSubscription,
} from "@chase-sets/bounded-context-module";
import type { ProjectionRunContext } from "@chase-sets/event-core/projector";
import {
  EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
  createPostgresEventStore,
  type PgPoolClient,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  bootstrapContextDatabase,
  createSubscriptionRunner,
  rebuildAllContextProjectionGroups,
  rebuildContextProjectionGroup,
  resetProjectionGroup,
  retryProjectionBlockedStream,
} from "./index";
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
type TestOrderCommands = Readonly<{
  createOrderForSource: (input: Readonly<{ sourceId: string; context: EventStoreContext }>) => Promise<string>;
}>;
type TestServices = Readonly<{ pool: PgTransactionalPool; orderCommands?: TestOrderCommands }>;
type TestPorts = {
  beforeProjectionWrite?: (itemId: string) => Promise<void>;
  failProjectionOnce?: () => boolean;
  failReactionAfterDispatchOnce?: () => boolean;
  createOrderId?: () => string;
};

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
    buildSubscriptions: () => [createItemsSubscription()],
  });
}

function createReactionTargetModule(): BcApiModule<TestServices, PgTransactionalPool, TestPorts> {
  return defineBoundedContextModule<TestServices, PgTransactionalPool, TestPorts>({
    manifest: {
      contextName: "target",
      apiBasePath: "/target",
      streamPrefix: "target.",
      projectionGroups: [
        {
          projectionName: "orders-reaction",
          handlerKind: "reaction",
          sourceContextNames: ["source"],
          ownedTables: [],
          sideEffectOnly: true,
        },
      ],
    },
    schemaSql: `
      CREATE TABLE IF NOT EXISTS reaction_orders (
        source_id text PRIMARY KEY,
        order_id text NOT NULL
      );
    `,
    createServices: (pool, ports) => ({
      pool,
      orderCommands: createReactionOrderCommands(pool, ports),
    }),
    buildApis: () => [],
    buildSubscriptions: (services) => [createOrderReactionSubscription(services)],
  });
}

function createItemsSubscription(): BcEventSubscription {
  return {
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

        const itemId = String(event.data.itemId);
        await targetPorts.beforeProjectionWrite?.(itemId);
        await context.db.query(
          `INSERT INTO projected_items (item_id, seen_count)
           VALUES ($1, 1)
           ON CONFLICT (item_id)
           DO UPDATE SET seen_count = projected_items.seen_count + 1`,
          [itemId],
        );
      },
    },
  };
}

function createOrderReactionSubscription(services: TestServices): BcEventSubscription {
  return {
    subscriptionName: "target.order-reaction",
    handlerKind: "reaction",
    sourceContextName: "source",
    projectionName: "orders-reaction",
    subscriptionVersion: 1,
    eventTypes: ["source.order-requested"],
    streamPrefixes: ["source.order-request-"],
    batchSize: 10,
    checkpointBatchSize: 10,
    errorPolicy: "global-strict",
    handlers: {
      "source.order-requested": async (event) => {
        const sourceId = String(event.data.sourceId);
        if (await hasReactionOrderForSource(services.pool, sourceId)) {
          return;
        }

        await services.orderCommands?.createOrderForSource({
          sourceId,
          context: {
            tenantId: event.tenantId,
            audit: event.audit,
            ...(event.trace ? { trace: event.trace } : {}),
          },
        });

        if (targetPorts.failReactionAfterDispatchOnce?.()) {
          throw new Error("reaction failed after command dispatch");
        }
      },
    },
  };
}

function createReactionOrderCommands(pool: PgTransactionalPool, ports: TestPorts | undefined): TestOrderCommands {
  const eventStore = createPostgresEventStore({ pool });

  return {
    createOrderForSource: async ({ sourceId, context }) => {
      const existingOrderId = await hasReactionOrderForSource(pool, sourceId);
      if (existingOrderId) {
        return existingOrderId;
      }

      const orderId = ports?.createOrderId?.() ?? `ord_${Date.now()}`;
      await eventStore.appendToStream({
        streamId: `target.order-${orderId}`,
        expectedVersion: "no_stream",
        context,
        events: [
          {
            eventType: "target.order-created",
            payload: { orderId, sourceId },
          },
        ],
      });
      await pool.query(
        `INSERT INTO reaction_orders (source_id, order_id)
         VALUES ($1, $2)
         ON CONFLICT (source_id) DO NOTHING`,
        [sourceId, orderId],
      );

      return orderId;
    },
  };
}

async function hasReactionOrderForSource(db: PgTransactionalPool, sourceId: string): Promise<string | null> {
  const result = await db.query<{ order_id: string }>(
    `SELECT order_id
     FROM reaction_orders
     WHERE source_id = $1`,
    [sourceId],
  );

  return result.rows[0]?.order_id ?? null;
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
    targetPorts.beforeProjectionWrite = undefined;
    targetPorts.failProjectionOnce = undefined;
    targetPorts.failReactionAfterDispatchOnce = undefined;
    targetPorts.createOrderId = undefined;
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

    await sourceEventStore.appendToStream({
      streamId: "source.item-3",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [
        {
          eventType: "source.item-recorded",
          payload: { itemId: "item-3" },
        },
      ],
    });

    await expect(rebuildAllContextProjectionGroups(runtime, "target", {}, context)).resolves.toBeUndefined();
    await expect(readProjectedItems()).resolves.toEqual([
      { item_id: "item-1", seen_count: 1 },
      { item_id: "item-2", seen_count: 1 },
      { item_id: "item-3", seen_count: 1 },
    ]);
  });

  it("does not checkpoint past an in-flight lower global position", async () => {
    const runtime = createMountedContextTestRuntime([
      { contextName: "source", module: sourceModule, pool: pools.source, ports: {} },
      { contextName: "target", module: createTargetModule(), pool: pools.target, ports: targetPorts },
    ]);
    const sourceEventStore = createPostgresEventStore({ pool: pools.source });
    const runner = runtime.subscriptionRunners[0];
    const context = createProjectionRunContext();
    const lowPositionClient = await beginUncommittedSourceAppendWithSharedFence(pools.source);
    let lowPositionClientReleased = false;

    const appendHighPosition = sourceEventStore.appendToStream({
      streamId: "source.item-high",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [
        {
          eventType: "source.item-recorded",
          payload: { itemId: "item-high" },
        },
      ],
    });

    try {
      await expect(hasSettledWithin(appendHighPosition, 250)).resolves.toBe(true);
      await appendHighPosition;
      const catchUp = runner.runOnce(context);
      await expect(hasSettledWithin(catchUp, 50)).resolves.toBe(false);
      await expect(loadSubscriptionCheckpoint(runner.checkpointKey)).resolves.toBeNull();
      await expect(readProjectedItems()).resolves.toEqual([]);

      await lowPositionClient.query("COMMIT");
      lowPositionClient.release();
      lowPositionClientReleased = true;

      await expect(catchUp).resolves.toMatchObject({
        processed: 2,
        lastGlobalPosition: "2",
      });
      await expect(loadSubscriptionCheckpoint(runner.checkpointKey)).resolves.toBe("2");
      await expect(readProjectedItems()).resolves.toEqual([
        { item_id: "item-high", seen_count: 1 },
        { item_id: "item-low", seen_count: 1 },
      ]);
    } finally {
      if (!lowPositionClientReleased) {
        await lowPositionClient.query("ROLLBACK").catch(() => undefined);
        lowPositionClient.release();
      }
      await appendHighPosition.catch(() => undefined);
    }
  });

  it("serializes same-subscription runners through the application ledger", async () => {
    const runtime = createMountedContextTestRuntime([
      { contextName: "source", module: sourceModule, pool: pools.source, ports: {} },
      { contextName: "target", module: createTargetModule(), pool: pools.target, ports: targetPorts },
    ]);
    const sourceEventStore = createPostgresEventStore({ pool: pools.source });
    const primaryRunner = runtime.subscriptionRunners[0];
    const competingRunner = createSubscriptionRunner("target", pools.target, pools.source, createItemsSubscription());
    const projectionAttempts: string[] = [];
    const firstProjectionStarted = createDeferred<void>();
    const releaseFirstProjection = createDeferred<void>();

    targetPorts.beforeProjectionWrite = async (itemId) => {
      projectionAttempts.push(itemId);
      firstProjectionStarted.resolve();
      await releaseFirstProjection.promise;
    };

    await sourceEventStore.appendToStream({
      streamId: "source.item-race",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [
        {
          eventType: "source.item-recorded",
          payload: { itemId: "item-race" },
        },
      ],
    });

    const primaryRun = primaryRunner.runOnce();
    await firstProjectionStarted.promise;
    const competingRun = competingRunner.runOnce();

    await expect(hasSettledWithin(competingRun, 50)).resolves.toBe(false);
    releaseFirstProjection.resolve();

    await expect(Promise.all([primaryRun, competingRun])).resolves.toEqual([
      expect.objectContaining({ processed: 1, lastGlobalPosition: "1" }),
      expect.objectContaining({ processed: 1, lastGlobalPosition: "1" }),
    ]);
    await expect(readProjectedItems()).resolves.toEqual([{ item_id: "item-race", seen_count: 1 }]);
    expect(projectionAttempts).toEqual(["item-race"]);
    await expect(readSubscriptionApplicationRows(primaryRunner.checkpointKey)).resolves.toEqual([
      { event_id: expect.any(String), status: "applied" },
    ]);
    await expect(loadSubscriptionCheckpoint(primaryRunner.checkpointKey)).resolves.toBe("1");
  });

  it("batch-applies clean subscription events with bounded DB round trips", async () => {
    const targetQueries: string[] = [];
    const sourceEventStore = createPostgresEventStore({ pool: pools.source });
    const targetPool = createQueryCapturePool(pools.target, targetQueries);
    const runner = createSubscriptionRunner("target", targetPool, pools.source, {
      ...createItemsSubscription(),
      batchSize: 100,
      checkpointBatchSize: 100,
    });

    for (const itemId of ["item-batch-1", "item-batch-2", "item-batch-3", "item-batch-4", "item-batch-5"]) {
      await sourceEventStore.appendToStream({
        streamId: `source.${itemId}`,
        expectedVersion: "no_stream",
        context: createEventStoreContext(),
        events: [
          {
            eventType: "source.item-recorded",
            payload: { itemId },
          },
        ],
      });
    }

    await expect(runner.runOnce(createProjectionRunContext())).resolves.toMatchObject({
      processed: 5,
      lastGlobalPosition: "5",
      blockedStreams: 0,
      poisonEvents: 0,
    });
    await expect(readProjectedItems()).resolves.toEqual([
      { item_id: "item-batch-1", seen_count: 1 },
      { item_id: "item-batch-2", seen_count: 1 },
      { item_id: "item-batch-3", seen_count: 1 },
      { item_id: "item-batch-4", seen_count: 1 },
      { item_id: "item-batch-5", seen_count: 1 },
    ]);
    await expect(readSubscriptionApplicationRows(runner.checkpointKey)).resolves.toHaveLength(5);
    await expect(loadSubscriptionCheckpoint(runner.checkpointKey)).resolves.toBe("5");

    expect(targetQueries.filter((sql) => sql.includes("INSERT INTO event_subscription_applications"))).toHaveLength(1);
    expect(
      targetQueries.filter((sql) => sql.includes("SELECT event_id, status") && sql.includes("FOR UPDATE")),
    ).toHaveLength(1);
    expect(targetQueries.filter((sql) => sql.includes("UPDATE event_subscription_applications"))).toHaveLength(2);
    expect(
      targetQueries.filter(
        (sql) => sql.includes("FROM event_projection_blocked_streams") && sql.includes("stream_id = ANY"),
      ),
    ).toHaveLength(1);
    expect(
      targetQueries.filter(
        (sql) => sql.includes("FROM event_projection_blocked_streams") && sql.includes("stream_id = $2"),
      ),
    ).toHaveLength(0);
    expect(targetQueries.filter((sql) => sql.includes("INSERT INTO event_subscription_checkpoints"))).toHaveLength(1);
  });

  it("isolates a poison event after batch apply failure", async () => {
    const sourceEventStore = createPostgresEventStore({ pool: pools.source });
    const runner = createSubscriptionRunner("target", pools.target, pools.source, {
      ...createItemsSubscription(),
      batchSize: 100,
      checkpointBatchSize: 100,
    });
    targetPorts.beforeProjectionWrite = async (itemId) => {
      if (itemId === "item-batch-bad") {
        throw new Error("batch item cannot be projected");
      }
    };

    for (const itemId of ["item-batch-good-1", "item-batch-bad", "item-batch-good-2"]) {
      await sourceEventStore.appendToStream({
        streamId: `source.${itemId}`,
        expectedVersion: "no_stream",
        context: createEventStoreContext(),
        events: [
          {
            eventType: "source.item-recorded",
            payload: { itemId },
          },
        ],
      });
    }

    await expect(runner.runOnce(createProjectionRunContext())).resolves.toMatchObject({
      processed: 3,
      lastGlobalPosition: "3",
      state: "degraded",
      blockedStreams: 1,
      poisonEvents: 1,
    });
    await expect(readProjectedItems()).resolves.toEqual([
      { item_id: "item-batch-good-1", seen_count: 1 },
      { item_id: "item-batch-good-2", seen_count: 1 },
    ]);
    await expect(readSubscriptionApplicationRows(runner.checkpointKey)).resolves.toEqual([
      { event_id: expect.any(String), status: "applied" },
      { event_id: expect.any(String), status: "poison" },
      { event_id: expect.any(String), status: "applied" },
    ]);
    await expect(loadSubscriptionCheckpoint(runner.checkpointKey)).resolves.toBe("3");
  });

  it("records projection transaction timeouts as transient and replays them", async () => {
    const sourceEventStore = createPostgresEventStore({ pool: pools.source });
    const runner = createSubscriptionRunner("target", pools.target, pools.source, createItemsSubscription());

    targetPorts.beforeProjectionWrite = async () => {
      await delay(550);
    };

    await sourceEventStore.appendToStream({
      streamId: "source.item-timeout",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [
        {
          eventType: "source.item-recorded",
          payload: { itemId: "item-timeout" },
        },
      ],
    });

    await expect(runner.runOnce(createProjectionRunContext({ transactionTimeoutMs: 500 }))).rejects.toThrow(
      "Projection transaction exceeded 500ms.",
    );
    await expect(readProjectedItems()).resolves.toEqual([]);
    await expect(readSubscriptionApplicationRows(runner.checkpointKey)).resolves.toEqual([
      { event_id: expect.any(String), status: "transient" },
    ]);
    await expect(loadSubscriptionCheckpoint(runner.checkpointKey)).resolves.toBeNull();

    targetPorts.beforeProjectionWrite = undefined;

    await expect(runner.runOnce(createProjectionRunContext())).resolves.toMatchObject({
      processed: 1,
      lastGlobalPosition: "1",
      blockedStreams: 0,
      poisonEvents: 0,
    });
    await expect(readProjectedItems()).resolves.toEqual([{ item_id: "item-timeout", seen_count: 1 }]);
    await expect(readSubscriptionApplicationRows(runner.checkpointKey)).resolves.toEqual([
      { event_id: expect.any(String), status: "applied" },
    ]);
    await expect(loadSubscriptionCheckpoint(runner.checkpointKey)).resolves.toBe("1");
  });

  it("rolls back owned-table and subscription-ledger reset when the rebuild lease is lost", async () => {
    const runtime = createMountedContextTestRuntime([
      { contextName: "source", module: sourceModule, pool: pools.source, ports: {} },
      { contextName: "target", module: createTargetModule(), pool: pools.target, ports: targetPorts },
    ]);
    const sourceEventStore = createPostgresEventStore({ pool: pools.source });
    const runner = runtime.subscriptionRunners[0];

    await sourceEventStore.appendToStream({
      streamId: "source.item-atomic",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [
        {
          eventType: "source.item-recorded",
          payload: { itemId: "item-atomic" },
        },
      ],
    });
    await expect(
      rebuildContextProjectionGroup(runtime, "target", "items", createProjectionRunContext()),
    ).resolves.toBeUndefined();
    await expect(readProjectedItems()).resolves.toEqual([{ item_id: "item-atomic", seen_count: 1 }]);
    await expect(loadSubscriptionCheckpoint(runner.checkpointKey)).resolves.toBe("1");
    await expect(countSubscriptionApplicationRows(runner.checkpointKey)).resolves.toBe(1);

    let leaseChecks = 0;
    const lostLeaseContext = createProjectionRunContext({
      throwIfLeaseLost: () => {
        leaseChecks += 1;
        if (leaseChecks >= 6) {
          throw new Error("projection reset lease lost after owned-table reset");
        }
      },
    });

    await expect(resetProjectionGroup(runtime.projectionGroups[0], lostLeaseContext)).rejects.toThrow(
      "projection reset lease lost after owned-table reset",
    );

    await expect(readProjectedItems()).resolves.toEqual([{ item_id: "item-atomic", seen_count: 1 }]);
    await expect(loadSubscriptionCheckpoint(runner.checkpointKey)).resolves.toBe("1");
    await expect(countSubscriptionApplicationRows(runner.checkpointKey)).resolves.toBe(1);
  });

  it("keeps reaction command dispatch atomic with the subscription application transaction", async () => {
    let nextOrderId = 1;
    let shouldFailAfterDispatch = true;
    targetPorts.createOrderId = () => `ord_${nextOrderId++}`;
    targetPorts.failReactionAfterDispatchOnce = () => {
      const result = shouldFailAfterDispatch;
      shouldFailAfterDispatch = false;
      return result;
    };
    await bootstrapContextDatabase(createReactionTargetModule(), pools.target);
    const runtime = createMountedContextTestRuntime([
      { contextName: "source", module: sourceModule, pool: pools.source, ports: {} },
      { contextName: "target", module: createReactionTargetModule(), pool: pools.target, ports: targetPorts },
    ]);
    const sourceEventStore = createPostgresEventStore({ pool: pools.source });
    const runner = runtime.subscriptionRunners[0];

    await sourceEventStore.appendToStream({
      streamId: "source.order-request-1",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [
        {
          eventType: "source.order-requested",
          payload: { sourceId: "offer-acceptance:off_1" },
        },
      ],
    });

    // The first (batch) attempt dispatches ord_1 and fails after dispatch; its
    // transaction rolls back and the pass re-executes the event individually
    // with a fresh transaction (issue #4751), dispatching ord_2. Atomicity is
    // proven by what is durably visible: ONLY ord_2 exists — the rolled-back
    // ord_1 dispatch never leaked a row or an event.
    await expect(runner.runOnce(createProjectionRunContext())).resolves.toMatchObject({
      processed: 1,
      lastGlobalPosition: "1",
      blockedStreams: 0,
      poisonEvents: 0,
    });
    await expect(readReactionOrders()).resolves.toEqual([{ source_id: "offer-acceptance:off_1", order_id: "ord_2" }]);
    await expect(readReactionOrderEvents()).resolves.toEqual([
      { event_type: "target.order-created", order_id: "ord_2", source_id: "offer-acceptance:off_1" },
    ]);
    await expect(readSubscriptionApplicationRows(runner.checkpointKey)).resolves.toEqual([
      { event_id: expect.any(String), status: "applied" },
    ]);

    await clearSubscriptionLedger(runner.checkpointKey);
    const replayRuntime = createMountedContextTestRuntime([
      { contextName: "source", module: sourceModule, pool: pools.source, ports: {} },
      { contextName: "target", module: createReactionTargetModule(), pool: pools.target, ports: targetPorts },
    ]);
    const replayRunner = replayRuntime.subscriptionRunners[0];

    await expect(replayRunner.runOnce(createProjectionRunContext())).resolves.toMatchObject({
      processed: 1,
      lastGlobalPosition: "1",
      blockedStreams: 0,
      poisonEvents: 0,
    });
    await expect(readReactionOrders()).resolves.toEqual([{ source_id: "offer-acceptance:off_1", order_id: "ord_2" }]);
    await expect(readReactionOrderEvents()).resolves.toEqual([
      { event_type: "target.order-created", order_id: "ord_2", source_id: "offer-acceptance:off_1" },
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

  async function readReactionOrders(): Promise<readonly { source_id: string; order_id: string }[]> {
    const result = await pools.target.query<{ source_id: string; order_id: string }>(
      `SELECT source_id, order_id
       FROM reaction_orders
       ORDER BY source_id`,
    );
    return result.rows;
  }

  async function readReactionOrderEvents(): Promise<
    readonly { event_type: string; order_id: string; source_id: string }[]
  > {
    const result = await pools.target.query<{
      event_type: string;
      order_id: string;
      source_id: string;
    }>(
      `SELECT event_type,
              payload->>'orderId' AS order_id,
              payload->>'sourceId' AS source_id
       FROM event_store_events
       WHERE event_type = 'target.order-created'
       ORDER BY global_position`,
    );
    return result.rows;
  }

  async function loadSubscriptionCheckpoint(checkpointKey: string): Promise<string | null> {
    const result = await pools.target.query<{ last_global_position: string | number | bigint }>(
      `SELECT last_global_position
       FROM event_subscription_checkpoints
       WHERE checkpoint_key = $1`,
      [checkpointKey],
    );

    return result.rows[0] ? String(result.rows[0].last_global_position) : null;
  }

  async function countSubscriptionApplicationRows(checkpointKey: string): Promise<number> {
    const result = await pools.target.query<{ count: string | number | bigint }>(
      `SELECT COUNT(*) AS count
       FROM event_subscription_applications
       WHERE projection_key = $1`,
      [checkpointKey],
    );

    return Number(result.rows[0]?.count ?? 0);
  }

  async function clearSubscriptionLedger(checkpointKey: string): Promise<void> {
    await pools.target.query(`DELETE FROM event_subscription_applications WHERE projection_key = $1`, [checkpointKey]);
    await pools.target.query(`DELETE FROM event_subscription_checkpoints WHERE checkpoint_key = $1`, [checkpointKey]);
  }

  async function readSubscriptionApplicationRows(
    checkpointKey: string,
  ): Promise<readonly { event_id: string; status: string }[]> {
    const result = await pools.target.query<{ event_id: string; status: string }>(
      `SELECT event_id, status
       FROM event_subscription_applications
       WHERE projection_key = $1
       ORDER BY global_position`,
      [checkpointKey],
    );

    return result.rows;
  }
});

async function beginUncommittedSourceAppendWithSharedFence(pool: PgTransactionalPool): Promise<PgPoolClient> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock_shared($1::bigint)", [
      EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
    ]);
    await client.query(
      `INSERT INTO event_store_streams (stream_id, current_version, updated_at)
       VALUES ('source.item-low', 0, $1::timestamptz)`,
      ["2026-06-28T12:00:00.000Z"],
    );
    await client.query(
      `INSERT INTO event_store_events (
         event_id,
         stream_id,
         stream_version,
         tenant_id,
         stream_context_name,
         stream_category,
         event_type,
         payload,
         metadata,
         occurred_at,
         recorded_at,
         performed_by_user_id,
         for_account_id
       ) VALUES (
         'evt_source_low',
         'source.item-low',
         1,
         'tenant_test',
         'source',
         'source.item',
         'source.item-recorded',
         '{"itemId":"item-low"}'::jsonb,
         '{}'::jsonb,
         $1::timestamptz,
         $1::timestamptz,
         'user_test',
         'account_test'
       )`,
      ["2026-06-28T12:00:00.000Z"],
    );
    await client.query(
      `UPDATE event_store_streams
       SET current_version = 1, updated_at = $2::timestamptz
       WHERE stream_id = $1`,
      ["source.item-low", "2026-06-28T12:00:00.000Z"],
    );

    return client;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release(error);
    throw error;
  }
}

async function hasSettledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

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

function createQueryCapturePool(pool: PgTransactionalPool, queries: string[]): PgTransactionalPool {
  return {
    idleInTransactionSessionTimeoutMillis: pool.idleInTransactionSessionTimeoutMillis,
    query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
      queries.push(String(sql));
      return pool.query<Row>(sql, params);
    },
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
          queries.push(String(sql));
          return client.query<Row>(sql, params);
        },
        release: (error?: unknown) => client.release(error),
      };
    },
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = (value) => promiseResolve(value as T | PromiseLike<T>);
  });

  return { promise, resolve };
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
