import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BcApiModule, BcProjectionGroupDeclaration } from "@chase-sets/bounded-context-module";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";

type MockStoredEvent = Readonly<{
  eventId: string;
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
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  connect: () => Promise<MockPool & { release: () => void }>;
};

const sourceEventsByPool = new Map<object, MockStoredEvent[]>();
const checkpointsByPool = new Map<object, Map<string, string>>();
const checkpointWriteCountsByPool = new Map<object, Map<string, number>>();
const projectionRevisionsByPool = new Map<object, Map<string, number>>();
const truncatedTablesByPool = new Map<object, string[][]>();
const blockedStreamsByPool = new Map<object, Map<string, MockBlockedStream>>();
const poisonEventsByPool = new Map<object, Set<string>>();
const applicationStatusByPool = new Map<object, Map<string, string>>();
const readAllCallsByPool = new Map<object, Record<string, unknown>[]>();
const sourceHeadByPool = new Map<object, string>();
const generationRetentionByPool = new Map<object, Set<string>>();

type MockBlockedStream = Readonly<{
  projectionKey: string;
  streamId: string;
  firstBlockedGlobalPosition: string;
  firstBlockedStreamVersion: number;
  lastSeenGlobalPosition: string;
  deferredEventCount: number;
  state: "blocked" | "retrying" | "resolved";
}>;

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

function getCheckpointWriteCountStore(pool: object) {
  let store = checkpointWriteCountsByPool.get(pool);
  if (!store) {
    store = new Map();
    checkpointWriteCountsByPool.set(pool, store);
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

function getBlockedStreamStore(pool: object) {
  let store = blockedStreamsByPool.get(pool);
  if (!store) {
    store = new Map();
    blockedStreamsByPool.set(pool, store);
  }

  return store;
}

function getPoisonEventStore(pool: object) {
  let store = poisonEventsByPool.get(pool);
  if (!store) {
    store = new Set();
    poisonEventsByPool.set(pool, store);
  }

  return store;
}

function getApplicationStatusStore(pool: object) {
  let store = applicationStatusByPool.get(pool);
  if (!store) {
    store = new Map();
    applicationStatusByPool.set(pool, store);
  }

  return store;
}

function getGenerationRetentionStore(pool: object) {
  let store = generationRetentionByPool.get(pool);
  if (!store) {
    store = new Set();
    generationRetentionByPool.set(pool, store);
  }

  return store;
}

function getReadAllCalls(pool: object) {
  let calls = readAllCallsByPool.get(pool);
  if (!calls) {
    calls = [];
    readAllCallsByPool.set(pool, calls);
  }

  return calls;
}

function createMockPool(): MockPool {
  const pool = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      if (sql === "SET LOCAL statement_timeout = $1") {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("SELECT COALESCE(MAX(global_position), 0) AS head")) {
        const configuredHead = sourceHeadByPool.get(pool);
        if (configuredHead) {
          return { rows: [{ head: configuredHead }] };
        }

        const events = sourceEventsByPool.get(pool) ?? [];
        const head = events.reduce(
          (current, event) => (Number(event.globalPosition) > Number(current) ? event.globalPosition : current),
          "0",
        );
        return { rows: [{ head }] };
      }

      if (sql.includes("SELECT COUNT(*) AS count") && sql.includes("FROM event_store_events")) {
        const afterGlobalPosition = Number(params[0] ?? 0);
        const eventTypes = Array.isArray(params[1]) ? params[1].map(String) : [];
        const events = sourceEventsByPool.get(pool) ?? [];
        const count = events.filter(
          (event) =>
            Number(event.globalPosition) > afterGlobalPosition &&
            (eventTypes.length === 0 || eventTypes.includes(event.eventType)),
        ).length;
        return { rows: [{ count: String(count) }] };
      }

      if (sql.includes("COUNT(*) FILTER") && sql.includes("FROM event_subscription_applications")) {
        const projectionKey = String(params[0]);
        const rows = [...getApplicationStatusStore(pool)].filter(([key]) => key.startsWith(`${projectionKey}:`));
        return {
          rows: [
            {
              applied_rows: rows.filter(([, status]) => status === "applied").length,
              started_rows: rows.filter(([, status]) => status === "started").length,
              poison_rows: rows.filter(([, status]) => status === "poison").length,
              transient_rows: rows.filter(([, status]) => status === "transient").length,
              oldest_started_at: null,
            },
          ],
        };
      }

      if (sql.includes("SELECT last_global_position")) {
        const checkpointKey = String(params[0]);
        const value = getCheckpointStore(pool).get(checkpointKey);
        return {
          rows: value ? [{ last_global_position: value }] : [],
        };
      }

      if (
        sql.includes("SELECT") &&
        sql.includes("FROM event_projection_blocked_streams") &&
        sql.includes("FROM event_projection_poison_events")
      ) {
        const projectionKey = String(params[0]);
        const blockedStreamCount = [...getBlockedStreamStore(pool).values()].filter(
          (stream) => stream.projectionKey === projectionKey && stream.state !== "resolved",
        ).length;
        const poisonEventCount = [...getPoisonEventStore(pool)].filter((key) =>
          key.startsWith(`${projectionKey}:`),
        ).length;

        return {
          rows: [
            {
              blocked_stream_count: blockedStreamCount,
              poison_event_count: poisonEventCount,
            },
          ],
        };
      }

      if (sql.includes("FROM event_projection_blocked_streams") && sql.includes("WHERE projection_key = $1")) {
        const key = `${String(params[0])}:${String(params[1])}`;
        const blockedStream = getBlockedStreamStore(pool).get(key);

        return {
          rows:
            blockedStream && blockedStream.state !== "resolved"
              ? [
                  {
                    projection_key: blockedStream.projectionKey,
                    stream_id: blockedStream.streamId,
                    first_blocked_global_position: blockedStream.firstBlockedGlobalPosition,
                    first_blocked_stream_version: blockedStream.firstBlockedStreamVersion,
                    last_seen_global_position: blockedStream.lastSeenGlobalPosition,
                    deferred_event_count: blockedStream.deferredEventCount,
                    state: blockedStream.state,
                  },
                ]
              : [],
        };
      }

      if (sql.includes("SELECT projection_revision")) {
        const key = `${params[0]}:${params[1]}`;
        const value = getProjectionRevisionStore(pool).get(key);
        return {
          rows: value ? [{ projection_revision: value }] : [],
        };
      }

      if (sql.includes("SELECT event_id, status") && sql.includes("FROM event_subscription_applications")) {
        const projectionKey = String(params[0]);
        const eventIds = Array.isArray(params[1]) ? params[1].map(String) : [];
        return {
          rows: eventIds.flatMap((eventId) => {
            const status = getApplicationStatusStore(pool).get(`${projectionKey}:${eventId}`);
            return status ? [{ event_id: eventId, status }] : [];
          }),
        };
      }

      if (sql.includes("SELECT") && sql.includes("FROM event_subscription_applications")) {
        const key = `${String(params[0])}:${String(params[1])}`;
        const status = getApplicationStatusStore(pool).get(key);
        return {
          rows: status ? [{ status }] : [],
        };
      }

      if (sql.includes("INSERT INTO event_subscription_applications")) {
        const key = `${String(params[0])}:${String(params[1])}`;
        const existing = getApplicationStatusStore(pool).get(key);
        getApplicationStatusStore(pool).set(key, existing === "applied" ? existing : "started");
        return { rows: [] };
      }

      if (sql.includes("UPDATE event_subscription_applications")) {
        const key = `${String(params[0])}:${String(params[1])}`;
        getApplicationStatusStore(pool).set(key, String(params[2]));
        return { rows: [], rowCount: 1 } as never;
      }

      if (sql.includes("INSERT INTO event_subscription_checkpoints")) {
        const checkpointKey = String(params[0]);
        const lastGlobalPosition = String(params[4]);
        const store = getCheckpointStore(pool);
        const previous = store.get(checkpointKey) ?? "0";
        store.set(checkpointKey, Number(lastGlobalPosition) > Number(previous) ? lastGlobalPosition : previous);
        getCheckpointWriteCountStore(pool).set(
          checkpointKey,
          (getCheckpointWriteCountStore(pool).get(checkpointKey) ?? 0) + 1,
        );
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO event_projection_group_revisions")) {
        const key = `${params[0]}:${params[1]}`;
        getProjectionRevisionStore(pool).set(key, Number(params[2]));
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO event_projection_group_generations")) {
        const key = `${params[0]}:${params[1]}`;
        if (sql.includes("state = 'active'")) {
          getGenerationRetentionStore(pool).add(key);
        }
        if (sql.includes("state = 'failed'")) {
          getGenerationRetentionStore(pool).delete(key);
        }
        return { rows: [], rowCount: 1 } as never;
      }

      if (sql.includes("UPDATE event_projection_group_generations")) {
        const cleaned = getGenerationRetentionStore(pool).size;
        getGenerationRetentionStore(pool).clear();
        return { rows: [], rowCount: cleaned } as never;
      }

      if (sql.includes("DELETE FROM event_subscription_checkpoints")) {
        getCheckpointStore(pool).delete(String(params[0]));
        return { rows: [] };
      }

      if (sql.includes("DELETE FROM event_subscription_applications")) {
        const projectionKey = String(params[0]);
        if (sql.includes("status = 'applied'")) {
          const compactThrough = Number(params[1]);
          for (const [key, status] of [...getApplicationStatusStore(pool)]) {
            if (!key.startsWith(`${projectionKey}:`) || status !== "applied") {
              continue;
            }

            const eventId = key.slice(`${projectionKey}:`.length);
            const event = [...sourceEventsByPool.values()].flat().find((candidate) => candidate.eventId === eventId);
            if (event && Number(event.globalPosition) <= compactThrough) {
              getApplicationStatusStore(pool).delete(key);
            }
          }
          return { rows: [] };
        }

        for (const key of [...getApplicationStatusStore(pool).keys()]) {
          if (key.startsWith(`${projectionKey}:`)) {
            getApplicationStatusStore(pool).delete(key);
          }
        }
        return { rows: [] };
      }

      if (sql.includes("UPDATE event_projection_blocked_streams")) {
        const projectionKey = String(params[0]);
        const streamId = params[1] ? String(params[1]) : null;
        const nextState = sql.includes("state = 'retrying'")
          ? "retrying"
          : sql.includes("state = 'blocked'")
            ? "blocked"
            : "resolved";
        for (const [key, stream] of getBlockedStreamStore(pool)) {
          if (stream.projectionKey === projectionKey && (!streamId || stream.streamId === streamId)) {
            getBlockedStreamStore(pool).set(key, { ...stream, state: nextState });
          }
        }
        return { rows: [] };
      }

      if (sql.includes("UPDATE event_projection_poison_events")) {
        if (!sql.includes("state = 'resolved'")) {
          return { rows: [] };
        }

        const projectionKey = String(params[0]);
        for (const key of [...getPoisonEventStore(pool)]) {
          if (key.startsWith(`${projectionKey}:`)) {
            getPoisonEventStore(pool).delete(key);
          }
        }
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO event_projection_poison_events")) {
        getPoisonEventStore(pool).add(`${String(params[0])}:${String(params[1])}`);
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO event_projection_blocked_streams")) {
        const projectionKey = String(params[0]);
        const streamId = String(params[1]);
        const key = `${projectionKey}:${streamId}`;
        const existing = getBlockedStreamStore(pool).get(key);
        getBlockedStreamStore(pool).set(key, {
          projectionKey,
          streamId,
          firstBlockedGlobalPosition: existing?.firstBlockedGlobalPosition ?? String(params[2]),
          firstBlockedStreamVersion: existing?.firstBlockedStreamVersion ?? Number(params[3]),
          lastSeenGlobalPosition: String(params[2]),
          deferredEventCount: existing ? existing.deferredEventCount + 1 : 0,
          state: "blocked",
        });
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
    connect: async () => ({
      ...pool,
      release: () => undefined,
    }),
  };

  return pool;
}

vi.mock("@chase-sets/event-core", () => ({
  ZERO_GLOBAL_POSITION: "0",
  isTransientProjectionError: () => false,
  toTransportEvent: (storedEvent: MockStoredEvent) => ({
    id: storedEvent.eventId,
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
  withPgTransaction: async (_pool: object, work: (client: object) => Promise<unknown>) => work(_pool),
  createPostgresEventStore: ({ pool }: { pool: object }) => ({
    readAll: async ({
      afterGlobalPosition,
      limit,
      eventTypes,
      streamPrefixes,
    }: {
      afterGlobalPosition: string;
      limit: number;
      eventTypes?: readonly string[];
      streamPrefixes?: readonly string[];
    }) => {
      getReadAllCalls(pool).push({
        afterGlobalPosition,
        limit,
        eventTypes: eventTypes ? [...eventTypes] : undefined,
        streamPrefixes: streamPrefixes ? [...streamPrefixes] : undefined,
      });

      return (sourceEventsByPool.get(pool) ?? [])
        .filter((event) => Number(event.globalPosition) > Number(afterGlobalPosition))
        .filter((event) => !eventTypes?.length || eventTypes.includes(event.eventType))
        .filter(
          (event) => !streamPrefixes?.length || streamPrefixes.some((prefix) => event.streamId.startsWith(prefix)),
        )
        .slice(0, limit);
    },
    readStream: async ({
      streamId,
      fromVersion = 1,
      limit = 500,
    }: {
      streamId: string;
      fromVersion?: number;
      limit?: number;
    }) =>
      (sourceEventsByPool.get(pool) ?? [])
        .filter((event) => event.streamId === streamId && event.streamVersion >= fromVersion)
        .slice(0, limit),
  }),
  createPostgresProjectionStore: ({ db }: { db: object }) => ({
    listBlockedStreams: async (projectionKey: string) =>
      [...getBlockedStreamStore(db).values()].filter(
        (stream) => stream.projectionKey === projectionKey && stream.state !== "resolved",
      ),
    listPoisonEvents: async () => [],
  }),
  eventCorePostgresSchemaSql: "",
}));

import {
  attachReadConsistencyMiddleware,
  createSubscriptionRunner,
  compactRuntimeSubscriptionLedgers,
  cleanupRuntimeProjectionGenerations,
  eventSubscriptionSchemaSql,
  listProjectionBlockedStreamDetails,
  refreshProjectionGroupStatuses,
  rebuildProjectionGroup,
  resetProjectionGroup,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  retryProjectionBlockedStream,
  summarizeRuntimeSubscriptionLedgers,
  summarizeProjectionReplayStatuses,
  syncContextProjectionGroups,
  waitForProjectionFreshness,
  ProjectionFreshnessTimeoutError,
} from "./index";

function createStoredEvent(
  globalPosition: string,
  eventType: string,
  payload: Record<string, unknown>,
  streamId = `${eventType}-${globalPosition}`,
): MockStoredEvent {
  return {
    eventId: `evt_${globalPosition}`,
    globalPosition,
    streamId,
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
  const module: Pick<BcApiModule, "contextName" | "projectionGroups"> = {
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
        projectionHandlerSets: [],
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
  const groupRuntime = createProjectionGroupRuntime(targetContextName, targetPool, projectionGroups, runners);

  return {
    mountedContexts: [
      {
        contextName: targetContextName,
        module: {
          contextName: targetContextName,
          projectionGroups,
        } as unknown as BcApiModule,
        services: {},
        pool: targetPool as never,
        projectionHandlerSets: [],
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
    checkpointWriteCountsByPool.clear();
    truncatedTablesByPool.clear();
    blockedStreamsByPool.clear();
    poisonEventsByPool.clear();
    applicationStatusByPool.clear();
    readAllCallsByPool.clear();
    sourceHeadByPool.clear();
    generationRetentionByPool.clear();
  });

  it("creates projection generation metadata for generation-aware rebuilds", () => {
    expect(eventSubscriptionSchemaSql).toContain("CREATE TABLE IF NOT EXISTS event_projection_group_generations");
    expect(eventSubscriptionSchemaSql).toContain("active_generation bigint NOT NULL DEFAULT 1");
    expect(eventSubscriptionSchemaSql).toContain("rebuilding_generation bigint NULL");
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
          reset: async () => undefined,
          requiredDuringBootstrap: true,
        } as BcProjectionGroupDeclaration,
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
          reset: async () => undefined,
          requiredDuringBootstrap: true,
        } as BcProjectionGroupDeclaration,
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
          reset: async () => undefined,
          requiredDuringBootstrap: true,
        } as BcProjectionGroupDeclaration,
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

  it("waits for matching projection runners to reach a write receipt", async () => {
    let lastGlobalPosition = "1";
    let refreshCount = 0;

    await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              refreshStatus: async () => {
                refreshCount += 1;
                if (refreshCount > 1) {
                  lastGlobalPosition = "5";
                }

                return {
                  lastGlobalPosition,
                  state: "behind",
                  lastError: null,
                };
              },
            },
          ],
        },
      ],
      targetContextNames: ["marketplace"],
      receipt: {
        observedAtMs: 1,
        sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
      },
      timeoutMs: 100,
      pollIntervalMs: 1,
    });

    expect(refreshCount).toBe(2);
  });

  it("fails closed when projections do not reach the receipt before timeout", async () => {
    await expect(
      waitForProjectionFreshness({
        projectionGroups: [
          {
            targetContextName: "marketplace",
            projectionName: "marketplace-listing-projection",
            subscriptionRunners: [
              {
                sourceContextName: "marketplace",
                refreshStatus: async () => ({
                  lastGlobalPosition: "1",
                  state: "behind",
                  lastError: null,
                }),
              },
            ],
          },
        ],
        targetContextNames: ["marketplace"],
        receipt: {
          observedAtMs: 1,
          sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
        },
        timeoutMs: 0,
        pollIntervalMs: 1,
      }),
    ).rejects.toBeInstanceOf(ProjectionFreshnessTimeoutError);
  });

  it("returns a projection freshness timeout response before serving stale API reads", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [{ contextName: "marketplace", mountPath: "/api/marketplace" }],
      [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              refreshStatus: async () => ({
                lastGlobalPosition: "1",
                state: "behind",
                lastError: null,
              }),
            },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(false);
    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          pending: [
            {
              targetContextName: "marketplace",
              projectionName: "marketplace-listing-projection",
              sourceContextName: "marketplace",
              requiredGlobalPosition: "5",
              lastGlobalPosition: "1",
            },
          ],
        },
      },
    });
  });

  it("uses the request target context to avoid waiting on unrelated projections mounted at the same path", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        { contextName: "marketplace", mountPath: "/api/marketplace" },
        { contextName: "pricing", mountPath: "/api/marketplace" },
      ],
      [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              refreshStatus: async () => ({
                lastGlobalPosition: "5",
                state: "caught-up",
                lastError: null,
              }),
            },
          ],
        },
        {
          targetContextName: "pricing",
          projectionName: "pricing-market-input-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              refreshStatus: async () => ({
                lastGlobalPosition: "1",
                state: "behind",
                lastError: null,
              }),
            },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    await middlewares[0](
      {
        req: {
          method: "GET",
          header: (name: string) => {
            if (name === CHASE_SETS_READ_AFTER_WRITE_HEADER) {
              return receipt;
            }

            return name === CHASE_SETS_READ_TARGET_CONTEXT_HEADER ? "marketplace" : undefined;
          },
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
  });

  it("uses route-declared dependencies to avoid waiting on unrelated projections in the same context", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });
    const refreshSession = vi.fn(async () => ({
      lastGlobalPosition: "5",
      state: "caught-up",
      lastError: null,
    }));
    const refreshCart = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: null,
    }));

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ readModelTable: "checkout_session_pages" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshSession }],
        },
        {
          targetContextName: "checkout",
          projectionName: "checkout.cart-projection",
          ownedTables: ["checkout_cart_line_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshCart }],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_1",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshCart).not.toHaveBeenCalled();
  });

  it("can fall back exact route dependencies to target-context waits through route tuning", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const auditRecords: unknown[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });
    const refreshSession = vi.fn(async () => ({
      lastGlobalPosition: "5",
      state: "caught-up",
      lastError: null,
    }));
    const refreshCart = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: null,
    }));

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ readModelTable: "checkout_session_pages" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshSession }],
        },
        {
          targetContextName: "checkout",
          projectionName: "checkout.cart-projection",
          ownedTables: ["checkout_cart_line_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshCart }],
        },
      ],
      {
        timeoutMs: 0,
        pollIntervalMs: 1,
        routeTuning: [
          {
            mountPath: "/api/marketplace",
            routePath: "/account/checkout-sessions/:sessionId",
            targetContextName: "checkout",
            exactDependencyMode: "target-context",
          },
        ],
        recordReadConsistencyAudit: (record) => auditRecords.push(record),
      },
    );

    let nextCalled = false;
    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_1",
          header: (name: string) => {
            if (name === CHASE_SETS_READ_AFTER_WRITE_HEADER) {
              return receipt;
            }
            return name === CHASE_SETS_READ_TARGET_CONTEXT_HEADER ? "checkout" : undefined;
          },
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(false);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshCart).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "target-context",
          dependencies: [],
          pending: [
            {
              targetContextName: "checkout",
              projectionName: "checkout.cart-projection",
              sourceContextName: "checkout",
            },
          ],
        },
      },
    });
    expect(auditRecords[0]).toMatchObject({
      outcome: "timeout",
      waitMode: "target-context",
      dependencies: [],
    });
  });

  it("uses route tuning timeout and poll interval without changing global defaults", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });
    const nowValues = [1_000, 1_000, 1_005, 1_010];
    const refreshSession = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: null,
    }));

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ projectionName: "checkout.session-projection" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshSession }],
        },
      ],
      {
        timeoutMs: 2_500,
        pollIntervalMs: 75,
        routeTuning: [
          {
            mountPath: "/api/marketplace",
            routePath: "/account/checkout-sessions/:sessionId",
            timeoutMs: 10,
            pollIntervalMs: 5,
          },
        ],
        nowMs: () => nowValues.shift() ?? 1_010,
      },
    );

    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_1",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => undefined,
    );

    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "exact-dependency",
        },
      },
    });
    expect(refreshSession.mock.calls.length).toBeGreaterThan(1);
    expect(refreshSession.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("keeps target-context fallback for read routes without declared dependencies", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ readModelTable: "checkout_session_pages" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [
            {
              sourceContextName: "checkout",
              refreshStatus: async () => ({
                lastGlobalPosition: "5",
                state: "caught-up",
                lastError: null,
              }),
            },
          ],
        },
        {
          targetContextName: "checkout",
          projectionName: "checkout.cart-projection",
          ownedTables: ["checkout_cart_line_pages"],
          subscriptionRunners: [
            {
              sourceContextName: "checkout",
              refreshStatus: async () => ({
                lastGlobalPosition: "1",
                state: "behind",
                lastError: null,
              }),
            },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/cart",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(false);
    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "target-context",
        },
      },
    });
  });

  it("waits only on exact dependency source pairs for multi-source receipts", async () => {
    const refreshSession = vi.fn(async () => ({
      lastGlobalPosition: "7",
      state: "caught-up",
      lastError: null,
    }));
    const refreshMarketInput = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: null,
    }));

    await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshSession }],
        },
        {
          targetContextName: "checkout",
          projectionName: "checkout.market-input-projection",
          ownedTables: ["checkout_market_input_pages"],
          subscriptionRunners: [{ sourceContextName: "marketplace", refreshStatus: refreshMarketInput }],
        },
      ],
      targetContextNames: ["checkout"],
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      receipt: {
        observedAtMs: 1,
        sources: [
          { sourceContextName: "checkout", maxGlobalPosition: "7", eventIds: ["evt_checkout"] },
          { sourceContextName: "marketplace", maxGlobalPosition: "9", eventIds: ["evt_marketplace"] },
        ],
      },
      timeoutMs: 0,
      pollIntervalMs: 1,
    });

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshMarketInput).not.toHaveBeenCalled();
  });

  it("honors read target context for multi-source receipts on shared mount routes", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const refreshCheckoutResource = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: "checkout should not be inspected",
    }));
    const refreshPaymentLocal = vi.fn(async () => ({
      lastGlobalPosition: "11",
      state: "caught-up",
      lastError: null,
    }));
    const refreshPaymentCheckoutInput = vi.fn(async () => ({
      lastGlobalPosition: "7",
      state: "caught-up",
      lastError: null,
    }));
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [
        { sourceContextName: "checkout", maxGlobalPosition: "7", eventIds: ["evt_checkout"] },
        { sourceContextName: "payments", maxGlobalPosition: "11", eventIds: ["evt_payment"] },
        { sourceContextName: "inventory", maxGlobalPosition: "99", eventIds: ["evt_inventory"] },
      ],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/shared/:id",
              dependencies: [{ projectionName: "checkout.shared-projection" }],
            },
          ],
        },
        {
          contextName: "payments",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/shared/:id",
              dependencies: [{ projectionName: "payments.shared-projection" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.shared-projection",
          ownedTables: ["checkout_shared_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshCheckoutResource }],
        },
        {
          targetContextName: "payments",
          projectionName: "payments.shared-projection",
          ownedTables: ["payments_shared_pages"],
          subscriptionRunners: [
            { sourceContextName: "payments", refreshStatus: refreshPaymentLocal },
            { sourceContextName: "checkout", refreshStatus: refreshPaymentCheckoutInput },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/shared/pay_1",
          header: (name: string) => {
            if (name === CHASE_SETS_READ_AFTER_WRITE_HEADER) {
              return receipt;
            }
            if (name === CHASE_SETS_READ_TARGET_CONTEXT_HEADER) {
              return "payments";
            }
            return undefined;
          },
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    expect(refreshPaymentLocal).toHaveBeenCalledTimes(1);
    expect(refreshPaymentCheckoutInput).toHaveBeenCalledTimes(1);
    expect(refreshCheckoutResource).not.toHaveBeenCalled();
  });

  it("reports only pending dependency source pairs for multi-source shared mount timeouts", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const refreshCheckoutResource = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: "checkout should not be inspected",
    }));
    const refreshPaymentLocal = vi.fn(async () => ({
      lastGlobalPosition: "11",
      state: "caught-up",
      lastError: null,
    }));
    const refreshPaymentCheckoutInput = vi.fn(async () => ({
      lastGlobalPosition: "3",
      state: "behind",
      lastError: "checkout input lagging",
    }));
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [
        { sourceContextName: "checkout", maxGlobalPosition: "7", eventIds: ["evt_checkout"] },
        { sourceContextName: "payments", maxGlobalPosition: "11", eventIds: ["evt_payment"] },
        { sourceContextName: "inventory", maxGlobalPosition: "99", eventIds: ["evt_inventory"] },
      ],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/shared/:id",
              dependencies: [{ projectionName: "checkout.shared-projection" }],
            },
          ],
        },
        {
          contextName: "payments",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/shared/:id",
              dependencies: [{ projectionName: "payments.shared-projection" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.shared-projection",
          ownedTables: ["checkout_shared_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshCheckoutResource }],
        },
        {
          targetContextName: "payments",
          projectionName: "payments.shared-projection",
          ownedTables: ["payments_shared_pages"],
          subscriptionRunners: [
            { sourceContextName: "payments", refreshStatus: refreshPaymentLocal },
            { sourceContextName: "checkout", refreshStatus: refreshPaymentCheckoutInput },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/shared/pay_1",
          header: (name: string) => {
            if (name === CHASE_SETS_READ_AFTER_WRITE_HEADER) {
              return receipt;
            }
            if (name === CHASE_SETS_READ_TARGET_CONTEXT_HEADER) {
              return "payments";
            }
            return undefined;
          },
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(false);
    expect(refreshPaymentLocal).toHaveBeenCalledTimes(1);
    expect(refreshPaymentCheckoutInput).toHaveBeenCalledTimes(1);
    expect(refreshCheckoutResource).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "exact-dependency",
          dependencies: [{ targetContextName: "payments", projectionName: "payments.shared-projection" }],
          pending: [
            {
              targetContextName: "payments",
              projectionName: "payments.shared-projection",
              sourceContextName: "checkout",
              requiredGlobalPosition: "7",
              lastGlobalPosition: "3",
              lastError: "checkout input lagging",
            },
          ],
        },
      },
    });
  });

  it("returns exact Checkout session dependency diagnostics in projection freshness timeout responses", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ readModelTable: "checkout_session_pages" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [
            {
              sourceContextName: "checkout",
              refreshStatus: async () => ({
                lastGlobalPosition: "1",
                state: "behind",
                lastError: "worker lagging",
              }),
            },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_1",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => undefined,
    );

    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "exact-dependency",
          dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
          pending: [
            {
              targetContextName: "checkout",
              projectionName: "checkout.session-projection",
              sourceContextName: "checkout",
              requiredGlobalPosition: "5",
              lastGlobalPosition: "1",
              lastError: "worker lagging",
            },
          ],
        },
      },
    });
  });

  it("audits matched freshness routes that arrive without a read-after-write receipt", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const auditRecords: unknown[] = [];

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ readModelTable: "checkout_session_pages" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [
            {
              sourceContextName: "checkout",
              refreshStatus: async () => ({
                lastGlobalPosition: "1",
                state: "caught-up",
                lastError: null,
              }),
            },
          ],
        },
      ],
      {
        recordReadConsistencyAudit: (record) => auditRecords.push(record),
        nowMs: () => 100,
      },
    );

    let nextCalled = false;
    await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_secret_session",
          header: () => undefined,
        },
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      type: "read-after-write.freshness",
      outcome: "missing-receipt",
      method: "GET",
      mountPath: "/api/marketplace",
      routePaths: ["/account/checkout-sessions/:sessionId"],
      readAfterWriteHeaderPresent: false,
      readTargetContextHeaderPresent: false,
      readTargetContextHeaderValid: false,
      requestedTargetContextName: null,
      targetContextNames: ["checkout"],
      waitMode: "exact-dependency",
      receiptSourceContextNames: [],
      receiptSourceCount: 0,
      receiptEventCount: 0,
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      pending: [],
    });
    expect(JSON.stringify(auditRecords)).not.toContain("chk_secret_session");
  });

  it("audits successful exact dependency waits without logging raw token, path ids, or event ids", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const auditRecords: unknown[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_secret_checkout"] }],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ projectionName: "checkout.session-projection" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [
            {
              sourceContextName: "checkout",
              refreshStatus: async () => ({
                lastGlobalPosition: "5",
                state: "caught-up",
                lastError: null,
              }),
            },
          ],
        },
      ],
      {
        recordReadConsistencyAudit: (record) => auditRecords.push(record),
        nowMs: () => 250,
      },
    );

    await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_secret_session",
          header: (name: string) => {
            if (name === CHASE_SETS_READ_AFTER_WRITE_HEADER) {
              return receipt;
            }
            return name === CHASE_SETS_READ_TARGET_CONTEXT_HEADER ? "checkout" : undefined;
          },
        },
      },
      async () => undefined,
    );

    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      type: "read-after-write.freshness",
      outcome: "fresh",
      routePaths: ["/account/checkout-sessions/:sessionId"],
      readAfterWriteHeaderPresent: true,
      readTargetContextHeaderPresent: true,
      readTargetContextHeaderValid: true,
      requestedTargetContextName: "checkout",
      targetContextNames: ["checkout"],
      waitMode: "exact-dependency",
      receiptSourceContextNames: ["checkout"],
      receiptSourceCount: 1,
      receiptEventCount: 1,
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      pending: [],
    });
    const serializedAudit = JSON.stringify(auditRecords);
    expect(serializedAudit).not.toContain(receipt);
    expect(serializedAudit).not.toContain("chk_secret_session");
    expect(serializedAudit).not.toContain("evt_secret_checkout");
    expect(serializedAudit).not.toContain("todd.skelton@outlook.com");
  });

  it("audits projection freshness timeouts with pending lag diagnostics", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const auditRecords: unknown[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_secret_checkout"] }],
    });
    const nowValues = [1_000, 1_175];

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ projectionName: "checkout.session-projection" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [
            {
              sourceContextName: "checkout",
              refreshStatus: async () => ({
                lastGlobalPosition: "1",
                state: "behind",
                lastError: "worker lagging",
              }),
            },
          ],
        },
      ],
      {
        timeoutMs: 0,
        pollIntervalMs: 1,
        recordReadConsistencyAudit: (record) => auditRecords.push(record),
        nowMs: () => nowValues.shift() ?? 1_175,
      },
    );

    await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_secret_session",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => undefined,
    );

    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      type: "read-after-write.freshness",
      outcome: "timeout",
      routePaths: ["/account/checkout-sessions/:sessionId"],
      readAfterWriteHeaderPresent: true,
      readTargetContextHeaderPresent: false,
      readTargetContextHeaderValid: false,
      targetContextNames: ["checkout"],
      waitMode: "exact-dependency",
      durationMs: 175,
      receiptSourceContextNames: ["checkout"],
      receiptSourceCount: 1,
      receiptEventCount: 1,
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      pending: [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          sourceContextName: "checkout",
          requiredGlobalPosition: "5",
          lastGlobalPosition: "1",
          globalPositionLag: "4",
          state: "behind",
          lastError: "present",
        },
      ],
    });
    const serializedAudit = JSON.stringify(auditRecords);
    expect(serializedAudit).not.toContain(receipt);
    expect(serializedAudit).not.toContain("chk_secret_session");
    expect(serializedAudit).not.toContain("evt_secret_checkout");
    expect(serializedAudit).not.toContain("worker lagging");
  });
});
