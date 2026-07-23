import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineBcProjectionGroupReset,
  type BcApiModule,
  type BcProjectionGroup,
} from "@chase-sets/bounded-context-module";
import {
  createEventCoreMock,
  createEventCorePostgresMock,
  createMockPool,
  createStoredEvent,
  getCheckpointStore,
  getGenerationRetentionStore,
  getProjectionRevisionStore,
  getTruncateLog,
  resetMockPoolState,
  sourceEventsByPool,
} from "./index-test-harness";

vi.mock("@chase-sets/event-core", () => createEventCoreMock());
vi.mock("@chase-sets/event-core-postgres", () => createEventCorePostgresMock());

import { createMountedRuntime, createProjectionGroupRuntime } from "./index-test-runtime-helpers";

import {
  cleanupRuntimeProjectionGenerations,
  createSubscriptionRunner,
  rebuildProjectionGroup,
  refreshProjectionGroupStatuses,
  resetProjectionGroup,
  summarizeProjectionReplayStatuses,
  syncContextProjectionGroups,
} from "./index";

describe("bounded context projection groups", () => {
  beforeEach(() => {
    resetMockPoolState();
  });

  it("resetting a projection group clears every contributing checkpoint", async () => {
    const identitySourcePool = createMockPool();
    const marketplaceSourcePool = createMockPool();
    const targetPool = createMockPool();

    sourceEventsByPool.set(identitySourcePool, [
      createStoredEvent("1", "identity.account.created", { accountId: "acc_1" }),
    ]);
    sourceEventsByPool.set(marketplaceSourcePool, [
      createStoredEvent("1", "marketplace.listing.created", { listingId: "lst_1" }),
    ]);

    const identityRunner = createSubscriptionRunner("discovery", targetPool as never, identitySourcePool as never, {
      subscriptionName: "discovery.identity-market-projection",
      sourceContextName: "identity",
      projectionName: "discovery-market-projection",
      subscriptionVersion: 1,
      handlers: {
        "identity.account.created": async () => undefined,
      },
      eventTypes: ["identity.account.created"],
      order: 20,
    });
    const marketplaceRunner = createSubscriptionRunner(
      "discovery",
      targetPool as never,
      marketplaceSourcePool as never,
      {
        subscriptionName: "discovery.marketplace-market-projection",
        sourceContextName: "marketplace",
        projectionName: "discovery-market-projection",
        subscriptionVersion: 1,
        handlers: {
          "marketplace.listing.created": async () => undefined,
        },
        eventTypes: ["marketplace.listing.created"],
        order: 30,
      },
    );

    await identityRunner.runOnce();
    await marketplaceRunner.runOnce();

    const [group] = createProjectionGroupRuntime(
      "discovery",
      targetPool,
      [
        {
          projectionName: "discovery-market-projection",
          sourceContextNames: ["identity", "marketplace"],
          ownedTables: ["discovery_market_accounts", "discovery_market_listings"],
          resetStrategy: "replay-only",
          requiredDuringBootstrap: true,
        },
      ],
      [identityRunner, marketplaceRunner],
    );

    await resetProjectionGroup(group);

    expect(getCheckpointStore(targetPool).get("discovery-market-projection:identity:v1")).toBeUndefined();
    expect(getCheckpointStore(targetPool).get("discovery-market-projection:marketplace:v1")).toBeUndefined();
    expect(getTruncateLog(targetPool)).toEqual([]);
  });

  it("fails closed when an owned-table projection group omits reset strategy", async () => {
    const targetPool = createMockPool();

    expect(() =>
      createProjectionGroupRuntime(
        "inventory",
        targetPool,
        [
          {
            projectionName: "inventory-catalog-item-projection",
            sourceContextNames: ["catalog"],
            ownedTables: ["inventory_catalog_items"],
            requiredDuringBootstrap: true,
          },
        ],
        [],
      ),
    ).toThrow("owns read-model tables but does not declare resetStrategy");
  });

  it("allows projection groups to omit explicitly optional unmounted sources", () => {
    const targetPool = createMockPool();
    const runner = createSubscriptionRunner("platform-operations", targetPool as never, targetPool as never, {
      subscriptionName: "platform-operations.reported-content-queue-projection",
      sourceContextName: "platform-operations",
      projectionName: "reported-content-queue-projection",
      subscriptionVersion: 1,
      handlers: {
        "platform-operations.reported-content.action-recorded": async () => undefined,
      },
      eventTypes: ["platform-operations.reported-content.action-recorded"],
    });

    const [group] = createProjectionGroupRuntime(
      "platform-operations",
      targetPool,
      [
        {
          projectionName: "reported-content-queue-projection",
          sourceContextNames: ["marketplace", "platform-operations"],
          optionalSourceContextNames: ["marketplace"],
          ownedTables: ["platform_operations_reported_content_queue_pages"],
          resetStrategy: "replay-only",
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    expect(group.sourceContextNames).toEqual(["marketplace", "platform-operations"]);
    expect(group.subscriptionRunners.map((entry) => entry.sourceContextName)).toEqual(["platform-operations"]);
  });

  it("omits projection groups whose only sources are explicitly optional and unmounted", () => {
    const targetPool = createMockPool();

    const groups = createProjectionGroupRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-fulfillment-restock-workflow",
          sourceContextNames: ["fulfillment"],
          optionalSourceContextNames: ["fulfillment"],
          ownedTables: ["inventory_fulfillment_shipment_sources"],
          resetStrategy: "truncate-owned-tables",
          requiredDuringBootstrap: false,
        },
      ],
      [],
    );

    expect(groups).toEqual([]);
  });

  it("omits all-sources-mounted projection groups when any source context is unmounted", () => {
    const targetPool = createMockPool();

    const groups = createProjectionGroupRuntime(
      "auth",
      targetPool,
      [
        {
          projectionName: "auth-agent-order-webhook-projection",
          sourceContextNames: ["ordering", "payments"],
          sourceContextMount: "when-all-sources-mounted",
          ownedTables: ["identity_agent_webhook_deliveries"],
          resetStrategy: "append-only-no-reset",
          requiredDuringBootstrap: false,
        },
      ],
      [],
    );

    expect(groups).toEqual([]);
  });

  it("fails closed when a side-effect projection group declares owned tables", async () => {
    const targetPool = createMockPool();

    expect(() =>
      createProjectionGroupRuntime(
        "ordering",
        targetPool,
        [
          {
            projectionName: "ordering-inventory-reservation-outcomes",
            sourceContextNames: ["inventory"],
            ownedTables: ["ordering_order_hold_pages"],
            resetStrategy: "replay-only",
            requiredDuringBootstrap: false,
            sideEffectOnly: true,
          },
        ],
        [],
      ),
    ).toThrow(
      "Context 'ordering' projection group 'ordering-inventory-reservation-outcomes' is side-effect-only and cannot own read-model tables: ordering_order_hold_pages.",
    );
  });

  it("only truncates owned read-model tables when the projection declares truncate reset", async () => {
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
    const [group] = createProjectionGroupRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-catalog-item-projection",
          sourceContextNames: ["catalog"],
          ownedTables: ["inventory_catalog_items"],
          resetStrategy: "truncate-owned-tables",
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    await resetProjectionGroup(group);

    expect(getTruncateLog(targetPool)).toEqual([["inventory_catalog_items"]]);
  });

  it("rebuilding a projection group replays from origin without truncating live read tables", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }),
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
      order: 10,
    });

    await runner.runOnce();

    const [group] = createProjectionGroupRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-catalog-item-projection",
          sourceContextNames: ["catalog"],
          ownedTables: ["inventory_catalog_items", "inventory_catalog_blueprints"],
          resetStrategy: "replay-only",
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    await rebuildProjectionGroup(group);

    expect(seenPositions).toEqual(["1", "2", "1", "2"]);
    expect(getCheckpointStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBe("2");
    expect(getTruncateLog(targetPool)).toEqual([]);
    expect(group.getStatus().caughtUp).toBe(true);
  });

  it("retains previous projection generations until the retention cleanup job runs", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" })]);

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
          resetStrategy: "generation-cutover",
          reset: defineBcProjectionGroupReset(async (_database: unknown) => undefined),
          requiredDuringBootstrap: true,
        } as BcProjectionGroup,
      ],
      [runner],
    );

    await rebuildProjectionGroup(group, { operationId: "projection-operation-test" });

    expect(getGenerationRetentionStore(targetPool)).toEqual(new Set(["inventory:inventory-catalog-item-projection"]));
    await expect(
      cleanupRuntimeProjectionGenerations({
        mountedContexts: [
          {
            contextName: "inventory",
            module: {} as unknown as BcApiModule,
            services: {},
            pool: targetPool as never,
            projectionHandlerSets: [],
          },
        ],
      }),
    ).resolves.toBe(1);
    expect(getGenerationRetentionStore(targetPool)).toEqual(new Set());
  });

  it("cleans projection generations only for mounted contexts that own projection groups", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    const analyticalPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" })]);

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
          resetStrategy: "generation-cutover",
          reset: defineBcProjectionGroupReset(async (_database: unknown) => undefined),
          requiredDuringBootstrap: true,
        } as BcProjectionGroup,
      ],
      [runner],
    );

    await rebuildProjectionGroup(group, { operationId: "projection-operation-test" });
    getGenerationRetentionStore(analyticalPool).add("insights:stale-analytical-projection");

    await expect(
      cleanupRuntimeProjectionGenerations({
        mountedContexts: [
          {
            contextName: "inventory",
            module: {} as unknown as BcApiModule,
            services: {},
            pool: targetPool as never,
            projectionHandlerSets: [],
          },
          {
            contextName: "insights",
            module: {} as unknown as BcApiModule,
            services: {},
            pool: analyticalPool as never,
            projectionHandlerSets: [],
          },
        ],
        projectionGroups: [group],
      }),
    ).resolves.toBe(1);

    expect(getGenerationRetentionStore(targetPool)).toEqual(new Set());
    expect(getGenerationRetentionStore(analyticalPool)).toEqual(new Set(["insights:stale-analytical-projection"]));
  });

  it("keeps the active projection generation retained when a generation rebuild fails", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" })]);

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          throw new Error("projection failed");
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      errorPolicy: "global-strict",
    });
    const [group] = createProjectionGroupRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-catalog-item-projection",
          sourceContextNames: ["catalog"],
          ownedTables: ["inventory_catalog_items"],
          resetStrategy: "generation-cutover",
          reset: defineBcProjectionGroupReset(async (_database: unknown) => undefined),
          requiredDuringBootstrap: true,
        } as BcProjectionGroup,
      ],
      [runner],
    );

    await expect(rebuildProjectionGroup(group, { operationId: "projection-operation-test" })).rejects.toThrow(
      "projection failed",
    );

    expect(getGenerationRetentionStore(targetPool)).toEqual(new Set());
    expect(getCheckpointStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBeUndefined();
  });

  it("marks a projection revision after a successful sync without rebuilding unchanged projections", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" })]);
    getProjectionRevisionStore(targetPool).set("inventory:inventory-catalog-item-projection", 2);

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
    });
    const runtime = createMountedRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-catalog-item-projection",
          projectionRevision: 2,
          sourceContextNames: ["catalog"],
          ownedTables: ["inventory_catalog_items"],
          resetStrategy: "replay-only",
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    await syncContextProjectionGroups(runtime, "inventory");

    expect(seenPositions).toEqual(["1"]);
    expect(getTruncateLog(targetPool)).toEqual([]);
    expect(getProjectionRevisionStore(targetPool).get("inventory:inventory-catalog-item-projection")).toBe(2);
    expect(runtime.projectionGroups[0].getStatus().revisionStale).toBe(false);
  });

  it("automatically rebuilds a projection group when the declared projection revision changes", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }),
    ]);
    getCheckpointStore(targetPool).set("inventory-catalog-item-projection:catalog:v1", "2");
    getProjectionRevisionStore(targetPool).set("inventory:inventory-catalog-item-projection", 1);

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
    });
    const runtime = createMountedRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-catalog-item-projection",
          projectionRevision: 2,
          sourceContextNames: ["catalog"],
          ownedTables: ["inventory_catalog_items"],
          resetStrategy: "replay-only",
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    await syncContextProjectionGroups(runtime, "inventory");

    expect(seenPositions).toEqual(["1", "2"]);
    expect(getTruncateLog(targetPool)).toEqual([]);
    expect(getProjectionRevisionStore(targetPool).get("inventory:inventory-catalog-item-projection")).toBe(2);
    expect(getCheckpointStore(targetPool).get("inventory-catalog-item-projection:catalog:v1")).toBe("2");
    expect(runtime.projectionGroups[0].getStatus().revisionStale).toBe(false);
  });

  it("does not mark the new projection revision when automatic rebuild fails", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" })]);
    getCheckpointStore(targetPool).set("inventory-catalog-item-projection:catalog:v1", "1");
    getProjectionRevisionStore(targetPool).set("inventory:inventory-catalog-item-projection", 1);

    const runner = createSubscriptionRunner("inventory", targetPool as never, sourcePool as never, {
      subscriptionName: "inventory.catalog-item-projection",
      sourceContextName: "catalog",
      projectionName: "inventory-catalog-item-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          throw new Error("projection handler failed");
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      errorPolicy: "global-strict",
    });
    const runtime = createMountedRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-catalog-item-projection",
          projectionRevision: 2,
          sourceContextNames: ["catalog"],
          ownedTables: ["inventory_catalog_items"],
          resetStrategy: "replay-only",
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    await expect(syncContextProjectionGroups(runtime, "inventory")).rejects.toThrow("projection handler failed");

    expect(getTruncateLog(targetPool)).toEqual([]);
    expect(getProjectionRevisionStore(targetPool).get("inventory:inventory-catalog-item-projection")).toBe(1);

    await refreshProjectionGroupStatuses(runtime);
    expect(runtime.projectionGroups[0].getStatus()).toMatchObject({
      revisionStale: true,
      state: "error",
      lastError: "projection handler failed",
    });
  });

  it("reports degraded replay status while a required projection group is still catching up", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" })]);

    let releaseHandler: () => void = () => undefined;
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const runner = createSubscriptionRunner("pricing", targetPool as never, sourcePool as never, {
      subscriptionName: "pricing.catalog-input-projection",
      sourceContextName: "catalog",
      projectionName: "pricing-catalog-input-projection",
      subscriptionVersion: 1,
      handlers: {
        "catalog.catalog-item.published": async () => {
          await handlerBlocked;
        },
      },
      eventTypes: ["catalog.catalog-item.published"],
      order: 10,
    });

    const [group] = createProjectionGroupRuntime(
      "pricing",
      targetPool,
      [
        {
          projectionName: "pricing-catalog-input-projection",
          sourceContextNames: ["catalog"],
          ownedTables: ["pricing_catalog_item_inputs"],
          resetStrategy: "replay-only",
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    const runPromise = runner.runOnce();
    await Promise.resolve();

    const runningSummary = summarizeProjectionReplayStatuses(
      await refreshProjectionGroupStatuses({ projectionGroups: [group] }, { requiredOnly: true }),
    );
    expect(runningSummary).toMatchObject({
      status: "degraded",
      totalGroups: 1,
      requiredGroups: 1,
      runningGroups: 1,
      caughtUpGroups: 0,
      behindGroups: 1,
    });

    releaseHandler?.();
    await runPromise;

    const caughtUpSummary = summarizeProjectionReplayStatuses(
      await refreshProjectionGroupStatuses({ projectionGroups: [group] }, { requiredOnly: true }),
    );
    expect(caughtUpSummary).toMatchObject({
      status: "ok",
      totalGroups: 1,
      requiredGroups: 1,
      runningGroups: 0,
      caughtUpGroups: 1,
      behindGroups: 0,
    });
  });

  it("syncs only required projection groups during bootstrap catch-up", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [createStoredEvent("1", "marketplace.listing.created", { listingId: "lst_1" })]);

    const requiredSeen: string[] = [];
    const optionalSeen: string[] = [];
    const requiredRunner = createSubscriptionRunner("pricing", targetPool as never, sourcePool as never, {
      subscriptionName: "pricing.market-input-projection",
      sourceContextName: "marketplace",
      projectionName: "pricing-market-input-projection",
      subscriptionVersion: 1,
      handlers: {
        "marketplace.listing.created": async (event) => {
          requiredSeen.push(event.globalPosition);
        },
      },
      eventTypes: ["marketplace.listing.created"],
      order: 10,
    });
    const optionalRunner = createSubscriptionRunner("pricing", targetPool as never, sourcePool as never, {
      subscriptionName: "pricing.market-analytics-projection",
      sourceContextName: "marketplace",
      projectionName: "pricing-market-analytics-projection",
      subscriptionVersion: 1,
      handlers: {
        "marketplace.listing.created": async (event) => {
          optionalSeen.push(event.globalPosition);
        },
      },
      eventTypes: ["marketplace.listing.created"],
      order: 20,
    });

    const runtime = createMountedRuntime(
      "pricing",
      targetPool,
      [
        {
          projectionName: "pricing-market-input-projection",
          sourceContextNames: ["marketplace"],
          ownedTables: ["pricing_market_listing_inputs"],
          resetStrategy: "replay-only",
          requiredDuringBootstrap: true,
        },
        {
          projectionName: "pricing-market-analytics-projection",
          sourceContextNames: ["marketplace"],
          ownedTables: ["pricing_market_analytics"],
          resetStrategy: "replay-only",
          requiredDuringBootstrap: false,
        },
      ],
      [requiredRunner, optionalRunner],
    );

    await syncContextProjectionGroups(runtime, "pricing", { requiredOnly: true });

    expect(requiredSeen).toEqual(["1"]);
    expect(optionalSeen).toEqual([]);
    expect(getCheckpointStore(targetPool).get("pricing-market-input-projection:marketplace:v1")).toBe("1");
    expect(getCheckpointStore(targetPool).get("pricing-market-analytics-projection:marketplace:v1")).toBeUndefined();
  });
});
