import { describe, expect, it, vi } from "vitest";
import { createAggregateRepository } from "./aggregate-repository-internal";
import type { AggregateSnapshotStore, StoredAggregateSnapshot } from "./aggregate-snapshot-store";
import { createPassthroughDomainEventCodec } from "./codec";
import { createAggregateCommandHandler } from "./aggregate-command-handler";
import type { EventStore } from "./event-store";
import type { DomainEvent } from "./domain";
import type { StoredEvent } from "./storage";

type CounterEvent = DomainEvent<"counter.incremented", { by: number }>;
type CounterCommand = Readonly<{ type: "Increment"; by: number }>;

const SCHEMA_VERSION = 1;

const context = {
  tenantId: "tnt_1" as never,
  audit: {
    performedByUserId: "usr_1" as never,
    forAccountId: "acc_1" as never,
  },
};

function buildStoredEvents(
  streamId: string,
  byPerEvent: readonly number[],
): StoredEvent<"counter.incremented", { by: number }>[] {
  return byPerEvent.map((by, index) => ({
    eventId: `evt_${index + 1}` as never,
    streamId,
    streamVersion: index + 1,
    globalPosition: String(index + 1) as never,
    tenantId: "tnt_1" as never,
    eventType: "counter.incremented",
    payload: { by },
    metadata: {},
    occurredAt: "2026-07-10T00:00:00.000Z" as never,
    recordedAt: "2026-07-10T00:00:00.000Z" as never,
    performedByUserId: "usr_1" as never,
    forAccountId: "acc_1" as never,
  }));
}

function createFakeEventStore(storedEvents: readonly StoredEvent<"counter.incremented", { by: number }>[]): EventStore {
  return {
    readStream: vi.fn(async (input) =>
      storedEvents.filter((event) => event.streamVersion >= (input.fromVersion ?? 1)).slice(0, input.limit ?? 500),
    ),
    appendToStream: vi.fn(async () => []),
    readAll: vi.fn(async () => []),
  };
}

function createInMemorySnapshotStore<State>(): AggregateSnapshotStore<State> & {
  snapshotsByStreamId: Map<string, StoredAggregateSnapshot<State>>;
} {
  const snapshotsByStreamId = new Map<string, StoredAggregateSnapshot<State>>();
  return {
    snapshotsByStreamId,
    loadLatest: async (streamId) => snapshotsByStreamId.get(streamId) ?? null,
    save: async (snapshot) => {
      snapshotsByStreamId.set(snapshot.streamId, {
        ...snapshot,
        updatedAt: "2026-07-10T00:00:00.000Z" as never,
      });
    },
  };
}

// Deterministic PRNG so property trials are reproducible across runs.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const evolve = (state: number, event: CounterEvent) => state + event.data.by;

describe("aggregate repository snapshots (m113)", () => {
  it("produces load() state identical to full replay across random event sequences and snapshot cut points", async () => {
    const random = mulberry32(42);
    const streamId = "counter-property";

    for (let trial = 0; trial < 60; trial += 1) {
      const eventCount = Math.floor(random() * 220);
      const byPerEvent = Array.from({ length: eventCount }, () => Math.floor(random() * 9) - 4);
      const storedEvents = buildStoredEvents(streamId, byPerEvent);
      const referenceState = byPerEvent.reduce((state, by) => state + by, 0);
      const referenceVersion = eventCount;

      // No-snapshot repository: ground truth via full replay.
      const baselineRepository = createAggregateRepository<number, CounterEvent>({
        eventStore: createFakeEventStore(storedEvents),
        codec: createPassthroughDomainEventCodec<CounterEvent>(),
        initialState: () => 0,
        evolve,
      });
      const baseline = await baselineRepository.load(streamId);
      expect(baseline.state).toBe(referenceState);
      expect(baseline.version).toBe(referenceVersion);

      // Snapshot-assisted repository: pre-seed a snapshot at a random cut
      // point (including "no snapshot" via cutVersion 0) and confirm load()
      // still lands on exactly the same state/version as full replay.
      const cutVersion = eventCount === 0 ? 0 : Math.floor(random() * (eventCount + 1));
      const snapshotStore = createInMemorySnapshotStore<number>();
      if (cutVersion > 0) {
        const stateAtCut = byPerEvent.slice(0, cutVersion).reduce((state, by) => state + by, 0);
        await snapshotStore.save({
          streamId,
          streamVersion: cutVersion,
          schemaVersion: SCHEMA_VERSION,
          state: stateAtCut,
        });
      }

      const snapshotRepository = createAggregateRepository<number, CounterEvent>({
        eventStore: createFakeEventStore(storedEvents),
        codec: createPassthroughDomainEventCodec<CounterEvent>(),
        initialState: () => 0,
        evolve,
        snapshots: {
          store: snapshotStore,
          schemaVersion: SCHEMA_VERSION,
          everyNEvents: 1,
        },
      });
      const snapshotAssisted = await snapshotRepository.load(streamId);

      expect(snapshotAssisted.state).toBe(referenceState);
      expect(snapshotAssisted.version).toBe(referenceVersion);
      expect(snapshotAssisted.events).toHaveLength(eventCount - cutVersion);
    }
  });

  it("only reads events after the snapshot's stream version", async () => {
    const streamId = "counter-tail-read";
    const storedEvents = buildStoredEvents(streamId, [1, 2, 3, 4, 5]);
    const snapshotStore = createInMemorySnapshotStore<number>();
    await snapshotStore.save({ streamId, streamVersion: 3, schemaVersion: SCHEMA_VERSION, state: 6 });
    const eventStore = createFakeEventStore(storedEvents);

    const repository = createAggregateRepository<number, CounterEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve,
      snapshots: { store: snapshotStore, schemaVersion: SCHEMA_VERSION, everyNEvents: 1 },
    });

    await expect(repository.load(streamId)).resolves.toMatchObject({ state: 15, version: 5 });
    expect(eventStore.readStream).toHaveBeenCalledWith({ streamId, fromVersion: 4, limit: 500 });
  });

  it("falls back to full replay when the stored snapshot's schemaVersion does not match", async () => {
    const streamId = "counter-schema-mismatch";
    const storedEvents = buildStoredEvents(streamId, [1, 2, 3]);
    const snapshotStore = createInMemorySnapshotStore<number>();
    await snapshotStore.save({ streamId, streamVersion: 2, schemaVersion: 99, state: -1000 });
    const eventStore = createFakeEventStore(storedEvents);

    const repository = createAggregateRepository<number, CounterEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve,
      snapshots: { store: snapshotStore, schemaVersion: SCHEMA_VERSION, everyNEvents: 1 },
    });

    await expect(repository.load(streamId)).resolves.toMatchObject({ state: 6, version: 3 });
    expect(eventStore.readStream).toHaveBeenNthCalledWith(1, { streamId, fromVersion: 1, limit: 500 });
  });

  it("falls back to full replay cleanly when the snapshot store read throws", async () => {
    const streamId = "counter-corrupt-read";
    const storedEvents = buildStoredEvents(streamId, [1, 2, 3]);
    const eventStore = createFakeEventStore(storedEvents);
    const brokenSnapshotStore: AggregateSnapshotStore<number> = {
      loadLatest: async () => {
        throw new Error("snapshot row is corrupt");
      },
      save: async () => undefined,
    };

    const repository = createAggregateRepository<number, CounterEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve,
      snapshots: { store: brokenSnapshotStore, schemaVersion: SCHEMA_VERSION, everyNEvents: 1 },
    });

    await expect(repository.load(streamId)).resolves.toMatchObject({ state: 6, version: 3 });
  });

  it("falls back to full replay cleanly when no snapshot has ever been written", async () => {
    const streamId = "counter-missing-snapshot";
    const storedEvents = buildStoredEvents(streamId, [1, 2, 3]);
    const eventStore = createFakeEventStore(storedEvents);
    const snapshotStore = createInMemorySnapshotStore<number>();

    const repository = createAggregateRepository<number, CounterEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve,
      snapshots: { store: snapshotStore, schemaVersion: SCHEMA_VERSION, everyNEvents: 1 },
    });

    await expect(repository.load(streamId)).resolves.toMatchObject({ state: 6, version: 3 });
    expect(eventStore.readStream).toHaveBeenNthCalledWith(1, { streamId, fromVersion: 1, limit: 500 });
  });

  it("schedules a write-behind save only when the command crosses the snapshot threshold", async () => {
    const streamId = "counter-threshold";
    const snapshotStore = createInMemorySnapshotStore<number>();
    const saveSpy = vi.spyOn(snapshotStore, "save");
    const eventStore = createFakeEventStore([]);

    const repository = createAggregateRepository<number, CounterEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve,
      snapshots: { store: snapshotStore, schemaVersion: SCHEMA_VERSION, everyNEvents: 3 },
    });

    repository.scheduleSnapshot?.({ streamId, priorVersion: 0, version: 2, state: 2 });
    expect(saveSpy).not.toHaveBeenCalled();

    repository.scheduleSnapshot?.({ streamId, priorVersion: 2, version: 3, state: 3 });
    await Promise.resolve();
    await Promise.resolve();
    expect(saveSpy).toHaveBeenCalledWith({ streamId, streamVersion: 3, schemaVersion: SCHEMA_VERSION, state: 3 });

    repository.scheduleSnapshot?.({ streamId, priorVersion: 3, version: 5, state: 5 });
    expect(saveSpy).toHaveBeenCalledTimes(1);

    // A multi-event append that crosses the threshold within one command
    // (e.g. version jumps 5 -> 7 across a 3-event append) still schedules
    // exactly one save at the post-command version.
    repository.scheduleSnapshot?.({ streamId, priorVersion: 5, version: 7, state: 7 });
    await Promise.resolve();
    await Promise.resolve();
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(saveSpy).toHaveBeenLastCalledWith({ streamId, streamVersion: 7, schemaVersion: SCHEMA_VERSION, state: 7 });
  });

  it("never fails a command when the write-behind snapshot save rejects", async () => {
    const streamId = "counter-write-behind-failure";
    const onSnapshotWriteFailed = vi.fn();
    const eventStore: EventStore = {
      readStream: vi.fn(async () => []),
      appendToStream: vi.fn<EventStore["appendToStream"]>(async (input) =>
        input.events.map((event, index) => ({
          eventId: `evt_${index + 1}` as never,
          streamId: input.streamId,
          streamVersion: index + 1,
          globalPosition: String(index + 1) as never,
          tenantId: "tnt_1" as never,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: "2026-07-10T00:00:00.000Z" as never,
          recordedAt: "2026-07-10T00:00:00.000Z" as never,
          performedByUserId: "usr_1" as never,
          forAccountId: "acc_1" as never,
        })),
      ),
      readAll: vi.fn(async () => []),
    };
    const failingSnapshotStore: AggregateSnapshotStore<number> = {
      loadLatest: async () => null,
      save: async () => {
        throw new Error("snapshot write failed");
      },
    };

    const { commandHandler } = createAggregateCommandHandler<number, CounterCommand, CounterEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve,
      decide: (_state, command) => [{ type: "counter.incremented" as const, data: { by: command.by } }],
      snapshots: { store: failingSnapshotStore, schemaVersion: SCHEMA_VERSION, everyNEvents: 1, onSnapshotWriteFailed },
    });

    await expect(commandHandler({ streamId, command: { type: "Increment", by: 4 }, context })).resolves.toMatchObject({
      state: 4,
      version: 1,
    });

    // Let the fire-and-forget snapshot save's rejection resolve.
    await vi.waitFor(() => {
      expect(onSnapshotWriteFailed).toHaveBeenCalledWith(expect.any(Error), { streamId, streamVersion: 1 });
    });
  });
});
