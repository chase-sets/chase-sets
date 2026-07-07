import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BcApiModule } from "@chase-sets/bounded-context-module";
import {
  createEventCoreMock,
  createEventCorePostgresMock,
  createMockPool,
  createStoredEvent,
  getApplicationStatusStore,
  getBlockedStreamStore,
  getCheckpointStore,
  getCheckpointWriteCountStore,
  getPoisonEventStore,
  getReadAllCalls,
  resetMockPoolState,
  sourceEventsByPool,
  sourceHeadByPool,
} from "./index-test-harness";

vi.mock("@chase-sets/event-core", () => createEventCoreMock());
vi.mock("@chase-sets/event-core-postgres", () => createEventCorePostgresMock());

import { createProjectionGroupRuntime } from "./index-test-runtime-helpers";

import {
  compactRuntimeSubscriptionLedgers,
  createSubscriptionRunner,
  listProjectionBlockedStreamDetails,
  refreshProjectionGroupStatuses,
  resolveModuleSubscriptions,
  retryProjectionBlockedStream,
  summarizeProjectionReplayStatuses,
  summarizeRuntimeSubscriptionLedgers,
} from "./index";

describe("bounded context subscription runner", () => {
  beforeEach(() => {
    resetMockPoolState();
  });

  it("fails startup when declared event filters omit a handled event type", () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();

    expect(() =>
      resolveModuleSubscriptions([
        {
          contextName: "catalog",
          module: {
            contextName: "catalog",
            buildSubscriptions: () => [],
          } as unknown as BcApiModule,
          services: {},
          pool: sourcePool as never,
          projectionHandlerSets: [],
        },
        {
          contextName: "inventory",
          module: {
            contextName: "inventory",
            buildSubscriptions: () => [
              {
                subscriptionName: "inventory.catalog-item-projection",
                sourceContextName: "catalog",
                projectionName: "inventory-catalog-item-projection",
                subscriptionVersion: 1,
                handlers: {
                  "catalog.catalog-item.published": async () => undefined,
                  "catalog.catalog-item.retired": async () => undefined,
                },
                eventTypes: ["catalog.catalog-item.published"],
              },
            ],
          } as unknown as BcApiModule,
          services: {},
          pool: targetPool as never,
          projectionHandlerSets: [],
        },
      ]),
    ).toThrow(
      "Context 'inventory' subscription 'inventory.catalog-item-projection' for projection 'inventory-catalog-item-projection' declares eventTypes that do not cover handler event types. Missing: [catalog.catalog-item.retired].",
    );
  });

  it("skips opt-in subscriptions when their source context is not mounted", () => {
    const targetPool = createMockPool();

    const runners = resolveModuleSubscriptions([
      {
        contextName: "platform-operations",
        module: {
          contextName: "platform-operations",
          buildSubscriptions: () => [
            {
              subscriptionName: "platform-operations.reported-content-queue-projection",
              sourceContextName: "marketplace",
              sourceContextMount: "when-mounted",
              projectionName: "reported-content-queue-projection",
              subscriptionVersion: 1,
              handlers: {
                "marketplace.report.submitted": async () => undefined,
              },
              eventTypes: ["marketplace.report.submitted"],
            },
          ],
        } as unknown as BcApiModule,
        services: {},
        pool: targetPool as never,
        projectionHandlerSets: [],
      },
    ]);

    expect(runners).toEqual([]);
  });

  it("derives event filters from handler keys when no eventTypes are declared", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
      createStoredEvent("2", "catalog.catalog-item.retired", { itemId: "cat_1" }),
    ]);

    const [runner] = resolveModuleSubscriptions([
      {
        contextName: "catalog",
        module: {
          contextName: "catalog",
          buildSubscriptions: () => [],
        } as unknown as BcApiModule,
        services: {},
        pool: sourcePool as never,
        projectionHandlerSets: [],
      },
      {
        contextName: "inventory",
        module: {
          contextName: "inventory",
          buildSubscriptions: () => [
            {
              subscriptionName: "inventory.catalog-item-projection",
              sourceContextName: "catalog",
              projectionName: "inventory-catalog-item-projection",
              subscriptionVersion: 1,
              handlers: {
                "catalog.catalog-item.published": async () => undefined,
              },
            },
          ],
        } as unknown as BcApiModule,
        services: {},
        pool: targetPool as never,
        projectionHandlerSets: [],
      },
    ]);

    await runner.runOnce();

    expect(getReadAllCalls(sourcePool)[0]).toMatchObject({
      eventTypes: ["catalog.catalog-item.published"],
    });
    expect(runner.getStatus()).toMatchObject({
      lastGlobalPosition: "2",
      sourceHeadGlobalPosition: "2",
      outstandingEventCount: "0",
    });
  });

  it("passes lease-loss cancellation checks into subscription handlers", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" })]);
    const throwIfLeaseLost = vi.fn();
    const handler = vi.fn(async (_event, context) => {
      context?.throwIfLeaseLost?.();
    });
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": handler,
      },
    });

    await runner.runOnce({ throwIfLeaseLost });

    expect(handler).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ throwIfLeaseLost }));
    expect(throwIfLeaseLost).toHaveBeenCalled();
  });

  it("uses subscription projection budget overrides for oversized normal applies", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const targetQuery = vi.spyOn(targetPool, "query");
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_heavy" }, "catalog.item-cat_heavy"),
    ]);
    let now = 1_000;
    const originalNow = Date.now;
    Date.now = () => now;
    const runner = createSubscriptionRunner("discovery", targetPool as never, sourcePool as never, {
      subscriptionName: "discovery.catalog-search-projection",
      sourceContextName: "catalog",
      projectionName: "discovery-search-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          now = 61_000;
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
      projectionTransactionTimeoutMs: 120_000,
      projectionStatementTimeoutMs: 120_000,
    });

    try {
      await expect(runner.runOnce({ statementTimeoutMs: 30_000 })).resolves.toMatchObject({
        processed: 1,
        lastGlobalPosition: "1",
      });
    } finally {
      Date.now = originalNow;
    }

    expect(targetQuery).toHaveBeenCalledWith("SELECT set_config('statement_timeout', $1, true)", ["120000ms"]);
    expect(getApplicationStatusStore(targetPool).get("discovery-search-item-projection:catalog:v1:evt_1")).toBe(
      "applied",
    );
    expect(getCheckpointStore(targetPool).get("discovery-search-item-projection:catalog:v1")).toBe("1");
  });

  it("uses subscription projection budget overrides when retrying blocked streams", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const targetQuery = vi.spyOn(targetPool, "query");
    const streamId = "catalog.item-cat_heavy";
    const projectionKey = "discovery-item-detail-projection:catalog:v1";
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_heavy" }, streamId),
    ]);
    getBlockedStreamStore(targetPool).set(`${projectionKey}:${streamId}`, {
      projectionKey,
      streamId,
      firstBlockedGlobalPosition: "1",
      firstBlockedStreamVersion: 1,
      lastSeenGlobalPosition: "1",
      deferredEventCount: 0,
      state: "blocked",
    });
    let now = 1_000;
    const originalNow = Date.now;
    Date.now = () => now;
    const runner = createSubscriptionRunner("discovery", targetPool as never, sourcePool as never, {
      subscriptionName: "discovery.catalog-detail-projection",
      sourceContextName: "catalog",
      projectionName: "discovery-item-detail-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          now = 61_000;
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
      projectionTransactionTimeoutMs: 120_000,
      projectionStatementTimeoutMs: 120_000,
    });

    try {
      await expect(runner.retryBlockedStream(streamId, { statementTimeoutMs: 30_000 })).resolves.toMatchObject({
        state: "resolved",
        inspectedEvents: 1,
        appliedEvents: 1,
      });
    } finally {
      Date.now = originalNow;
    }

    expect(targetQuery).toHaveBeenCalledWith("SELECT set_config('statement_timeout', $1, true)", ["120000ms"]);
    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("applied");
    expect(getBlockedStreamStore(targetPool).get(`${projectionKey}:${streamId}`)?.state).toBe("resolved");
  });

  it("refreshes source lag without scanning applicable event lag", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const sourceQuery = vi.spyOn(sourcePool, "query");
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
      createStoredEvent("2", "catalog.category.created", { categoryId: "ctg_1" }),
      createStoredEvent("3", "catalog.catalog-item.published", { itemId: "cat_2" }),
    ]);
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => undefined,
      },
      eventTypes: ["catalog.catalog-item.published"],
    });

    const status = await runner.refreshStatus();

    expect(status.sourceLagEventCount).toBe("3");
    expect(status.applicableLagEstimate).toBeNull();
    expect(sourceQuery.mock.calls.some(([sql]) => String(sql).includes("SELECT COUNT(*) AS count"))).toBe(false);
  });

  it("surfaces reaction-kind subscription status separately from projection subscriptions", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const runner = createSubscriptionRunner("ordering", targetPool as never, sourcePool as never, {
      subscriptionName: "ordering.inventory-reservation-outcomes",
      handlerKind: "reaction",
      sourceContextName: "inventory",
      projectionName: "ordering-inventory-reservation-outcomes",
      reactionName: "ordering-inventory-reservation-outcomes",
      subscriptionVersion: 1,
      handlers: {
        "inventory.reservation.confirmed": async () => undefined,
      },
      eventTypes: ["inventory.reservation.confirmed"],
      idempotencyPolicy: "idempotent-command-dispatch",
      retryPolicy: "retry-from-last-checkpoint",
      failurePolicy: "surface-as-reaction-failure",
    });

    expect(runner.handlerKind).toBe("reaction");
    expect(runner.checkpointKey).toBe("ordering-inventory-reservation-outcomes:inventory:v1");
    expect(runner.getStatus()).toMatchObject({
      handlerKind: "reaction",
      projectionName: "ordering-inventory-reservation-outcomes",
    });
  });

  it("does not move in-memory status behind events observed after the captured source head", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceHeadByPool.set(sourcePool, "1");
    sourceEventsByPool.set(sourcePool, [createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_1" })]);

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => undefined,
      },
      eventTypes: ["catalog.catalog-item.published"],
    });

    await runner.runOnce();

    expect(runner.getStatus()).toMatchObject({
      lastGlobalPosition: "2",
      sourceHeadGlobalPosition: "2",
      outstandingEventCount: "0",
      state: "caught-up",
    });
  });

  it("persists versioned checkpoints and replays a new subscription version from origin", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }),
    ]);

    const seenByVersion: string[] = [];
    const runnerV1 = createSubscriptionRunner("ordering", targetPool as never, sourcePool as never, {
      subscriptionName: "ordering.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "ordering-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          seenByVersion.push(`v1:${event.globalPosition}`);
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      order: 10,
    });

    await runnerV1.runOnce();
    expect(seenByVersion).toEqual(["v1:1", "v1:2"]);
    expect(getCheckpointStore(targetPool).get("ordering-catalog-item-projection:catalog:v1")).toBe("2");

    const runnerV2 = createSubscriptionRunner("ordering", targetPool as never, sourcePool as never, {
      subscriptionName: "ordering.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "ordering-catalog-item-projection",
      subscriptionVersion: 2,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          seenByVersion.push(`v2:${event.globalPosition}`);
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      order: 10,
    });

    await runnerV2.runOnce();
    expect(seenByVersion).toEqual(["v1:1", "v1:2", "v2:1", "v2:2"]);
    expect(getCheckpointStore(targetPool).get("ordering-catalog-item-projection:catalog:v2")).toBe("2");
  });

  it("resumes from the last saved checkpoint after a partial failure", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "inventory.item.created", { itemId: "rec_1" }),
      createStoredEvent("2", "inventory.item.created", { itemId: "rec_2" }),
    ]);

    const failingRunner = createSubscriptionRunner("marketplace", targetPool as never, sourcePool as never, {
      subscriptionName: "marketplace.inventory-supply-projection",
      sourceContextName: "inventory",
      projectionName: "marketplace-inventory-supply-projection",
      subscriptionVersion: 1,
      handlers: {
        "inventory.item.created": async (event) => {
          if (event.globalPosition === "2") {
            throw new Error("transient failure");
          }
        },
      },
      eventTypes: ["inventory.item.created"],
      errorPolicy: "global-strict",
      order: 10,
    });

    await expect(failingRunner.runOnce()).rejects.toThrow("transient failure");
    expect(getCheckpointStore(targetPool).get("marketplace-inventory-supply-projection:inventory:v1")).toBe("1");
    expect(getCheckpointWriteCountStore(targetPool).get("marketplace-inventory-supply-projection:inventory:v1")).toBe(
      1,
    );

    const resumedPositions: string[] = [];
    const resumedRunner = createSubscriptionRunner("marketplace", targetPool as never, sourcePool as never, {
      subscriptionName: "marketplace.inventory-supply-projection",
      sourceContextName: "inventory",
      projectionName: "marketplace-inventory-supply-projection",
      subscriptionVersion: 1,
      handlers: {
        "inventory.item.created": async (event) => {
          resumedPositions.push(event.globalPosition);
        },
      },
      eventTypes: ["inventory.item.created"],
      order: 10,
    });

    await resumedRunner.runOnce();
    expect(resumedPositions).toEqual(["2"]);
  });

  it("treats retryable Postgres handler failures as transient without blocking the stream", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_retry" }, "catalog.item-cat_retry"),
    ]);

    let attempts = 0;
    const appliedPositions: string[] = [];
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
          }
          appliedPositions.push(event.globalPosition);
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });
    const projectionKey = "inventory-catalog-item-projection:catalog:v1";

    await expect(runner.runOnce()).rejects.toThrow("deadlock detected");
    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("transient");
    expect(getBlockedStreamStore(targetPool).size).toBe(0);
    expect(getPoisonEventStore(targetPool).size).toBe(0);

    await expect(runner.runOnce()).resolves.toMatchObject({
      processed: 1,
      lastGlobalPosition: "1",
      state: "running",
      blockedStreams: 0,
      poisonEvents: 0,
    });
    expect(appliedPositions).toEqual(["1"]);
    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("applied");
    expect(getCheckpointStore(targetPool).get(projectionKey)).toBe("1");
  });

  it("treats transient projection failures as retryable without blocking the stream", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_timeout" }, "catalog.item-cat_timeout"),
    ]);

    let attempts = 0;
    const appliedPositions: string[] = [];
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error("Projection transaction exceeded 50ms."), {
              projectionFailureKind: "transient",
            });
          }
          appliedPositions.push(event.globalPosition);
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });
    const projectionKey = "inventory-catalog-item-projection:catalog:v1";

    await expect(runner.runOnce()).rejects.toThrow("Projection transaction exceeded 50ms.");
    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("transient");
    expect(getBlockedStreamStore(targetPool).size).toBe(0);
    expect(getPoisonEventStore(targetPool).size).toBe(0);

    await expect(runner.runOnce()).resolves.toMatchObject({
      processed: 1,
      lastGlobalPosition: "1",
      state: "running",
      blockedStreams: 0,
      poisonEvents: 0,
    });
    expect(appliedPositions).toEqual(["1"]);
    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("applied");
    expect(getCheckpointStore(targetPool).get(projectionKey)).toBe("1");
  });

  it("keeps deterministic Postgres handler failures on the poison path", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_bad" }, "catalog.item-cat_bad"),
    ]);

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });
    const projectionKey = "inventory-catalog-item-projection:catalog:v1";

    await expect(runner.runOnce()).resolves.toMatchObject({
      processed: 1,
      lastGlobalPosition: "1",
      state: "degraded",
      blockedStreams: 1,
      poisonEvents: 1,
    });
    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("poison");
    expect(getBlockedStreamStore(targetPool).get(`${projectionKey}:catalog.item-cat_bad`)).toBeDefined();
    expect(getPoisonEventStore(targetPool).has(`${projectionKey}:evt_1`)).toBe(true);
  });

  it("blocks only the poisoned stream while continuing unrelated subscription streams", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_bad" }, "catalog.item-cat_bad"),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_good" }, "catalog.item-cat_good"),
      createStoredEvent("3", "catalog.catalog-item.published", { itemId: "cat_bad" }, "catalog.item-cat_bad"),
    ]);

    const seen: string[] = [];
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          if (event.streamId === "catalog.item-cat_bad") {
            throw new Error("bad catalog item shape");
          }

          seen.push(`${event.streamId}:${event.globalPosition}`);
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });

    await expect(runner.runOnce()).resolves.toMatchObject({
      processed: 3,
      lastGlobalPosition: "3",
      state: "degraded",
      blockedStreams: 1,
      poisonEvents: 1,
    });

    expect(seen).toEqual(["catalog.item-cat_good:2"]);
    expect(getCheckpointStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBe("3");
    expect(
      getBlockedStreamStore(targetPool).get("inventory-catalog-item-projection:catalog:v1:catalog.item-cat_bad"),
    ).toMatchObject({
      deferredEventCount: 1,
      firstBlockedGlobalPosition: "1",
      lastSeenGlobalPosition: "3",
    });
  });

  it("retries one blocked subscription stream in stream-version order", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_bad" }, "catalog.item-cat_bad"),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_good" }, "catalog.item-cat_good"),
      createStoredEvent("3", "catalog.catalog-item.published", { itemId: "cat_bad" }, "catalog.item-cat_bad"),
    ]);

    let shouldFail = true;
    const seen: string[] = [];
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          if (shouldFail && event.streamId === "catalog.item-cat_bad") {
            throw new Error("bad catalog item shape");
          }

          seen.push(`${event.streamId}:${event.globalPosition}`);
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });

    await runner.runOnce();
    shouldFail = false;

    await expect(
      retryProjectionBlockedStream(
        {
          subscriptionRunners: [runner],
        },
        "inventory-catalog-item-projection:catalog:v1",
        "catalog.item-cat_bad",
      ),
    ).resolves.toMatchObject({
      state: "resolved",
      inspectedEvents: 2,
      appliedEvents: 2,
    });

    expect(seen).toEqual(["catalog.item-cat_good:2", "catalog.item-cat_bad:1", "catalog.item-cat_bad:3"]);
    expect(
      getBlockedStreamStore(targetPool).get("inventory-catalog-item-projection:catalog:v1:catalog.item-cat_bad"),
    ).toMatchObject({
      state: "resolved",
    });
  });

  it("retries blocked streams with the currently supplied handler code", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_fixed" }, "catalog.item-cat_fixed"),
    ]);

    const failingRunner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          throw new Error("old handler failure");
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });
    const projectionKey = "inventory-catalog-item-projection:catalog:v1";

    await failingRunner.runOnce();

    const seen: string[] = [];
    const currentRunner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          seen.push(`${event.streamId}:${event.globalPosition}`);
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });

    await expect(
      retryProjectionBlockedStream(
        {
          subscriptionRunners: [currentRunner],
        },
        projectionKey,
        "catalog.item-cat_fixed",
      ),
    ).resolves.toMatchObject({
      state: "resolved",
      inspectedEvents: 1,
      appliedEvents: 1,
    });

    expect(seen).toEqual(["catalog.item-cat_fixed:1"]);
    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("applied");
  });

  it("keeps retry-blocked transient projection failures retriable instead of re-poisoning", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const targetQuery = vi.spyOn(targetPool, "query");
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_timeout" }, "catalog.item-cat_timeout"),
    ]);

    const projectionKey = "inventory-catalog-item-projection:catalog:v1";
    let nextError: Error = new Error("bad catalog item shape");
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          throw nextError;
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });

    await runner.runOnce();
    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("poison");
    const initialPoisonInsertCount = targetQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO event_projection_poison_events"),
    ).length;
    expect(initialPoisonInsertCount).toBe(1);

    nextError = Object.assign(new Error("Projection transaction exceeded 50ms."), {
      projectionFailureKind: "transient",
    });

    await expect(
      retryProjectionBlockedStream(
        {
          subscriptionRunners: [runner],
        },
        projectionKey,
        "catalog.item-cat_timeout",
      ),
    ).resolves.toMatchObject({
      state: "still-blocked",
      inspectedEvents: 1,
      appliedEvents: 0,
      errorMessage: "Projection transaction exceeded 50ms.",
    });

    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("transient");
    expect(
      targetQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO event_projection_poison_events")),
    ).toHaveLength(initialPoisonInsertCount);
  });

  it("keeps retry-blocked deterministic failures on the poison path", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const targetQuery = vi.spyOn(targetPool, "query");
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_bad" }, "catalog.item-cat_bad"),
    ]);

    const projectionKey = "inventory-catalog-item-projection:catalog:v1";
    let nextError = new Error("bad catalog item shape");
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          throw nextError;
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });

    await runner.runOnce();
    const initialPoisonInsertCount = targetQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO event_projection_poison_events"),
    ).length;
    expect(initialPoisonInsertCount).toBe(1);

    nextError = new Error("still bad catalog item shape");

    await expect(
      retryProjectionBlockedStream(
        {
          subscriptionRunners: [runner],
        },
        projectionKey,
        "catalog.item-cat_bad",
      ),
    ).resolves.toMatchObject({
      state: "still-blocked",
      inspectedEvents: 1,
      appliedEvents: 0,
      errorMessage: "still bad catalog item shape",
    });

    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("poison");
    expect(
      targetQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO event_projection_poison_events")),
    ).toHaveLength(initialPoisonInsertCount + 1);
  });

  it("treats normalized append failures as transient on first-pass applies", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_append" }, "catalog.item-cat_append"),
    ]);

    const appendFailure = Object.assign(new Error("Failed to append events to Postgres event store."), {
      code: "infrastructure_failure",
      details: { cause: "connection terminated unexpectedly" },
    });
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          throw appendFailure;
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });
    const projectionKey = "inventory-catalog-item-projection:catalog:v1";

    await expect(runner.runOnce()).rejects.toThrow("Failed to append events to Postgres event store.");

    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("transient");
    expect(getBlockedStreamStore(targetPool).size).toBe(0);
    expect(getPoisonEventStore(targetPool).size).toBe(0);
  });

  it("keeps retry-blocked normalized append failures transient instead of re-poisoning", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const targetQuery = vi.spyOn(targetPool, "query");
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_append" }, "catalog.item-cat_append"),
    ]);

    const projectionKey = "inventory-catalog-item-projection:catalog:v1";
    let nextError: Error = new Error("bad catalog item shape");
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          throw nextError;
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });

    await runner.runOnce();
    const initialPoisonInsertCount = targetQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO event_projection_poison_events"),
    ).length;
    expect(initialPoisonInsertCount).toBe(1);

    nextError = Object.assign(new Error("Failed to append events to Postgres event store."), {
      code: "infrastructure_failure",
      details: { cause: "connection terminated unexpectedly" },
    });

    await expect(
      retryProjectionBlockedStream(
        {
          subscriptionRunners: [runner],
        },
        projectionKey,
        "catalog.item-cat_append",
      ),
    ).resolves.toMatchObject({
      state: "still-blocked",
      inspectedEvents: 1,
      appliedEvents: 0,
      errorMessage: "Failed to append events to Postgres event store.",
    });

    expect(getApplicationStatusStore(targetPool).get(`${projectionKey}:evt_1`)).toBe("transient");
    expect(
      targetQuery.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO event_projection_poison_events")),
    ).toHaveLength(initialPoisonInsertCount);
  });

  it("reports outstanding event counts from checkpoint to source head", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }),
      createStoredEvent("3", "catalog.catalog-item.published", { itemId: "cat_3" }),
    ]);

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => undefined,
      },
      eventTypes: ["catalog.catalog-item.published"],
    });
    const [group] = createProjectionGroupRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-catalog-item-projection",
          sourceContextNames: ["catalog"],
          ownedTables: ["inventory_catalog_items"],
          resetStrategy: "replay-only",
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    await runner.refreshStatus();
    expect(runner.getStatus()).toMatchObject({
      lastGlobalPosition: "0",
      sourceHeadGlobalPosition: "3",
      outstandingEventCount: "3",
    });
    expect(group.getStatus()).toMatchObject({
      outstandingEventCount: "3",
      caughtUp: false,
    });

    await runner.runOnce();
    expect(runner.getStatus()).toMatchObject({
      lastGlobalPosition: "3",
      sourceHeadGlobalPosition: "3",
      outstandingEventCount: "0",
    });

    sourceEventsByPool.set(sourcePool, [
      ...(sourceEventsByPool.get(sourcePool) ?? []),
      createStoredEvent("4", "catalog.catalog-item.published", { itemId: "cat_4" }),
    ]);
    const summary = summarizeProjectionReplayStatuses(
      await refreshProjectionGroupStatuses({ projectionGroups: [group] }),
    );

    expect(runner.getStatus()).toMatchObject({
      lastGlobalPosition: "3",
      sourceHeadGlobalPosition: "4",
      outstandingEventCount: "1",
    });
    expect(summary).toMatchObject({
      status: "degraded",
      outstandingEventCount: "1",
      contexts: [
        expect.objectContaining({
          contextName: "inventory",
          outstandingEventCount: "1",
        }),
      ],
    });
  });

  it("shares a source head read through the run context cache", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const sourceQuery = vi.spyOn(sourcePool, "query");
    sourceHeadByPool.set(sourcePool, "5");
    const firstRunner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection-a",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection-a",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => undefined,
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });
    const secondRunner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection-b",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection-b",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => undefined,
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });
    const context = {
      sourceHeadGlobalPositionCache: new Map<string, Promise<string>>(),
    } as never;

    await Promise.all([firstRunner.runOnce(context), secondRunner.runOnce(context)]);

    expect(
      sourceQuery.mock.calls.filter(([sql]) =>
        String(sql).includes("SELECT COALESCE(MAX(global_position), 0) AS head"),
      ),
    ).toHaveLength(1);
  });

  it("rate-limits durable checkpoint fast-forward for idle unrelated source advances", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceHeadByPool.set(sourcePool, "1");
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => undefined,
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });

    await runner.runOnce();
    sourceHeadByPool.set(sourcePool, "2");
    await runner.runOnce();

    expect(getCheckpointStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBe("1");
    expect(getCheckpointWriteCountStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBe(1);
    expect(runner.getStatus()).toMatchObject({
      lastGlobalPosition: "2",
      sourceHeadGlobalPosition: "2",
      outstandingEventCount: "0",
      state: "caught-up",
    });
  });

  it("passes subscription filters to readAll and advances past irrelevant source tail", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "marketplace.listing.created", { listingId: "lst_1" }, "marketplace.listing-lst_1"),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_1" }, "catalog.item-cat_1"),
      createStoredEvent("3", "pricing.price.changed", { itemId: "cat_1" }, "pricing.item-cat_1"),
    ]);

    const seenPositions: string[] = [];
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          seenPositions.push(event.globalPosition);
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
      batchSize: 100,
    });

    await runner.runOnce();

    expect(getReadAllCalls(sourcePool)).toEqual([
      {
        afterGlobalPosition: "0",
        limit: 100,
        eventTypes: ["catalog.catalog-item.published"],
        streamPrefixes: ["catalog.item-"],
      },
    ]);
    expect(seenPositions).toEqual(["2"]);
    expect(getCheckpointStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBe("3");
    expect(runner.getStatus()).toMatchObject({
      lastGlobalPosition: "3",
      sourceHeadGlobalPosition: "3",
      outstandingEventCount: "0",
      state: "caught-up",
    });
  });

  it("writes checkpoints by configured chunks instead of every applied event", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }),
      createStoredEvent("3", "catalog.catalog-item.published", { itemId: "cat_3" }),
      createStoredEvent("4", "catalog.catalog-item.published", { itemId: "cat_4" }),
      createStoredEvent("5", "catalog.catalog-item.published", { itemId: "cat_5" }),
    ]);

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => undefined,
      },
      eventTypes: ["catalog.catalog-item.published"],
      batchSize: 100,
      checkpointBatchSize: 2,
    });

    await runner.runOnce();

    expect(getCheckpointStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBe("5");
    expect(getCheckpointWriteCountStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBe(3);
  });

  it("batch-applies clean events with bounded ledger and blocked-stream queries", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const targetQuery = vi.spyOn(targetPool, "query");
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }, "catalog.item-cat_1"),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }, "catalog.item-cat_2"),
      createStoredEvent("3", "catalog.catalog-item.published", { itemId: "cat_3" }, "catalog.item-cat_3"),
      createStoredEvent("4", "catalog.catalog-item.published", { itemId: "cat_4" }, "catalog.item-cat_4"),
      createStoredEvent("5", "catalog.catalog-item.published", { itemId: "cat_5" }, "catalog.item-cat_5"),
    ]);
    const handler = vi.fn(async () => undefined);

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": handler,
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
    });

    await runner.runOnce();

    const targetSql = targetQuery.mock.calls.map(([sql]) => String(sql));
    expect(getReadAllCalls(sourcePool)[0]).toMatchObject({ limit: 100 });
    expect(handler).toHaveBeenCalledTimes(5);
    expect(targetSql.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(targetSql.filter((sql) => sql.includes("INSERT INTO event_subscription_applications"))).toHaveLength(1);
    expect(
      targetSql.filter((sql) => sql.includes("SELECT event_id, status") && sql.includes("FOR UPDATE")),
    ).toHaveLength(1);
    expect(targetSql.filter((sql) => sql.includes("UPDATE event_subscription_applications"))).toHaveLength(2);
    expect(
      targetSql.filter(
        (sql) => sql.includes("FROM event_projection_blocked_streams") && sql.includes("stream_id = ANY"),
      ),
    ).toHaveLength(1);
    expect(
      targetSql.filter(
        (sql) => sql.includes("FROM event_projection_blocked_streams") && sql.includes("stream_id = $2"),
      ),
    ).toHaveLength(0);
    expect(getCheckpointWriteCountStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBe(1);
  });

  it("uses checkpoint batch size as the projection transaction chunk boundary", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const targetQuery = vi.spyOn(targetPool, "query");
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }, "catalog.item-cat_1"),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }, "catalog.item-cat_2"),
    ]);
    const handler = vi.fn(async () => undefined);

    const runner = createSubscriptionRunner("discovery", targetPool as never, sourcePool as never, {
      subscriptionName: "discovery.catalog-search-projection",
      sourceContextName: "catalog",
      projectionName: "discovery-search-item-projection",
      subscriptionVersion: 5,
      handlers: {
        "catalog.catalog-item.published": handler,
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
      batchSize: 100,
      checkpointBatchSize: 1,
    });

    await runner.runOnce();

    const targetSql = targetQuery.mock.calls.map(([sql]) => String(sql));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(targetSql.filter((sql) => sql === "BEGIN")).toHaveLength(2);
    expect(targetSql.filter((sql) => sql === "COMMIT")).toHaveLength(2);
    expect(targetSql.filter((sql) => sql.includes("INSERT INTO event_subscription_applications"))).toHaveLength(2);
    expect(getCheckpointWriteCountStore(targetPool).get("discovery-search-item-projection:catalog:v5")).toBe(2);
  });

  it("applies reaction handlers one event per transaction even when configured for larger checkpoints", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const targetQuery = vi.spyOn(targetPool, "query");
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }, "catalog.item-cat_1"),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }, "catalog.item-cat_2"),
      createStoredEvent("3", "catalog.catalog-item.published", { itemId: "cat_3" }, "catalog.item-cat_3"),
    ]);
    const handler = vi.fn(async () => undefined);

    const runner = createSubscriptionRunner("ordering", targetPool as never, sourcePool as never, {
      subscriptionName: "ordering.catalog-command-reaction",
      handlerKind: "reaction",
      sourceContextName: "catalog",
      projectionName: "ordering-catalog-command-reaction",
      reactionName: "ordering-catalog-command-reaction",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": handler,
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
      batchSize: 100,
      checkpointBatchSize: 100,
    });

    await runner.runOnce();

    const targetSql = targetQuery.mock.calls.map(([sql]) => String(sql));
    expect(handler).toHaveBeenCalledTimes(3);
    expect(targetSql.filter((sql) => sql === "BEGIN")).toHaveLength(3);
    expect(targetSql.filter((sql) => sql === "COMMIT")).toHaveLength(3);
    expect(targetSql.filter((sql) => sql.includes("INSERT INTO event_subscription_applications"))).toHaveLength(3);
    expect(
      targetSql.filter((sql) => sql.includes("SELECT event_id, status") && sql.includes("FOR UPDATE")),
    ).toHaveLength(0);
    expect(getCheckpointStore(targetPool).get("ordering-catalog-command-reaction:catalog:v1")).toBe("3");
    expect(getCheckpointWriteCountStore(targetPool).get("ordering-catalog-command-reaction:catalog:v1")).toBe(3);
  });

  it("does not fall back to per-event apply when batch preflight fails", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const originalTargetQuery = targetPool.query.bind(targetPool);
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }, "catalog.item-cat_1"),
    ]);
    const handler = vi.fn(async () => undefined);
    vi.spyOn(targetPool, "query").mockImplementation(async (sql, params) => {
      if (String(sql).includes("FROM event_projection_blocked_streams") && String(sql).includes("stream_id = ANY")) {
        throw new Error("blocked stream preflight unavailable");
      }

      return originalTargetQuery(sql, params);
    });

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": handler,
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
      batchSize: 100,
    });

    await expect(runner.runOnce()).rejects.toThrow("blocked stream preflight unavailable");
    expect(handler).not.toHaveBeenCalled();
    expect(getApplicationStatusStore(targetPool).size).toBe(0);
    expect(getCheckpointStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBeUndefined();
  });

  it("skips already applied subscription events through the application ledger", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }),
    ]);
    getApplicationStatusStore(targetPool).set("inventory-catalog-item-projection:catalog:v1:evt_1", "applied");

    const seenPositions: string[] = [];
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          seenPositions.push(event.globalPosition);
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      batchSize: 100,
    });

    await runner.runOnce();

    expect(seenPositions).toEqual(["2"]);
    expect(getApplicationStatusStore(targetPool).get("inventory-catalog-item-projection:catalog:v1:evt_1")).toBe(
      "applied",
    );
    expect(getApplicationStatusStore(targetPool).get("inventory-catalog-item-projection:catalog:v1:evt_2")).toBe(
      "applied",
    );
    expect(getCheckpointStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBe("2");
  });

  it("falls back to per-event isolation when a batch handler fails", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_good_1" }, "catalog.item-cat_good_1"),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_bad" }, "catalog.item-cat_bad"),
      createStoredEvent("3", "catalog.catalog-item.published", { itemId: "cat_good_2" }, "catalog.item-cat_good_2"),
    ]);
    const attemptsByPosition = new Map<string, number>();

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          attemptsByPosition.set(event.globalPosition, (attemptsByPosition.get(event.globalPosition) ?? 0) + 1);
          if (event.globalPosition === "2") {
            throw new Error("bad catalog item shape");
          }
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-"],
      batchSize: 100,
    });

    await expect(runner.runOnce()).resolves.toMatchObject({
      processed: 3,
      lastGlobalPosition: "3",
      state: "degraded",
      blockedStreams: 1,
      poisonEvents: 1,
    });

    expect(attemptsByPosition).toEqual(
      new Map([
        ["1", 2],
        ["2", 1],
        ["3", 1],
      ]),
    );
    expect(getApplicationStatusStore(targetPool).get("inventory-catalog-item-projection:catalog:v1:evt_1")).toBe(
      "applied",
    );
    expect(getApplicationStatusStore(targetPool).get("inventory-catalog-item-projection:catalog:v1:evt_2")).toBe(
      "poison",
    );
    expect(getApplicationStatusStore(targetPool).get("inventory-catalog-item-projection:catalog:v1:evt_3")).toBe(
      "applied",
    );
    expect(
      getBlockedStreamStore(targetPool).get("inventory-catalog-item-projection:catalog:v1:catalog.item-cat_bad"),
    ).toMatchObject({
      firstBlockedGlobalPosition: "2",
      lastSeenGlobalPosition: "2",
    });
    expect(getPoisonEventStore(targetPool).has("inventory-catalog-item-projection:catalog:v1:evt_2")).toBe(true);
  });

  it("passes a transaction-scoped db handle to subscription handlers before marking events applied", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const observedDbHandles: unknown[] = [];
    sourceEventsByPool.set(sourcePool, [createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" })]);

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async (_event, context) => {
          observedDbHandles.push(context?.db);
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
    });

    await runner.runOnce();

    const [observedDb] = observedDbHandles as Array<{ query?: unknown; connect?: unknown }>;
    expect(observedDbHandles).toHaveLength(1);
    expect(observedDb).not.toBe(targetPool);
    expect(observedDb?.query).toEqual(expect.any(Function));
    expect(observedDb?.connect).toBeUndefined();
    expect(getApplicationStatusStore(targetPool).get("inventory-catalog-item-projection:catalog:v1:evt_1")).toBe(
      "applied",
    );
  });

  it("compacts applied subscription ledger rows from scheduled maintenance", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_old" }),
      createStoredEvent("10001", "catalog.catalog-item.published", { itemId: "cat_boundary" }),
      createStoredEvent("10002", "catalog.catalog-item.published", { itemId: "cat_recent" }),
    ]);

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => undefined,
      },
      eventTypes: ["catalog.catalog-item.published"],
      batchSize: 100,
    });

    await runner.runOnce();
    await compactRuntimeSubscriptionLedgers({
      mountedContexts: [
        {
          contextName: "inventory",
          module: {} as never,
          services: {},
          pool: targetPool as never,
          projectionHandlerSets: [],
        },
      ],
      subscriptionRunners: [runner],
    });

    const applicationStore = getApplicationStatusStore(targetPool);
    expect(applicationStore.get("inventory-catalog-item-projection:catalog:v1:evt_1")).toBeUndefined();
    expect(applicationStore.get("inventory-catalog-item-projection:catalog:v1:evt_10001")).toBe("applied");
    expect(applicationStore.get("inventory-catalog-item-projection:catalog:v1:evt_10002")).toBe("applied");
  });

  it("summarizes subscription ledger metrics by projection key", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => undefined,
      },
      eventTypes: ["catalog.catalog-item.published"],
    });
    const projectionKey = "inventory-catalog-item-projection:catalog:v1";
    getApplicationStatusStore(targetPool).set(`${projectionKey}:evt_1`, "applied");
    getApplicationStatusStore(targetPool).set(`${projectionKey}:evt_2`, "poison");

    await expect(
      summarizeRuntimeSubscriptionLedgers({
        mountedContexts: [
          {
            contextName: "inventory",
            module: {} as unknown as BcApiModule,
            services: {},
            pool: targetPool as never,
            projectionHandlerSets: [],
          },
        ],
        subscriptionRunners: [runner],
      }),
    ).resolves.toEqual([
      {
        projectionKey,
        targetContextName: "inventory",
        appliedRows: "1",
        startedRows: "0",
        poisonRows: "1",
        transientRows: "0",
        oldestStartedAt: null,
      },
    ]);
  });

  it("lists blocked stream details for operator projection views", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_bad" }, "catalog.item-cat_bad"),
    ]);

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          throw new Error("bad catalog item shape");
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
    });

    await runner.runOnce();

    await expect(
      listProjectionBlockedStreamDetails(
        {
          mountedContexts: [
            {
              contextName: "inventory",
              module: {} as unknown as BcApiModule,
              services: {},
              pool: targetPool as never,
              projectionHandlerSets: [],
            },
          ],
          subscriptionRunners: [runner],
        },
        "inventory-catalog-item-projection:catalog:v1",
      ),
    ).resolves.toMatchObject({
      projectionKey: "inventory-catalog-item-projection:catalog:v1",
      blockedStreams: [
        {
          streamId: "catalog.item-cat_bad",
        },
      ],
    });
  });

  it("lists blocked stream details for dotted projection group keys", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const runner = createSubscriptionRunner("checkout", targetPool as never, sourcePool as never, {
      subscriptionName: "checkout.checkout.session-projection",
      sourceContextName: "checkout",
      projectionName: "checkout.session-projection",
      subscriptionVersion: 1,
      handlers: {
        "checkout.session.updated": async () => undefined,
      },
      eventTypes: ["checkout.session.updated"],
    });
    const checkpointKey = "checkout.session-projection:checkout:v1";
    getBlockedStreamStore(targetPool).set(`${checkpointKey}:checkout.session-1`, {
      projectionKey: checkpointKey,
      streamId: "checkout.session-1",
      firstBlockedGlobalPosition: "7",
      firstBlockedStreamVersion: 2,
      lastSeenGlobalPosition: "9",
      deferredEventCount: 1,
      state: "blocked",
    });

    await expect(
      listProjectionBlockedStreamDetails(
        {
          mountedContexts: [
            {
              contextName: "checkout",
              module: {} as unknown as BcApiModule,
              services: {},
              pool: targetPool as never,
              projectionHandlerSets: [],
            },
          ],
          subscriptionRunners: [runner],
        },
        "checkout.checkout.session-projection",
      ),
    ).resolves.toMatchObject({
      projectionKey: "checkout.checkout.session-projection",
      blockedStreams: [
        {
          projectionKey: checkpointKey,
          streamId: "checkout.session-1",
        },
      ],
    });
  });
});
