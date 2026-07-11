import { describe, expect, it, vi } from "vitest";
import type { AggregateRepository, DomainEvent } from "@chase-sets/event-core";
import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import type { AppendToStreamsIndependentResult, EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { createBulkAppendLane, type BulkAppendLaneConfig, type BulkAppendLaneItem } from "./bulk-append-lane";

type WidgetState = Readonly<{ value: number | null }>;

type SetWidgetValueCommand = Readonly<{ type: "SetValue"; value: number }>;
type ExplodeCommand = Readonly<{ type: "Explode" }>;
type WidgetCommand = SetWidgetValueCommand | ExplodeCommand;

type WidgetValueSetEvent = DomainEvent<"widget.value-set", Readonly<{ value: number }>>;
type WidgetEvent = WidgetValueSetEvent;

const codec: DomainEventCodec<WidgetEvent> = {
  encode: (event) => ({ eventType: event.type, payload: event.data }),
  decode: (storedEvent) => ({ type: storedEvent.eventType, data: storedEvent.payload }) as WidgetEvent,
};

function evolve(state: WidgetState, event: WidgetEvent): WidgetState {
  if (event.type === "widget.value-set") {
    return { value: event.data.value };
  }
  return state;
}

function decide(state: WidgetState, command: WidgetCommand): readonly WidgetEvent[] {
  if (command.type === "Explode") {
    throw new Error("Widget refuses to explode-set.");
  }
  if (state.value === command.value) {
    return [];
  }
  return [{ type: "widget.value-set", data: { value: command.value } }];
}

function context(): EventStoreContext {
  return {
    tenantId: "tenant_1" as never,
    audit: { performedByUserId: "user_1" as never, forAccountId: "account_1" as never },
  };
}

function createFakeRepository(
  initial: Readonly<Record<string, number | null>>,
): AggregateRepository<WidgetState, WidgetEvent> {
  return {
    load: async (streamId) => {
      const value = Object.prototype.hasOwnProperty.call(initial, streamId) ? initial[streamId]! : null;
      return {
        state: { value },
        version: value === null ? 0 : 1,
        events: [],
        storedEvents: [],
      };
    },
    append: async () => {
      throw new Error("The bulk append lane must never call repository.append directly.");
    },
  };
}

function fakeStoredEvent(streamId: string, streamVersion: number, event: WidgetEvent): StoredEvent {
  return {
    eventId: `evt_${streamId}_${streamVersion}` as never,
    streamId,
    streamVersion,
    globalPosition: String(streamVersion) as never,
    tenantId: "tenant_1" as never,
    eventType: event.type,
    payload: event.data,
    metadata: {},
    occurredAt: "2026-07-09T00:00:00.000Z" as never,
    recordedAt: "2026-07-09T00:00:00.000Z" as never,
    performedByUserId: "user_1" as never,
    forAccountId: "account_1" as never,
  };
}

type FakeEventStoreOptions = Readonly<{
  initialVersions?: Readonly<Record<string, number>>;
}>;

function createFakeIndependentEventStore(options: FakeEventStoreOptions = {}) {
  const versions = new Map<string, number>(Object.entries(options.initialVersions ?? {}));
  const calls: { chunkSizes: number[] } = { chunkSizes: [] };

  const eventStore: EventStore = {
    appendToStream: async () => {
      throw new Error("not used in this test");
    },
    appendToStreamsIndependently: async (inputs) => {
      calls.chunkSizes.push(inputs.length);
      const results: AppendToStreamsIndependentResult[] = [];

      for (const input of inputs) {
        if (input.events.length === 0) {
          results.push({ streamId: input.streamId, outcome: "no_op", storedEvents: [] });
          continue;
        }

        const currentVersion = versions.get(input.streamId) ?? 0;
        if (input.expectedVersion !== "any" && input.expectedVersion !== currentVersion) {
          results.push({
            streamId: input.streamId,
            outcome: "conflict",
            storedEvents: [],
            error: Object.assign(new Error("Expected stream version does not match current version."), {
              code: "concurrency_conflict",
            }) as never,
          });
          continue;
        }

        const storedEvents = input.events.map((event, index) =>
          fakeStoredEvent(input.streamId, currentVersion + index + 1, {
            type: event.eventType,
            data: event.payload,
          } as WidgetEvent),
        );
        versions.set(input.streamId, currentVersion + input.events.length);
        results.push({ streamId: input.streamId, outcome: "appended", storedEvents });
      }

      return results;
    },
    readStream: async () => [],
    readAll: async () => [],
  };

  return { eventStore, calls, versions };
}

function baseConfig(
  eventStore: EventStore,
  repository: AggregateRepository<WidgetState, WidgetEvent>,
  overrides: Partial<BulkAppendLaneConfig<WidgetState, WidgetCommand, WidgetEvent>> = {},
): BulkAppendLaneConfig<WidgetState, WidgetCommand, WidgetEvent> {
  return {
    eventStore,
    repository,
    codec,
    evolve,
    decide,
    chunkSize: 2,
    yieldIntervalMs: 5,
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

function items(
  count: number,
  valueFor: (index: number) => number = (index) => index + 1,
): BulkAppendLaneItem<WidgetCommand>[] {
  return Array.from({ length: count }, (_, index) => ({
    streamId: `widget-${index + 1}`,
    command: { type: "SetValue", value: valueFor(index) },
    context: context(),
  }));
}

describe("createBulkAppendLane", () => {
  it("chunks appends to the configured size and preserves item order in the output", async () => {
    const { eventStore, calls } = createFakeIndependentEventStore();
    const repository = createFakeRepository({});
    const lane = createBulkAppendLane(baseConfig(eventStore, repository, { chunkSize: 2 }));

    const outcomes = await lane(items(5));

    expect(calls.chunkSizes).toEqual([2, 2, 1]);
    expect(outcomes.map((outcome) => outcome.streamId)).toEqual([
      "widget-1",
      "widget-2",
      "widget-3",
      "widget-4",
      "widget-5",
    ]);
    expect(outcomes.every((outcome) => outcome.outcome === "applied")).toBe(true);
    expect(outcomes.map((outcome) => outcome.version)).toEqual([1, 1, 1, 1, 1]);
  });

  it("yields between chunks but not after the final chunk", async () => {
    const { eventStore } = createFakeIndependentEventStore();
    const repository = createFakeRepository({});
    const sleep = vi.fn(async () => undefined);
    const lane = createBulkAppendLane(baseConfig(eventStore, repository, { chunkSize: 2, yieldIntervalMs: 25, sleep }));

    await lane(items(5));

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("suppresses no-op commands without appending or failing the chunk", async () => {
    const { eventStore, calls } = createFakeIndependentEventStore();
    const repository = createFakeRepository({ "widget-2": 7 });
    const lane = createBulkAppendLane(baseConfig(eventStore, repository, { chunkSize: 3 }));

    const outcomes = await lane([
      { streamId: "widget-1", command: { type: "SetValue", value: 1 }, context: context() },
      { streamId: "widget-2", command: { type: "SetValue", value: 7 }, context: context() },
      { streamId: "widget-3", command: { type: "SetValue", value: 3 }, context: context() },
    ]);

    expect(outcomes.find((outcome) => outcome.streamId === "widget-2")).toMatchObject({
      outcome: "no_op",
      newEvents: [],
      storedEvents: [],
    });
    // The append call only carries the two streams that actually changed.
    expect(calls.chunkSizes).toEqual([2]);
  });

  it("isolates a per-listing version conflict to that stream only", async () => {
    const { eventStore } = createFakeIndependentEventStore({ initialVersions: { "widget-2": 5 } });
    const repository = createFakeRepository({ "widget-1": null, "widget-2": null, "widget-3": null });
    const lane = createBulkAppendLane(baseConfig(eventStore, repository, { chunkSize: 3 }));

    const outcomes = await lane(items(3));

    expect(outcomes).toMatchObject([
      { streamId: "widget-1", outcome: "applied" },
      { streamId: "widget-2", outcome: "conflict" },
      { streamId: "widget-3", outcome: "applied" },
    ]);
  });

  it("isolates a decide-time domain error (e.g. withdrawn listing) to that stream only", async () => {
    const { eventStore } = createFakeIndependentEventStore();
    const repository = createFakeRepository({});
    const lane = createBulkAppendLane(baseConfig(eventStore, repository, { chunkSize: 3 }));

    const outcomes = await lane([
      { streamId: "widget-1", command: { type: "SetValue", value: 1 }, context: context() },
      { streamId: "widget-2", command: { type: "Explode" }, context: context() },
      { streamId: "widget-3", command: { type: "SetValue", value: 3 }, context: context() },
    ]);

    expect(outcomes[0]).toMatchObject({ streamId: "widget-1", outcome: "applied" });
    expect(outcomes[1]).toMatchObject({ streamId: "widget-2", outcome: "error" });
    expect(outcomes[1]?.error).toBeInstanceOf(Error);
    expect(outcomes[2]).toMatchObject({ streamId: "widget-3", outcome: "applied" });
  });

  it("rejects a non-positive chunk size", () => {
    const { eventStore } = createFakeIndependentEventStore();
    const repository = createFakeRepository({});

    expect(() => createBulkAppendLane(baseConfig(eventStore, repository, { chunkSize: 0 }))).toThrow(
      "chunk size must be a positive integer",
    );
  });

  it("rejects a negative yield interval", () => {
    const { eventStore } = createFakeIndependentEventStore();
    const repository = createFakeRepository({});

    expect(() => createBulkAppendLane(baseConfig(eventStore, repository, { yieldIntervalMs: -1 }))).toThrow(
      "yield interval must be zero or a positive number",
    );
  });

  it("requires an event store that supports appendToStreamsIndependently", () => {
    const repository = createFakeRepository({});
    const eventStore: EventStore = {
      appendToStream: async () => [],
      readStream: async () => [],
      readAll: async () => [],
    };

    expect(() => createBulkAppendLane(baseConfig(eventStore, repository))).toThrow(
      "requires an event store that supports appendToStreamsIndependently",
    );
  });

  it("returns an empty result for an empty batch without opening any chunk", async () => {
    const { eventStore, calls } = createFakeIndependentEventStore();
    const repository = createFakeRepository({});
    const lane = createBulkAppendLane(baseConfig(eventStore, repository));

    await expect(lane([])).resolves.toEqual([]);
    expect(calls.chunkSizes).toEqual([]);
  });
});
