import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { DomainEvent } from "@chase-sets/event-core/domain";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresAggregateSnapshotStore } from "./aggregate-snapshot-store";
import { createPostgresEventStore } from "./event-store";
import { createIsolatedPostgresTestSchema, type IsolatedPostgresTestSchema } from "./postgres-db-test-support";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = adminDatabaseUrl ? describe : describe.skip;

type CounterEvent = DomainEvent<"counter.incremented", { by: number }>;
type CounterCommand = Readonly<{ type: "Increment"; by: number }>;

const SNAPSHOT_SCHEMA_VERSION = 1;

function eventContext(): EventStoreContext {
  return {
    tenantId: "tenant_snapshot_db_test" as never,
    audit: {
      performedByUserId: "user_snapshot_db_test" as never,
      forAccountId: "account_snapshot_db_test" as never,
    },
  };
}

describeDb("postgres aggregate snapshot store real database integration", () => {
  let schema: IsolatedPostgresTestSchema;

  beforeAll(async () => {
    schema = await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "aggregate_snapshot_store");
  });

  beforeEach(async () => {
    await schema.reset();
  });

  afterAll(async () => {
    await schema?.close();
  });

  it("round-trips the latest snapshot for a stream", async () => {
    const store = createPostgresAggregateSnapshotStore<number>({
      db: schema.pool,
      now: () => "2026-07-11T00:00:00.000Z" as never,
    });
    await seedStreamRow("counter-1");

    await expect(store.loadLatest("counter-1")).resolves.toBeNull();

    await store.save({ streamId: "counter-1", streamVersion: 5, schemaVersion: SNAPSHOT_SCHEMA_VERSION, state: 12 });
    await expect(store.loadLatest("counter-1")).resolves.toMatchObject({
      streamId: "counter-1",
      streamVersion: 5,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      state: 12,
    });

    await store.save({ streamId: "counter-1", streamVersion: 9, schemaVersion: SNAPSHOT_SCHEMA_VERSION, state: 30 });
    await expect(store.loadLatest("counter-1")).resolves.toMatchObject({ streamVersion: 9, state: 30 });
  });

  it("never regresses a stored snapshot to an older streamVersion", async () => {
    const store = createPostgresAggregateSnapshotStore<number>({ db: schema.pool });
    await seedStreamRow("counter-race");

    await store.save({
      streamId: "counter-race",
      streamVersion: 10,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      state: 100,
    });
    // A superseded write-behind save for an earlier command loses the race.
    await store.save({ streamId: "counter-race", streamVersion: 4, schemaVersion: SNAPSHOT_SCHEMA_VERSION, state: 40 });

    await expect(store.loadLatest("counter-race")).resolves.toMatchObject({ streamVersion: 10, state: 100 });
  });

  // A snapshot row's foreign key requires an event_store_streams row to
  // already exist -- exactly the real order of operations, since
  // scheduleSnapshot only ever runs after a successful append.
  async function seedStreamRow(streamId: string): Promise<void> {
    const eventStore = createPostgresEventStore({ pool: schema.pool });
    await eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context: eventContext(),
      events: [{ eventType: "counter.incremented", payload: { by: 1 } }],
    });
  }

  it("cascades snapshot rows when the event-store stream row is removed", async () => {
    const eventStore = createPostgresEventStore({ pool: schema.pool });
    const store = createPostgresAggregateSnapshotStore<number>({ db: schema.pool });

    await eventStore.appendToStream({
      streamId: "counter-cascade",
      expectedVersion: "no_stream",
      context: eventContext(),
      events: [{ eventType: "counter.incremented", payload: { by: 1 } }],
    });
    await store.save({
      streamId: "counter-cascade",
      streamVersion: 1,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      state: 1,
    });
    await expect(store.loadLatest("counter-cascade")).resolves.not.toBeNull();

    await schema.pool.query("DELETE FROM event_store_streams WHERE stream_id = $1", ["counter-cascade"]);
    await expect(store.loadLatest("counter-cascade")).resolves.toBeNull();
  });

  it("keeps a snapshot-assisted load's state and version identical to full replay against real Postgres", async () => {
    const eventStore = createPostgresEventStore({ pool: schema.pool });
    const snapshotStore = createPostgresAggregateSnapshotStore<number>({ db: schema.pool });
    const streamId = "counter-real-db-parity";

    // Run every command through the SNAPSHOT-configured handler so its
    // write-behind hook actually fires against the real snapshot table.
    const { commandHandler: withSnapshots, repository: snapshotAssistedRepository } = createAggregateCommandHandler<
      number,
      CounterCommand,
      CounterEvent
    >({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve: (state, event) => state + event.data.by,
      decide: (_state, command) => [{ type: "counter.incremented" as const, data: { by: command.by } }],
      snapshots: { store: snapshotStore, schemaVersion: SNAPSHOT_SCHEMA_VERSION, everyNEvents: 10 },
    });

    for (let index = 0; index < 37; index += 1) {
      await withSnapshots({ streamId, command: { type: "Increment", by: index + 1 }, context: eventContext() });
    }

    // A separate, read-only, snapshot-free repository against the SAME
    // underlying event store is the full-replay ground truth.
    const { repository: noSnapshotRepository } = createAggregateCommandHandler<number, CounterCommand, CounterEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve: (state, event) => state + event.data.by,
      decide: (_state, command) => [{ type: "counter.incremented" as const, data: { by: command.by } }],
    });

    const referenceSum = Array.from({ length: 37 }, (_, index) => index + 1).reduce((sum, by) => sum + by, 0);
    const noSnapshotLoad = await noSnapshotRepository.load(streamId);
    expect(noSnapshotLoad.state).toBe(referenceSum);
    expect(noSnapshotLoad.version).toBe(37);

    // Write-behind saves are fire-and-forget; give the last one's promise a
    // turn to settle before asserting on the snapshot table.
    await vi.waitFor(async () => {
      await expect(snapshotStore.loadLatest(streamId)).resolves.toMatchObject({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      });
    });

    const snapshotAssistedLoad = await snapshotAssistedRepository.load(streamId);
    expect(snapshotAssistedLoad.state).toBe(referenceSum);
    expect(snapshotAssistedLoad.version).toBe(37);

    // Every-10-events threshold over 37 commands crosses at least three
    // times (10, 20, 30); the stored snapshot should reflect that progress,
    // not just the very first crossing.
    const latestSnapshot = await snapshotStore.loadLatest(streamId);
    expect(latestSnapshot?.streamVersion).toBeGreaterThanOrEqual(30);
  });

  it("reduces load() latency on a 500-event stream (before/after benchmark)", async () => {
    const eventStore = createPostgresEventStore({ pool: schema.pool });
    const snapshotStore = createPostgresAggregateSnapshotStore<number>({ db: schema.pool });
    const streamId = "counter-500-benchmark";

    // Seed 500 events directly (bypassing per-command round trips) so the
    // benchmark measures load()'s replay cost, not append throughput.
    const chunkSize = 100;
    for (let start = 0; start < 500; start += chunkSize) {
      await eventStore.appendToStream({
        streamId,
        expectedVersion: start === 0 ? "no_stream" : start,
        context: eventContext(),
        events: Array.from({ length: chunkSize }, () => ({
          eventType: "counter.incremented",
          payload: { by: 1 },
        })),
      });
    }

    const { repository: noSnapshotRepository } = createAggregateCommandHandler<number, CounterCommand, CounterEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve: (state, event) => state + event.data.by,
      decide: (_state, command) => [{ type: "counter.incremented" as const, data: { by: command.by } }],
    });

    // "Before": every load() replays all 500 events from event #1.
    const beforeSamples = await timeLoads(noSnapshotRepository, streamId, 5);

    // Simulate write-behind having already caught this stream up to a
    // recent snapshot (as it would after real traffic at everyNEvents=100).
    await snapshotStore.save({
      streamId,
      streamVersion: 400,
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      state: 400,
    });

    const { repository: snapshotAssistedRepository } = createAggregateCommandHandler<
      number,
      CounterCommand,
      CounterEvent
    >({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve: (state, event) => state + event.data.by,
      decide: (_state, command) => [{ type: "counter.incremented" as const, data: { by: command.by } }],
      snapshots: { store: snapshotStore, schemaVersion: SNAPSHOT_SCHEMA_VERSION, everyNEvents: 100 },
    });

    // "After": load() replays only the 100 events past the snapshot.
    const afterSamples = await timeLoads(snapshotAssistedRepository, streamId, 5);

    const beforeMedianMs = median(beforeSamples);
    const afterMedianMs = median(afterSamples);

    // eslint-disable-next-line no-console -- before/after numbers must land in the PR description.
    console.log(
      `[m113 aggregate snapshots] 500-event listing-stream load() latency -- before (full replay): ${beforeMedianMs.toFixed(2)}ms median` +
        ` | after (snapshot at v400 + 100-event tail replay): ${afterMedianMs.toFixed(2)}ms median` +
        ` | samples: before=${beforeSamples.map((ms) => ms.toFixed(2)).join(",")}` +
        ` after=${afterSamples.map((ms) => ms.toFixed(2)).join(",")}`,
    );

    const noSnapshotLoad = await noSnapshotRepository.load(streamId);
    const snapshotAssistedLoad = await snapshotAssistedRepository.load(streamId);
    expect(snapshotAssistedLoad.state).toBe(noSnapshotLoad.state);
    expect(snapshotAssistedLoad.version).toBe(noSnapshotLoad.version);
    expect(afterMedianMs).toBeLessThan(beforeMedianMs);
  });
});

async function timeLoads(
  repository: Readonly<{ load: (streamId: string) => Promise<unknown> }>,
  streamId: string,
  sampleCount: number,
): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const startedAt = performance.now();
    await repository.load(streamId);
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
