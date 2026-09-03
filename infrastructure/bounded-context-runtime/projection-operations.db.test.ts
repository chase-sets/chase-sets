import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  defineBoundedContextModule,
  type BcApiEntry,
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
import { parseGlobalPosition, type EventStoreContext } from "@chase-sets/event-core/storage";
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
import {
  createCheckpointKey,
  saveSubscriptionCheckpoint as savePersistedSubscriptionCheckpoint,
} from "./subscription-store";

const NO_API_ENTRIES: readonly BcApiEntry[] = [];

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
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
  buildApis: () => NO_API_ENTRIES,
});

function createTargetModule(): BcApiModule<TestServices, PgTransactionalPool, TestPorts> {
  return defineBoundedContextModule<TestServices, PgTransactionalPool, TestPorts>({
    manifest: {
      contextName: "target",
      apiBasePath: "/target",
      streamPrefix: "target.",
      eventSubscriptions: [
        {
          sourceContextName: "source",
          projectionName: "items",
          subscriptionVersion: 1,
          projectionHandlerSetNames: ["items"],
          eventTypes: ["source.item-recorded"],
          streamPrefixes: ["source.item-"],
          batchSize: 10,
          checkpointBatchSize: 1,
        },
      ],
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
    buildApis: () => NO_API_ENTRIES,
    buildSubscriptions: () => [createItemsSubscription()],
  });
}

function createReactionTargetModule(): BcApiModule<TestServices, PgTransactionalPool, TestPorts> {
  return defineBoundedContextModule<TestServices, PgTransactionalPool, TestPorts>({
    manifest: {
      contextName: "target",
      apiBasePath: "/target",
      streamPrefix: "target.",
      eventReactions: [
        {
          sourceContextName: "source",
          reactionName: "orders-reaction",
          subscriptionVersion: 1,
          reactionHandlerSetNames: ["orders-reaction"],
          idempotencyPolicy: "idempotent-command-dispatch",
          retryPolicy: "retry-from-last-checkpoint",
          failurePolicy: "surface-as-reaction-failure",
          eventTypes: ["source.order-requested"],
          streamPrefixes: ["source.order-request-"],
          errorPolicy: "global-strict",
        },
      ],
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
    buildApis: () => NO_API_ENTRIES,
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

  it("serializes first checkpoint saves before their statement snapshots", async () => {
    const subscription = createItemsSubscription();
    const checkpointKey = createCheckpointKey(subscription);
    const first = createControlledSavePool(pools.target, { holdBeforeCommit: true });
    const second = createControlledSavePool(pools.target);
    const firstSave = saveSubscriptionCheckpoint(first.pool, subscription, "10");
    let secondSave: Promise<void> | undefined;

    try {
      await first.checkpointCompleted.promise;
      secondSave = saveSubscriptionCheckpoint(second.pool, subscription, "1");
      await second.lockSubmitted.promise;

      const waitEvidence = await waitForBackendBlock(pools.target, first.backendPid, second.backendPid);
      expect(waitEvidence.blocking_pids).toContain(first.backendPid);
      expect(waitEvidence.wait_event_type).toBe("Lock");
      expect(waitEvidence.wait_event).toBe("advisory");
      expect(waitEvidence.locks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pid: first.backendPid, locktype: "advisory", granted: true }),
          expect.objectContaining({ pid: second.backendPid, locktype: "advisory", granted: false }),
        ]),
      );
      const firstLock = waitEvidence.locks.find((lock) => lock.pid === first.backendPid);
      const secondLock = waitEvidence.locks.find((lock) => lock.pid === second.backendPid);
      expect(secondLock).toMatchObject({
        database: firstLock?.database,
        classid: firstLock?.classid,
        objid: firstLock?.objid,
        objsubid: firstLock?.objsubid,
      });
      expect(second.checkpointStarted.resolved).toBe(false);

      const independentProjection = { ...subscription, projectionName: "other-items" };
      const independentVersion = { ...subscription, subscriptionVersion: 2 };
      const independentLockIds = await Promise.all(
        [subscription, independentProjection, independentVersion].map(async (candidate) => {
          const result = await pools.target.query<{ lock_id: string }>(
            "SELECT hashtextextended('event_subscription_checkpoints:' || $1::text, 0)::text AS lock_id",
            [createCheckpointKey(candidate)],
          );
          return result.rows[0]?.lock_id;
        }),
      );
      expect(new Set(independentLockIds).size).toBe(3);
      await expect(
        Promise.all([
          saveSubscriptionCheckpoint(pools.target, independentProjection, "3"),
          saveSubscriptionCheckpoint(pools.target, independentVersion, "4"),
          saveSubscriptionCheckpoint(pools.source, subscription, "5"),
        ]),
      ).resolves.toEqual([undefined, undefined, undefined]);

      first.releaseCommit.resolve();
      const settlements = await Promise.allSettled([firstSave, secondSave]);
      expect(settlements).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(first.checkpointQueries).toHaveLength(1);
      expect(second.checkpointQueries).toHaveLength(1);
      expect(first.checkpointQueries[0]?.params).toEqual([checkpointKey, "items", "source", 1, "10", null, null]);
      expect(second.checkpointQueries[0]?.params?.[4]).toBe("1");
      await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toMatchObject({
        checkpoint: "10",
        recoveryMarker: "10",
      });
      await expect(readCheckpointState(pools.source, checkpointKey)).resolves.toMatchObject({
        checkpoint: "5",
        recoveryMarker: "5",
      });

      const version = await pools.target.query<{ server_version: string }>("SHOW server_version");
      const indexes = await pools.target.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename = 'event_subscription_checkpoints'
         ORDER BY indexname`,
      );
      expect(version.rows[0]?.server_version).toMatch(/^\d+\.\d+/);
      expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
        "event_subscription_checkpoints_pkey",
        "event_subscription_checkpoints_projection_source_version_idx",
      ]);
      console.info(
        "checkpoint-serialization evidence",
        JSON.stringify({
          serverVersion: version.rows[0]?.server_version,
          indexes: indexes.rows,
          checkpointKey,
          firstBackendPid: first.backendPid,
          secondBackendPid: second.backendPid,
          waitEvidence,
          settlements,
          firstSql: first.checkpointQueries,
          secondSql: second.checkpointQueries,
          final: await readCheckpointState(pools.target, checkpointKey),
        }),
      );
    } finally {
      first.releaseCommit.resolve();
      await Promise.allSettled([firstSave, ...(secondSave ? [secondSave] : [])]);
    }
  });

  it("keeps checkpoint recovery decisions after the preceding save commits", async () => {
    const subscription = createItemsSubscription();
    const checkpointKey = createCheckpointKey(subscription);
    const committedFirst = createControlledSavePool(pools.target, { holdBeforeCommit: true });
    const bypassedSecond = createControlledSavePool(pools.target, { bypassCheckpointLock: true });
    const committedSave = saveSubscriptionCheckpoint(committedFirst.pool, subscription, "10");
    const controlledPools = [committedFirst, bypassedSecond];
    const savePromises: Promise<void>[] = [committedSave];
    let bypassedSave: Promise<void> | undefined;

    try {
      await committedFirst.checkpointCompleted.promise;
      bypassedSave = saveSubscriptionCheckpoint(bypassedSecond.pool, subscription, "1");
      savePromises.push(bypassedSave);
      await bypassedSecond.checkpointStarted.promise;
      const bypassWait = await waitForBackendBlock(pools.target, committedFirst.backendPid, bypassedSecond.backendPid);
      expect(bypassWait.blocking_pids).toContain(committedFirst.backendPid);
      expect(bypassWait.wait_event).not.toBe("advisory");

      committedFirst.releaseCommit.resolve();
      const bypassSettlements = await Promise.allSettled([committedSave, bypassedSave]);
      expect(bypassSettlements.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
      const bypassFinal = await readCheckpointState(pools.target, checkpointKey);
      expect(bypassFinal).toMatchObject({ checkpoint: "1", recoveryMarker: "10" });

      await clearCheckpointState(pools.target, checkpointKey);
      const rolledBackFirst = createControlledSavePool(pools.target, {
        holdBeforeCommit: true,
        failCommitBeforeQuery: new Error("synthetic pre-commit failure"),
      });
      const survivingSecond = createControlledSavePool(pools.target);
      controlledPools.push(rolledBackFirst, survivingSecond);
      const rolledBackSave = saveSubscriptionCheckpoint(rolledBackFirst.pool, subscription, "10");
      savePromises.push(rolledBackSave);
      await rolledBackFirst.checkpointCompleted.promise;
      const survivingSave = saveSubscriptionCheckpoint(survivingSecond.pool, subscription, "1");
      savePromises.push(survivingSave);
      await survivingSecond.lockSubmitted.promise;
      const rollbackWait = await waitForBackendBlock(
        pools.target,
        rolledBackFirst.backendPid,
        survivingSecond.backendPid,
      );
      rolledBackFirst.releaseCommit.resolve();
      const rollbackSettlements = await Promise.allSettled([rolledBackSave, survivingSave]);
      expect(rollbackSettlements).toEqual([
        { status: "rejected", reason: expect.objectContaining({ message: "synthetic pre-commit failure" }) },
        { status: "fulfilled", value: undefined },
      ]);
      const rollbackFinal = await readCheckpointState(pools.target, checkpointKey);
      expect(rollbackFinal).toMatchObject({ checkpoint: "1", recoveryMarker: "1" });

      await clearCheckpointState(pools.target, checkpointKey);
      const lowerFirst = createControlledSavePool(pools.target, { holdBeforeCommit: true });
      const higherSecond = createControlledSavePool(pools.target);
      controlledPools.push(lowerFirst, higherSecond);
      const lowerSave = saveSubscriptionCheckpoint(lowerFirst.pool, subscription, "1");
      savePromises.push(lowerSave);
      await lowerFirst.checkpointCompleted.promise;
      const higherSave = saveSubscriptionCheckpoint(higherSecond.pool, subscription, "10");
      savePromises.push(higherSave);
      await higherSecond.lockSubmitted.promise;
      await waitForBackendBlock(pools.target, lowerFirst.backendPid, higherSecond.backendPid);
      lowerFirst.releaseCommit.resolve();
      const reverseSettlements = await Promise.allSettled([lowerSave, higherSave]);
      expect(reverseSettlements.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
      const reverseFinal = await readCheckpointState(pools.target, checkpointKey);
      expect(reverseFinal).toMatchObject({ checkpoint: "10", recoveryMarker: "10" });

      console.info(
        "checkpoint-recovery evidence",
        JSON.stringify({
          checkpointKey,
          bypassWait,
          bypassSettlements,
          bypassFinal,
          rollbackWait,
          rollbackSettlements: rollbackSettlements.map(({ status }) => status),
          rollbackFinal,
          reverseSettlements,
          reverseFinal,
        }),
      );
    } finally {
      for (const controlledPool of controlledPools) {
        controlledPool.releaseCommit.resolve();
      }
      await Promise.allSettled(savePromises);
    }
  });

  it("preserves checkpoint recovery, owner, and nullable fence matrices", async () => {
    const subscription = createItemsSubscription();
    const checkpointKey = createCheckpointKey(subscription);

    await saveSubscriptionCheckpoint(pools.target, subscription, "2");
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toEqual({
      checkpoint: "2",
      recoveryMarker: "2",
      ownerId: null,
      fencingToken: null,
    });

    await clearCheckpointState(pools.target, checkpointKey);
    await seedCheckpointState(pools.target, subscription, {
      checkpoint: "10",
      recoveryMarker: "10",
      ownerId: "owner-a",
      fencingToken: "7",
    });
    await expect(
      saveSubscriptionCheckpoint(pools.target, subscription, "20", {
        ownerId: "older-owner",
        fencingToken: "6",
      }),
    ).rejects.toThrow("rejected stale lease fencing token");
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toEqual({
      checkpoint: "10",
      recoveryMarker: "10",
      ownerId: "owner-a",
      fencingToken: "7",
    });
    await saveSubscriptionCheckpoint(pools.target, subscription, "1", {
      ownerId: "equal-owner",
      fencingToken: "7",
    });
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toEqual({
      checkpoint: "10",
      recoveryMarker: "10",
      ownerId: "equal-owner",
      fencingToken: "7",
    });
    await saveSubscriptionCheckpoint(pools.target, subscription, "12", {
      ownerId: "newer-owner",
      fencingToken: "8",
    });
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toEqual({
      checkpoint: "12",
      recoveryMarker: "12",
      ownerId: "newer-owner",
      fencingToken: "8",
    });

    await clearCheckpointState(pools.target, checkpointKey);
    await seedCheckpointState(pools.target, subscription, {
      checkpoint: "10",
      recoveryMarker: null,
      ownerId: "before-recovery",
      fencingToken: "7",
    });
    await saveSubscriptionCheckpoint(pools.target, subscription, "1", {
      ownerId: "invalid-token-owner",
      fencingToken: "invalid",
    });
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toEqual({
      checkpoint: "1",
      recoveryMarker: "1",
      ownerId: "invalid-token-owner",
      fencingToken: "7",
    });
    await saveSubscriptionCheckpoint(pools.target, subscription, "0", {
      ownerId: "normal-owner",
      fencingToken: "7",
    });
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toMatchObject({
      checkpoint: "1",
      recoveryMarker: "1",
    });
    await saveSubscriptionCheckpoint(pools.target, subscription, "2", {
      ownerId: "normal-owner",
      fencingToken: "7",
    });
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toMatchObject({
      checkpoint: "2",
      recoveryMarker: "2",
    });

    await clearCheckpointState(pools.target, checkpointKey);
    await seedCheckpointState(pools.target, subscription, {
      checkpoint: "10",
      recoveryMarker: "9",
      ownerId: null,
      fencingToken: null,
    });
    await saveSubscriptionCheckpoint(pools.target, subscription, "1", {
      ownerId: "zero-owner",
      fencingToken: "0",
    });
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toEqual({
      checkpoint: "1",
      recoveryMarker: "9",
      ownerId: "zero-owner",
      fencingToken: "0",
    });
    await saveSubscriptionCheckpoint(pools.target, subscription, "0", {
      ownerId: "invalid-owner",
      fencingToken: "not-a-number",
    });
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toEqual({
      checkpoint: "1",
      recoveryMarker: "9",
      ownerId: "invalid-owner",
      fencingToken: "0",
    });
    await saveSubscriptionCheckpoint(pools.target, subscription, "10", {
      ownerId: "numeric-owner",
      fencingToken: "5",
    });
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toEqual({
      checkpoint: "10",
      recoveryMarker: "10",
      ownerId: "numeric-owner",
      fencingToken: "5",
    });
  });

  it("rolls back checkpoint saves on lease loss and abort while waiting for the lock", async () => {
    const subscription = createItemsSubscription();
    const checkpointKey = createCheckpointKey(subscription);

    await expect(
      saveSubscriptionCheckpoint(pools.target, subscription, "1", {
        throwIfLeaseLost: () => {
          throw new Error("lease lost before lock acquisition");
        },
      }),
    ).rejects.toThrow("lease lost before lock acquisition");
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toMatchObject({ checkpoint: null });

    let leaseLost = false;
    const postStatementPool = createControlledSavePool(pools.target, {
      afterCheckpoint: () => {
        leaseLost = true;
      },
    });
    await expect(
      saveSubscriptionCheckpoint(postStatementPool.pool, subscription, "2", {
        throwIfLeaseLost: () => {
          if (leaseLost) {
            throw new Error("lease lost after checkpoint statement");
          }
        },
      }),
    ).rejects.toThrow("lease lost after checkpoint statement");
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toMatchObject({ checkpoint: null });

    const holder = createControlledSavePool(pools.target, { holdBeforeCommit: true });
    const waiter = createControlledSavePool(pools.target);
    const holderSave = saveSubscriptionCheckpoint(holder.pool, subscription, "10");
    const abort = new AbortController();
    let waitingSave: Promise<void> | undefined;
    try {
      await holder.checkpointCompleted.promise;
      waitingSave = saveSubscriptionCheckpoint(waiter.pool, subscription, "1", { signal: abort.signal });
      await waiter.lockSubmitted.promise;
      await waitForBackendBlock(pools.target, holder.backendPid, waiter.backendPid);
      abort.abort(new Error("checkpoint lock wait aborted"));
      await expect(waitingSave).rejects.toThrow("checkpoint lock wait aborted");
      holder.releaseCommit.resolve();
      await expect(holderSave).resolves.toBeUndefined();
      await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toMatchObject({
        checkpoint: "10",
        recoveryMarker: "10",
      });
    } finally {
      holder.releaseCommit.resolve();
      await Promise.allSettled([holderSave, ...(waitingSave ? [waitingSave] : [])]);
    }
  });

  it("preserves retained checkpoint identity errors and marker atomicity", async () => {
    const subscription = createItemsSubscription();
    const checkpointKey = createCheckpointKey(subscription);
    await pools.target.query(
      `INSERT INTO event_subscription_checkpoints (
         checkpoint_key,
         projection_name,
         source_context_name,
         subscription_version,
         last_global_position,
         updated_at
       ) VALUES ('retained-noncanonical-key', $1, $2, $3, 4, now())`,
      [subscription.projectionName, subscription.sourceContextName, subscription.subscriptionVersion],
    );

    await expect(saveSubscriptionCheckpoint(pools.target, subscription, "5")).rejects.toMatchObject({
      code: "23505",
      constraint: "event_subscription_checkpoints_projection_source_version_idx",
    });
    await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toMatchObject({ checkpoint: null });
    await expect(readCheckpointState(pools.target, "retained-noncanonical-key")).resolves.toMatchObject({
      checkpoint: "4",
      recoveryMarker: null,
    });

    await clearCheckpointState(pools.target, "retained-noncanonical-key");
    await pools.target.query(
      `CREATE OR REPLACE FUNCTION fail_subscription_recovery_marker_for_test()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF NEW.projection_kind = 'subscription' AND NEW.projection_key = '${checkpointKey}' THEN
           RAISE EXCEPTION 'synthetic recovery marker failure';
         END IF;
         RETURN NEW;
       END;
       $$`,
    );
    await pools.target.query(
      `CREATE TRIGGER fail_subscription_recovery_marker_for_test
       BEFORE INSERT OR UPDATE ON event_projection_recovery_markers
       FOR EACH ROW EXECUTE FUNCTION fail_subscription_recovery_marker_for_test()`,
    );
    try {
      await expect(saveSubscriptionCheckpoint(pools.target, subscription, "6")).rejects.toThrow(
        "synthetic recovery marker failure",
      );
      await expect(readCheckpointState(pools.target, checkpointKey)).resolves.toMatchObject({ checkpoint: null });
    } finally {
      await pools.target.query(
        "DROP TRIGGER IF EXISTS fail_subscription_recovery_marker_for_test ON event_projection_recovery_markers",
      );
      await pools.target.query("DROP FUNCTION IF EXISTS fail_subscription_recovery_marker_for_test() ");
    }
  });

  it("resumes committed application after checkpoint persistence fails", async () => {
    const sourceEventStore = createPostgresEventStore({ pool: pools.source });
    const checkpointFailure = new Error("checkpoint persistence unavailable");
    const failingPool = createFailingCheckpointPool(pools.target, checkpointFailure);
    const runner = createSubscriptionRunner("target", failingPool, pools.source, createItemsSubscription());
    const projectionAttempts: string[] = [];
    targetPorts.beforeProjectionWrite = async (itemId) => {
      projectionAttempts.push(itemId);
    };

    await sourceEventStore.appendToStream({
      streamId: "source.item-checkpoint-failure",
      expectedVersion: "no_stream",
      context: createEventStoreContext(),
      events: [
        {
          eventType: "source.item-recorded",
          payload: { itemId: "item-checkpoint-failure" },
        },
      ],
    });

    await expect(runner.runOnce(createProjectionRunContext())).rejects.toBe(checkpointFailure);
    await expect(readProjectedItems()).resolves.toEqual([{ item_id: "item-checkpoint-failure", seen_count: 1 }]);
    await expect(readSubscriptionApplicationRows(runner.checkpointKey)).resolves.toEqual([
      { event_id: expect.any(String), status: "applied" },
    ]);
    await expect(loadSubscriptionCheckpoint(runner.checkpointKey)).resolves.toBeNull();

    const resumedRunner = createSubscriptionRunner("target", pools.target, pools.source, createItemsSubscription());
    await expect(resumedRunner.runOnce(createProjectionRunContext())).resolves.toMatchObject({
      processed: 1,
      lastGlobalPosition: "1",
    });
    expect(projectionAttempts).toEqual(["item-checkpoint-failure"]);
    await expect(readProjectedItems()).resolves.toEqual([{ item_id: "item-checkpoint-failure", seen_count: 1 }]);
    await expect(loadSubscriptionCheckpoint(runner.checkpointKey)).resolves.toBe("1");
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
    expect(targetQueries.filter((sql) => sql === "BEGIN")).toHaveLength(2);
    expect(targetQueries.filter((sql) => sql === "COMMIT")).toHaveLength(2);
    expect(targetQueries.filter((sql) => sql.includes("event_subscription_checkpoints:'"))).toHaveLength(1);
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

function saveSubscriptionCheckpoint(
  pool: PgTransactionalPool,
  subscription: Pick<BcEventSubscription, "projectionName" | "sourceContextName" | "subscriptionVersion">,
  lastGlobalPosition: string,
  context?: ProjectionRunContext,
): Promise<void> {
  return savePersistedSubscriptionCheckpoint(pool, subscription, parseGlobalPosition(lastGlobalPosition), context);
}

function createControlledSavePool(
  pool: PgTransactionalPool,
  options: Readonly<{
    holdBeforeCommit?: boolean;
    bypassCheckpointLock?: boolean;
    failCommitBeforeQuery?: Error;
    afterCheckpoint?: () => void;
  }> = {},
) {
  const lockSubmitted = createDeferred<void>();
  const checkpointStarted = createDeferred<void>();
  const checkpointCompleted = createDeferred<void>();
  const releaseCommit = createDeferred<void>();
  const checkpointQueries: Array<Readonly<{ sql: string; params: readonly unknown[] }>> = [];
  let backendPid = 0;
  if (!options.holdBeforeCommit) {
    releaseCommit.resolve();
  }

  const controlledPool: PgTransactionalPool = {
    idleInTransactionSessionTimeoutMillis: pool.idleInTransactionSessionTimeoutMillis,
    query: <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => pool.query<Row>(sql, params),
    connect: async () => {
      const client = await pool.connect();
      const pidResult = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      backendPid = Number(pidResult.rows[0]?.pid);
      return {
        query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
          if (sql.includes("pg_advisory_xact_lock") && sql.includes("event_subscription_checkpoints:")) {
            lockSubmitted.resolve();
            if (options.bypassCheckpointLock) {
              return { rows: [] as Row[], rowCount: 1 };
            }
          }
          if (sql.includes("WITH saved_checkpoint AS")) {
            checkpointQueries.push({ sql, params: params ?? [] });
            checkpointStarted.resolve();
            const result = await client.query<Row>(sql, params);
            checkpointCompleted.resolve();
            options.afterCheckpoint?.();
            return result;
          }
          if (sql === "COMMIT") {
            await releaseCommit.promise;
            if (options.failCommitBeforeQuery) {
              throw options.failCommitBeforeQuery;
            }
          }
          return client.query<Row>(sql, params);
        },
        release: (error?: unknown) => client.release(error),
      };
    },
  };

  return {
    pool: controlledPool,
    get backendPid() {
      return backendPid;
    },
    lockSubmitted,
    checkpointStarted,
    checkpointCompleted,
    releaseCommit,
    checkpointQueries,
  };
}

function createFailingCheckpointPool(pool: PgTransactionalPool, failure: Error): PgTransactionalPool {
  return {
    idleInTransactionSessionTimeoutMillis: pool.idleInTransactionSessionTimeoutMillis,
    query: <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => pool.query<Row>(sql, params),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
          if (sql.includes("WITH saved_checkpoint AS")) {
            throw failure;
          }
          return client.query<Row>(sql, params);
        },
        release: (error?: unknown) => client.release(error),
      };
    },
  };
}

type CheckpointState = Readonly<{
  checkpoint: string | null;
  recoveryMarker: string | null;
  ownerId: string | null;
  fencingToken: string | null;
}>;

async function readCheckpointState(pool: PgTransactionalPool, checkpointKey: string): Promise<CheckpointState> {
  const result = await pool.query<{
    checkpoint: string | number | bigint;
    recovery_marker: string | number | bigint | null;
    lease_owner_id: string | null;
    lease_fencing_token: string | number | bigint | null;
  }>(
    `SELECT checkpoint.last_global_position AS checkpoint,
            marker.last_global_position AS recovery_marker,
            checkpoint.lease_owner_id,
            checkpoint.lease_fencing_token
     FROM event_subscription_checkpoints AS checkpoint
     LEFT JOIN event_projection_recovery_markers AS marker
       ON marker.projection_kind = 'subscription'
      AND marker.projection_key = checkpoint.checkpoint_key
     WHERE checkpoint.checkpoint_key = $1`,
    [checkpointKey],
  );
  const row = result.rows[0];
  return {
    checkpoint: row ? String(row.checkpoint) : null,
    recoveryMarker: row?.recovery_marker == null ? null : String(row.recovery_marker),
    ownerId: row?.lease_owner_id ?? null,
    fencingToken: row?.lease_fencing_token == null ? null : String(row.lease_fencing_token),
  };
}

async function clearCheckpointState(pool: PgTransactionalPool, checkpointKey: string): Promise<void> {
  await pool.query(
    `DELETE FROM event_projection_recovery_markers
     WHERE projection_kind = 'subscription' AND projection_key = $1`,
    [checkpointKey],
  );
  await pool.query(`DELETE FROM event_subscription_checkpoints WHERE checkpoint_key = $1`, [checkpointKey]);
}

async function seedCheckpointState(
  pool: PgTransactionalPool,
  subscription: Pick<BcEventSubscription, "projectionName" | "sourceContextName" | "subscriptionVersion">,
  state: Readonly<{
    checkpoint: string;
    recoveryMarker: string | null;
    ownerId: string | null;
    fencingToken: string | null;
  }>,
): Promise<void> {
  const checkpointKey = createCheckpointKey(subscription);
  await pool.query(
    `INSERT INTO event_subscription_checkpoints (
       checkpoint_key,
       projection_name,
       source_context_name,
       subscription_version,
       last_global_position,
       lease_owner_id,
       lease_fencing_token,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::bigint, now())`,
    [
      checkpointKey,
      subscription.projectionName,
      subscription.sourceContextName,
      subscription.subscriptionVersion,
      state.checkpoint,
      state.ownerId,
      state.fencingToken,
    ],
  );
  if (state.recoveryMarker !== null) {
    await pool.query(
      `INSERT INTO event_projection_recovery_markers (
         projection_kind,
         projection_key,
         last_global_position,
         updated_at
       ) VALUES ('subscription', $1, $2::bigint, now())`,
      [checkpointKey, state.recoveryMarker],
    );
  }
}

type BackendWaitEvidence = Readonly<{
  wait_event_type: string | null;
  wait_event: string | null;
  blocking_pids: readonly number[];
  locks: readonly Readonly<{
    pid: number;
    locktype: string;
    database: string | null;
    classid: string | null;
    objid: string | null;
    objsubid: string | null;
    mode: string;
    granted: boolean;
  }>[];
}>;

async function waitForBackendBlock(
  pool: PgTransactionalPool,
  blockingPid: number,
  blockedPid: number,
): Promise<BackendWaitEvidence> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await pool.query<{
      wait_event_type: string | null;
      wait_event: string | null;
      blocking_pids: number[];
    }>(
      `SELECT wait_event_type, wait_event, pg_blocking_pids(pid) AS blocking_pids
       FROM pg_stat_activity
       WHERE pid = $1`,
      [blockedPid],
    );
    const row = activity.rows[0];
    if (row?.blocking_pids.map(Number).includes(blockingPid)) {
      const locks = await pool.query<BackendWaitEvidence["locks"][number]>(
        `SELECT pid,
                locktype,
                database::text,
                classid::text,
                objid::text,
                objsubid::text,
                mode,
                granted
         FROM pg_locks
         WHERE pid = ANY($1::int[])
           AND locktype = 'advisory'
         ORDER BY pid, granted DESC`,
        [[blockingPid, blockedPid]],
      );
      return {
        wait_event_type: row.wait_event_type,
        wait_event: row.wait_event,
        blocking_pids: row.blocking_pids.map(Number),
        locks: locks.rows,
      };
    }
    await delay(10);
  }
  throw new Error(`Backend ${blockedPid} did not become blocked by backend ${blockingPid}.`);
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  readonly resolved: boolean;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let resolved = false;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = (value) => {
      resolved = true;
      promiseResolve(value as T | PromiseLike<T>);
    };
  });

  return {
    promise,
    resolve,
    get resolved() {
      return resolved;
    },
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
