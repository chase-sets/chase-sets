import { describe, expect, it } from "vitest";
import { createId } from "../primitives/typed-ids";
import { createProjector, createTransientProjectionError, type ProjectionCheckpointStore } from "./projector";
import type { EventStore } from "./event-store";
import { ZERO_GLOBAL_POSITION, type GlobalPosition, type StoredEvent } from "./storage";

describe("projector stream-isolated errors", () => {
  it("checkpoints irrelevant events without invoking handlers", async () => {
    const checkpointStore = createInMemoryCheckpointStore();
    const projector = createProjector({
      projectorName: "catalog-item-projection",
      eventStore: createInMemoryEventStore([
        createStoredEvent("1", "catalog.source-observation.promoted", "catalog.source-observation-1"),
      ]),
      checkpointStore,
      handlers: {},
    });

    await expect(projector.runOnce()).resolves.toMatchObject({
      processed: 1,
      lastGlobalPosition: "1",
      state: "running",
    });
    expect(checkpointStore.checkpoints.get("catalog-item-projection")).toBe("1");
  });

  it("blocks a poisoned stream and continues unrelated streams", async () => {
    const checkpointStore = createInMemoryCheckpointStore();
    const seen: string[] = [];
    const projector = createProjector({
      projectorName: "catalog-item-projection",
      eventStore: createInMemoryEventStore([
        createStoredEvent("1", "catalog.catalog-item.published", "catalog.item-bad"),
        createStoredEvent("2", "catalog.catalog-item.published", "catalog.item-good"),
        createStoredEvent("3", "catalog.catalog-item.published", "catalog.item-bad", 2),
      ]),
      checkpointStore,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          if (event.streamId === "catalog.item-bad") {
            throw new Error("bad item payload");
          }

          seen.push(`${event.streamId}:${event.globalPosition}`);
        },
      },
    });

    await expect(projector.runOnce()).resolves.toMatchObject({
      processed: 3,
      lastGlobalPosition: "3",
      state: "degraded",
      blockedStreams: 1,
      poisonEvents: 1,
    });

    expect(seen).toEqual(["catalog.item-good:2"]);
    expect(checkpointStore.checkpoints.get("catalog-item-projection")).toBe("3");
    expect(checkpointStore.blockedStreams.get("catalog-item-projection:catalog.item-bad")).toMatchObject({
      deferredEventCount: 1,
      firstBlockedGlobalPosition: "1",
      lastSeenGlobalPosition: "3",
    });
  });

  it("pushes handler event types into legacy projector reads", async () => {
    const checkpointStore = createInMemoryCheckpointStore();
    const eventStore = createInMemoryEventStore([
      createStoredEvent("1", "catalog.source-observation.promoted", "catalog.source-observation-1"),
      createStoredEvent("2", "catalog.catalog-item.published", "catalog.item-1"),
    ]);
    const seen: string[] = [];
    const projector = createProjector({
      projectorName: "catalog-item-projection",
      eventStore,
      checkpointStore,
      handlers: {
        "catalog.catalog-item.published": async (event) => {
          seen.push(event.globalPosition);
        },
      },
    });

    await projector.runOnce();

    expect(eventStore.readAllCalls[0]).toMatchObject({
      eventTypes: ["catalog.catalog-item.published"],
    });
    expect(seen).toEqual(["2"]);
    expect(checkpointStore.checkpoints.get("catalog-item-projection")).toBe("2");
  });

  it("batches legacy projector checkpoints", async () => {
    const checkpointStore = createInMemoryCheckpointStore();
    const projector = createProjector({
      projectorName: "catalog-item-projection",
      eventStore: createInMemoryEventStore([
        createStoredEvent("1", "catalog.catalog-item.published", "catalog.item-1"),
        createStoredEvent("2", "catalog.catalog-item.published", "catalog.item-2"),
        createStoredEvent("3", "catalog.catalog-item.published", "catalog.item-3"),
      ]),
      checkpointStore,
      handlers: {
        "catalog.catalog-item.published": async () => undefined,
      },
      checkpointBatchSize: 2,
    });

    await projector.runOnce();

    expect(checkpointStore.checkpoints.get("catalog-item-projection")).toBe("3");
    expect(checkpointStore.checkpointWrites).toEqual(["2", "3"]);
  });

  it("does not checkpoint transient projection errors", async () => {
    const checkpointStore = createInMemoryCheckpointStore();
    const projector = createProjector({
      projectorName: "catalog-item-projection",
      eventStore: createInMemoryEventStore([
        createStoredEvent("1", "catalog.catalog-item.published", "catalog.item-1"),
      ]),
      checkpointStore,
      handlers: {
        "catalog.catalog-item.published": async () => {
          throw createTransientProjectionError("database unavailable");
        },
      },
    });

    await expect(projector.runOnce()).rejects.toThrow("database unavailable");
    expect(checkpointStore.checkpoints.get("catalog-item-projection")).toBeUndefined();
  });
});

function createInMemoryEventStore(events: readonly StoredEvent[]): EventStore & {
  readAllCalls: Array<Readonly<{ eventTypes?: readonly string[]; streamPrefixes?: readonly string[] }>>;
} {
  const readAllCalls: Array<Readonly<{ eventTypes?: readonly string[]; streamPrefixes?: readonly string[] }>> = [];
  return {
    readAllCalls,
    appendToStream: async () => [],
    readStream: async ({ streamId, fromVersion = 1, limit = 500 }) =>
      events.filter((event) => event.streamId === streamId && event.streamVersion >= fromVersion).slice(0, limit),
    readAll: async ({ afterGlobalPosition = ZERO_GLOBAL_POSITION, limit = 500, eventTypes, streamPrefixes } = {}) => {
      readAllCalls.push({ eventTypes, streamPrefixes });
      return events
        .filter((event) => Number(event.globalPosition) > Number(afterGlobalPosition))
        .filter((event) => !eventTypes?.length || eventTypes.includes(event.eventType))
        .filter(
          (event) => !streamPrefixes?.length || streamPrefixes.some((prefix) => event.streamId.startsWith(prefix)),
        )
        .slice(0, limit);
    },
  };
}

function createInMemoryCheckpointStore(): ProjectionCheckpointStore & {
  checkpoints: Map<string, GlobalPosition>;
  blockedStreams: Map<
    string,
    {
      firstBlockedGlobalPosition: GlobalPosition;
      firstBlockedStreamVersion: number;
      lastSeenGlobalPosition: GlobalPosition;
      deferredEventCount: number;
      state: "blocked";
    }
  >;
  poisonEvents: Set<string>;
  checkpointWrites: GlobalPosition[];
} {
  const checkpoints = new Map<string, GlobalPosition>();
  const blockedStreams = new Map<
    string,
    {
      firstBlockedGlobalPosition: GlobalPosition;
      firstBlockedStreamVersion: number;
      lastSeenGlobalPosition: GlobalPosition;
      deferredEventCount: number;
      state: "blocked";
    }
  >();
  const poisonEvents = new Set<string>();
  const checkpointWrites: GlobalPosition[] = [];

  return {
    checkpoints,
    blockedStreams,
    poisonEvents,
    checkpointWrites,
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, globalPosition) => {
      checkpoints.set(projectorName, globalPosition);
      checkpointWrites.push(globalPosition);
    },
    loadBlockedStream: async (projectionKey, streamId) => {
      const stream = blockedStreams.get(`${projectionKey}:${streamId}`);
      return stream
        ? {
            projectionKey,
            streamId,
            ...stream,
          }
        : null;
    },
    recordPoisonEvent: async (input) => {
      poisonEvents.add(`${input.projectionKey}:${input.eventId}`);
      blockedStreams.set(`${input.projectionKey}:${input.streamId}`, {
        firstBlockedGlobalPosition: input.globalPosition,
        firstBlockedStreamVersion: input.streamVersion,
        lastSeenGlobalPosition: input.globalPosition,
        deferredEventCount: 0,
        state: "blocked",
      });
    },
    recordDeferredBlockedStreamEvent: async (input) => {
      const key = `${input.projectionKey}:${input.streamId}`;
      const existing = blockedStreams.get(key);
      blockedStreams.set(key, {
        firstBlockedGlobalPosition: existing?.firstBlockedGlobalPosition ?? input.globalPosition,
        firstBlockedStreamVersion: existing?.firstBlockedStreamVersion ?? input.streamVersion,
        lastSeenGlobalPosition: input.globalPosition,
        deferredEventCount: (existing?.deferredEventCount ?? 0) + 1,
        state: "blocked",
      });
    },
    loadProjectionErrorSummary: async (projectionKey) => ({
      blockedStreamCount: [...blockedStreams.keys()].filter((key) => key.startsWith(`${projectionKey}:`)).length,
      poisonEventCount: [...poisonEvents].filter((key) => key.startsWith(`${projectionKey}:`)).length,
    }),
  };
}

function createStoredEvent(
  globalPosition: string,
  eventType: string,
  streamId: string,
  streamVersion = 1,
): StoredEvent {
  return {
    eventId: createId("evt"),
    streamId,
    streamVersion,
    globalPosition: globalPosition as GlobalPosition,
    tenantId: "tnt_test" as never,
    eventType,
    payload: {},
    metadata: {},
    occurredAt: "2026-05-24T00:00:00.000Z" as never,
    recordedAt: "2026-05-24T00:00:00.000Z" as never,
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  };
}
