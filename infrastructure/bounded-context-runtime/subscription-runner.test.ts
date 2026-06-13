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

  it("reports applicable lag separately from source scan lag", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
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
    expect(status.applicableLagEstimate).toBe("2");
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

    expect(observedDbHandles).toEqual([targetPool]);
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
});
