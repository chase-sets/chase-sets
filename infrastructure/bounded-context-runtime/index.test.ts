import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BcApiModule,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";

type MockStoredEvent = Readonly<{
  globalPosition: string;
  streamId: string;
  streamVersion: number;
  eventType: string;
  payload: unknown;
  recordedAt: string;
  tenantId: string;
  performedByUserId: string;
  forAccountId: string;
}>;

type MockPool = {
  query: (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
};

const sourceEventsByPool = new Map<object, MockStoredEvent[]>();
const checkpointsByPool = new Map<object, Map<string, string>>();
const projectionRevisionsByPool = new Map<object, Map<string, number>>();
const truncatedTablesByPool = new Map<object, string[][]>();

function getCheckpointStore(pool: object) {
  let store = checkpointsByPool.get(pool);
  if (!store) {
    store = new Map();
    checkpointsByPool.set(pool, store);
  }

  return store;
}

function getProjectionRevisionStore(pool: object) {
  let store = projectionRevisionsByPool.get(pool);
  if (!store) {
    store = new Map();
    projectionRevisionsByPool.set(pool, store);
  }

  return store;
}

function getTruncateLog(pool: object) {
  let log = truncatedTablesByPool.get(pool);
  if (!log) {
    log = [];
    truncatedTablesByPool.set(pool, log);
  }

  return log;
}

function createMockPool(): MockPool {
  const pool = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("SELECT COALESCE(MAX(global_position), 0) AS head")) {
        const events = sourceEventsByPool.get(pool) ?? [];
        const head = events.reduce(
          (current, event) =>
            Number(event.globalPosition) > Number(current)
              ? event.globalPosition
              : current,
          "0",
        );
        return { rows: [{ head }] };
      }

      if (sql.includes("SELECT last_global_position")) {
        const checkpointKey = String(params[0]);
        const value = getCheckpointStore(pool).get(checkpointKey);
        return {
          rows: value ? [{ last_global_position: value }] : [],
        };
      }

      if (sql.includes("SELECT projection_revision")) {
        const key = `${params[0]}:${params[1]}`;
        const value = getProjectionRevisionStore(pool).get(key);
        return {
          rows: value ? [{ projection_revision: value }] : [],
        };
      }

      if (sql.includes("INSERT INTO event_subscription_checkpoints")) {
        const checkpointKey = String(params[0]);
        const lastGlobalPosition = String(params[4]);
        const store = getCheckpointStore(pool);
        const previous = store.get(checkpointKey) ?? "0";
        store.set(
          checkpointKey,
          Number(lastGlobalPosition) > Number(previous)
            ? lastGlobalPosition
            : previous,
        );
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO event_projection_group_revisions")) {
        const key = `${params[0]}:${params[1]}`;
        getProjectionRevisionStore(pool).set(key, Number(params[2]));
        return { rows: [] };
      }

      if (sql.includes("DELETE FROM event_subscription_checkpoints")) {
        getCheckpointStore(pool).delete(String(params[0]));
        return { rows: [] };
      }

      if (sql.startsWith("TRUNCATE TABLE ")) {
        const tables = sql
          .replace("TRUNCATE TABLE ", "")
          .replace(" RESTART IDENTITY CASCADE", "")
          .split(",")
          .map((tableName) => tableName.trim());
        getTruncateLog(pool).push(tables);
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL in test double: ${sql}`);
    },
  };

  return pool;
}

vi.mock("@chase-sets/event-core", () => ({
  ZERO_GLOBAL_POSITION: "0",
  toTransportEvent: (storedEvent: MockStoredEvent) => ({
    type: storedEvent.eventType,
    data: storedEvent.payload,
    streamId: storedEvent.streamId,
    streamVersion: storedEvent.streamVersion,
    globalPosition: storedEvent.globalPosition,
    tenantId: storedEvent.tenantId,
    audit: {
      performedByUserId: storedEvent.performedByUserId,
      forAccountId: storedEvent.forAccountId,
    },
    timing: {
      recordedAt: storedEvent.recordedAt,
    },
  }),
}));

vi.mock("@chase-sets/event-core-postgres", () => ({
  createPostgresEventStore: ({ pool }: { pool: object }) => ({
    readAll: async ({
      afterGlobalPosition,
      limit,
    }: {
      afterGlobalPosition: string;
      limit: number;
    }) =>
      (sourceEventsByPool.get(pool) ?? [])
        .filter(
          (event) => Number(event.globalPosition) > Number(afterGlobalPosition),
        )
        .slice(0, limit),
  }),
  eventCorePostgresSchemaSql: "",
}));

import {
  createSubscriptionRunner,
  refreshProjectionGroupStatuses,
  rebuildProjectionGroup,
  resetProjectionGroup,
  resolveModuleProjectionGroups,
  summarizeProjectionReplayStatuses,
  syncContextProjectionGroups,
} from "./index";

function createStoredEvent(
  globalPosition: string,
  eventType: string,
  payload: Record<string, unknown>,
): MockStoredEvent {
  return {
    globalPosition,
    streamId: `${eventType}-${globalPosition}`,
    streamVersion: Number(globalPosition),
    eventType,
    payload,
    recordedAt: `2026-04-06T00:0${globalPosition}:00.000Z`,
    tenantId: "tnt_test",
    performedByUserId: "usr_test",
    forAccountId: "acc_test",
  };
}

function createProjectionGroupRuntime(
  targetContextName: string,
  targetPool: MockPool,
  projectionGroups: readonly BcProjectionGroupDeclaration[],
  runners: readonly ReturnType<typeof createSubscriptionRunner>[],
) {
  const module: Pick<
    BcApiModule,
    "contextName" | "projectionGroups"
  > = {
    contextName: targetContextName,
    projectionGroups,
  };

  return resolveModuleProjectionGroups(
    [
      {
        contextName: targetContextName,
        module: module as BcApiModule,
        services: {},
        pool: targetPool as never,
        projectors: [],
      },
    ],
    runners,
  );
}

function createMountedRuntime(
  targetContextName: string,
  targetPool: MockPool,
  projectionGroups: readonly BcProjectionGroupDeclaration[],
  runners: readonly ReturnType<typeof createSubscriptionRunner>[],
) {
  const groupRuntime = createProjectionGroupRuntime(
    targetContextName,
    targetPool,
    projectionGroups,
    runners,
  );

  return {
    mountedContexts: [
      {
        contextName: targetContextName,
        module: {
          contextName: targetContextName,
          projectionGroups,
        } as BcApiModule,
        services: {},
        pool: targetPool as never,
        projectors: [],
      },
    ],
    projectionGroups: groupRuntime,
    subscriptionRunners: runners,
  };
}

describe("bounded context projection replay", () => {
  beforeEach(() => {
    sourceEventsByPool.clear();
    checkpointsByPool.clear();
    projectionRevisionsByPool.clear();
    truncatedTablesByPool.clear();
  });

  it("persists versioned checkpoints and replays a new subscription version from origin", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }),
    ]);

    const seenByVersion: string[] = [];
    const runnerV1 = createSubscriptionRunner(
      "ordering",
      targetPool as never,
      sourcePool as never,
      {
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
      },
    );

    await runnerV1.runOnce();
    expect(seenByVersion).toEqual(["v1:1", "v1:2"]);
    expect(getCheckpointStore(targetPool).get("ordering-catalog-item-projection:catalog:v1")).toBe("2");

    const runnerV2 = createSubscriptionRunner(
      "ordering",
      targetPool as never,
      sourcePool as never,
      {
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
      },
    );

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

    const failingRunner = createSubscriptionRunner(
      "marketplace",
      targetPool as never,
      sourcePool as never,
      {
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
        order: 10,
      },
    );

    await expect(failingRunner.runOnce()).rejects.toThrow("transient failure");
    expect(
      getCheckpointStore(targetPool).get(
        "marketplace-inventory-supply-projection:inventory:v1",
      ),
    ).toBe("1");

    const resumedPositions: string[] = [];
    const resumedRunner = createSubscriptionRunner(
      "marketplace",
      targetPool as never,
      sourcePool as never,
      {
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
      },
    );

    await resumedRunner.runOnce();
    expect(resumedPositions).toEqual(["2"]);
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

    const identityRunner = createSubscriptionRunner(
      "discovery",
      targetPool as never,
      identitySourcePool as never,
      {
        subscriptionName: "discovery.identity-market-projection",
        sourceContextName: "identity",
        projectionName: "discovery-market-projection",
        subscriptionVersion: 1,
        handlers: {
          "identity.account.created": async () => undefined,
        },
        eventTypes: ["identity.account.created"],
        order: 20,
      },
    );
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
          requiredDuringBootstrap: true,
        },
      ],
      [identityRunner, marketplaceRunner],
    );

    await resetProjectionGroup(group);

    expect(
      getCheckpointStore(targetPool).get("discovery-market-projection:identity:v1"),
    ).toBeUndefined();
    expect(
      getCheckpointStore(targetPool).get("discovery-market-projection:marketplace:v1"),
    ).toBeUndefined();
    expect(getTruncateLog(targetPool)).toEqual([
      ["discovery_market_accounts", "discovery_market_listings"],
    ]);
  });

  it("rebuilding a projection group truncates owned tables and replays from origin", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }),
    ]);

    const seenPositions: string[] = [];
    const runner = createSubscriptionRunner(
      "inventory",
      targetPool as never,
      sourcePool as never,
      {
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
      },
    );

    await runner.runOnce();

    const [group] = createProjectionGroupRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-catalog-item-projection",
          sourceContextNames: ["catalog"],
          ownedTables: [
            "inventory_catalog_items",
            "inventory_catalog_blueprints",
          ],
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    await rebuildProjectionGroup(group);

    expect(seenPositions).toEqual(["1", "2", "1", "2"]);
    expect(
      getCheckpointStore(targetPool).get("inventory-catalog-item-projection:catalog:v1"),
    ).toBe("2");
    expect(getTruncateLog(targetPool)).toEqual([
      ["inventory_catalog_items", "inventory_catalog_blueprints"],
    ]);
    expect(group.getStatus().caughtUp).toBe(true);
  });

  it("marks a projection revision after a successful sync without rebuilding unchanged projections", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
    ]);
    getProjectionRevisionStore(targetPool).set(
      "inventory:inventory-catalog-item-projection",
      2,
    );

    const seenPositions: string[] = [];
    const runner = createSubscriptionRunner(
      "inventory",
      targetPool as never,
      sourcePool as never,
      {
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
      },
    );
    const runtime = createMountedRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-catalog-item-projection",
          projectionRevision: 2,
          sourceContextNames: ["catalog"],
          ownedTables: ["inventory_catalog_items"],
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    await syncContextProjectionGroups(runtime, "inventory");

    expect(seenPositions).toEqual(["1"]);
    expect(getTruncateLog(targetPool)).toEqual([]);
    expect(
      getProjectionRevisionStore(targetPool).get(
        "inventory:inventory-catalog-item-projection",
      ),
    ).toBe(2);
    expect(runtime.projectionGroups[0].getStatus().revisionStale).toBe(false);
  });

  it("automatically rebuilds a projection group when the declared projection revision changes", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
      createStoredEvent("2", "catalog.catalog-item.published", { itemId: "cat_2" }),
    ]);
    getCheckpointStore(targetPool).set(
      "inventory-catalog-item-projection:catalog:v1",
      "2",
    );
    getProjectionRevisionStore(targetPool).set(
      "inventory:inventory-catalog-item-projection",
      1,
    );

    const seenPositions: string[] = [];
    const runner = createSubscriptionRunner(
      "inventory",
      targetPool as never,
      sourcePool as never,
      {
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
      },
    );
    const runtime = createMountedRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-catalog-item-projection",
          projectionRevision: 2,
          sourceContextNames: ["catalog"],
          ownedTables: ["inventory_catalog_items"],
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    await syncContextProjectionGroups(runtime, "inventory");

    expect(seenPositions).toEqual(["1", "2"]);
    expect(getTruncateLog(targetPool)).toEqual([["inventory_catalog_items"]]);
    expect(
      getProjectionRevisionStore(targetPool).get(
        "inventory:inventory-catalog-item-projection",
      ),
    ).toBe(2);
    expect(
      getCheckpointStore(targetPool).get("inventory-catalog-item-projection:catalog:v1"),
    ).toBe("2");
    expect(runtime.projectionGroups[0].getStatus().revisionStale).toBe(false);
  });

  it("does not mark the new projection revision when automatic rebuild fails", async () => {
    const sourcePool = createMockPool();
    const targetPool = createMockPool();
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
    ]);
    getCheckpointStore(targetPool).set(
      "inventory-catalog-item-projection:catalog:v1",
      "1",
    );
    getProjectionRevisionStore(targetPool).set(
      "inventory:inventory-catalog-item-projection",
      1,
    );

    const runner = createSubscriptionRunner(
      "inventory",
      targetPool as never,
      sourcePool as never,
      {
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
      },
    );
    const runtime = createMountedRuntime(
      "inventory",
      targetPool,
      [
        {
          projectionName: "inventory-catalog-item-projection",
          projectionRevision: 2,
          sourceContextNames: ["catalog"],
          ownedTables: ["inventory_catalog_items"],
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    await expect(syncContextProjectionGroups(runtime, "inventory")).rejects.toThrow(
      "projection handler failed",
    );

    expect(getTruncateLog(targetPool)).toEqual([["inventory_catalog_items"]]);
    expect(
      getProjectionRevisionStore(targetPool).get(
        "inventory:inventory-catalog-item-projection",
      ),
    ).toBe(1);

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
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "catalog.catalog-item.published", { itemId: "cat_1" }),
    ]);

    let releaseHandler: (() => void) | null = null;
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const runner = createSubscriptionRunner(
      "pricing",
      targetPool as never,
      sourcePool as never,
      {
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
      },
    );

    const [group] = createProjectionGroupRuntime(
      "pricing",
      targetPool,
      [
        {
          projectionName: "pricing-catalog-input-projection",
          sourceContextNames: ["catalog"],
          ownedTables: ["pricing_catalog_item_inputs"],
          requiredDuringBootstrap: true,
        },
      ],
      [runner],
    );

    const runPromise = runner.runOnce();
    await Promise.resolve();

    const runningSummary = summarizeProjectionReplayStatuses(
      await refreshProjectionGroupStatuses(
        { projectionGroups: [group] },
        { requiredOnly: true },
      ),
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
      await refreshProjectionGroupStatuses(
        { projectionGroups: [group] },
        { requiredOnly: true },
      ),
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
    sourceEventsByPool.set(sourcePool, [
      createStoredEvent("1", "marketplace.listing.created", { listingId: "lst_1" }),
    ]);

    const requiredSeen: string[] = [];
    const optionalSeen: string[] = [];
    const requiredRunner = createSubscriptionRunner(
      "pricing",
      targetPool as never,
      sourcePool as never,
      {
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
      },
    );
    const optionalRunner = createSubscriptionRunner(
      "pricing",
      targetPool as never,
      sourcePool as never,
      {
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
      },
    );

    const runtime = createMountedRuntime(
      "pricing",
      targetPool,
      [
        {
          projectionName: "pricing-market-input-projection",
          sourceContextNames: ["marketplace"],
          ownedTables: ["pricing_market_listing_inputs"],
          requiredDuringBootstrap: true,
        },
        {
          projectionName: "pricing-market-analytics-projection",
          sourceContextNames: ["marketplace"],
          ownedTables: ["pricing_market_analytics"],
          requiredDuringBootstrap: false,
        },
      ],
      [requiredRunner, optionalRunner],
    );

    await syncContextProjectionGroups(runtime, "pricing", { requiredOnly: true });

    expect(requiredSeen).toEqual(["1"]);
    expect(optionalSeen).toEqual([]);
    expect(
      getCheckpointStore(targetPool).get("pricing-market-input-projection:marketplace:v1"),
    ).toBe("1");
    expect(
      getCheckpointStore(targetPool).get("pricing-market-analytics-projection:marketplace:v1"),
    ).toBeUndefined();
  });
});
