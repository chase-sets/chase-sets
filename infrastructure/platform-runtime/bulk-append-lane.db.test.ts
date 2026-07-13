import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { AggregateRepository, DomainEvent } from "@chase-sets/event-core";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import {
  createIsolatedPostgresTestSchema,
  type IsolatedPostgresTestSchema,
} from "@chase-sets/event-core-postgres/postgres-db-test-support";
import { createBulkAppendLane, type BulkAppendLaneItem } from "./bulk-append-lane";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

type WidgetState = Readonly<{ value: string | null }>;
type SetWidgetValueCommand = Readonly<{ type: "SetValue"; value: string }>;
type WidgetValueSetEvent = DomainEvent<"widget.value-set", Readonly<{ value: string }>>;

function evolve(state: WidgetState, event: WidgetValueSetEvent): WidgetState {
  return { value: event.data.value };
}

function decide(state: WidgetState, command: SetWidgetValueCommand): readonly WidgetValueSetEvent[] {
  if (state.value === command.value) {
    return [];
  }
  return [{ type: "widget.value-set", data: { value: command.value } }];
}

function context(): EventStoreContext {
  return {
    tenantId: "tenant_bulk_lane" as never,
    audit: { performedByUserId: "user_bulk_lane" as never, forAccountId: "account_bulk_lane" as never },
  };
}

describeDb("bulk append lane real database integration", () => {
  let schema: IsolatedPostgresTestSchema;

  beforeAll(async () => {
    schema = await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "bulk_append_lane");
  });

  beforeEach(async () => {
    await schema.reset();
  });

  afterAll(async () => {
    await schema?.close();
  });

  function createRuntime() {
    const eventStore = createPostgresEventStore({ pool: schema.pool });
    const { repository } = createAggregateCommandHandler<WidgetState, SetWidgetValueCommand, WidgetValueSetEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<WidgetValueSetEvent>(),
      initialState: () => ({ value: null }),
      evolve,
      decide,
    });
    return { eventStore, repository };
  }

  it("isolates a real per-stream version conflict inside a live chunk without rolling back its siblings", async () => {
    const { eventStore, repository } = createRuntime();

    // A repository wrapper that reproduces the real race an optimistic-concurrency
    // conflict guards against: right after the lane loads "widget-conflict" (and
    // captures that version as its expectedVersion), a concurrent writer commits to
    // the SAME stream before the lane's own append runs -- so the lane's chunk append
    // for that stream is now provably stale by the time it reaches the transaction.
    let conflictInjected = false;
    const racyRepository: AggregateRepository<WidgetState, WidgetValueSetEvent> = {
      load: async (streamId) => {
        const loaded = await repository.load(streamId);
        if (streamId === "widget-conflict" && !conflictInjected) {
          conflictInjected = true;
          await eventStore.appendToStream({
            streamId: "widget-conflict",
            expectedVersion: loaded.version,
            context: context(),
            events: [{ eventType: "widget.value-set", payload: { value: "raced-in-concurrently" } }],
          });
        }
        return loaded;
      },
      append: repository.append,
    };

    const lane = createBulkAppendLane({
      eventStore,
      repository: racyRepository,
      codec: createPassthroughDomainEventCodec<WidgetValueSetEvent>(),
      evolve,
      decide,
      chunkSize: 5,
      yieldIntervalMs: 0,
    });

    const items: BulkAppendLaneItem<SetWidgetValueCommand>[] = [
      { streamId: "widget-conflict", command: { type: "SetValue", value: "lane-write" }, context: context() },
      { streamId: "widget-sibling-a", command: { type: "SetValue", value: "a" }, context: context() },
      { streamId: "widget-sibling-b", command: { type: "SetValue", value: "b" }, context: context() },
    ];

    const outcomes = await lane(items);

    expect(outcomes.find((outcome) => outcome.streamId === "widget-conflict")).toMatchObject({ outcome: "conflict" });
    expect(outcomes.find((outcome) => outcome.streamId === "widget-sibling-a")).toMatchObject({ outcome: "applied" });
    expect(outcomes.find((outcome) => outcome.streamId === "widget-sibling-b")).toMatchObject({ outcome: "applied" });

    // The concurrent writer's event survived; the lane's own (stale) write did not.
    await expect(eventStore.readStream({ streamId: "widget-conflict", limit: 10 })).resolves.toMatchObject([
      { payload: { value: "raced-in-concurrently" } },
    ]);
    await expect(eventStore.readStream({ streamId: "widget-sibling-a", limit: 10 })).resolves.toHaveLength(1);
    await expect(eventStore.readStream({ streamId: "widget-sibling-b", limit: 10 })).resolves.toHaveLength(1);
  });

  it("bounds interactive-append latency during a staged bulk run via inter-chunk yields", async () => {
    const { eventStore, repository } = createRuntime();
    const chunkSize = 5;
    const yieldIntervalMs = 40;
    const totalListings = 40; // 8 chunks, 7 inter-chunk yields
    const lane = createBulkAppendLane({
      eventStore,
      repository,
      codec: createPassthroughDomainEventCodec<WidgetValueSetEvent>(),
      evolve,
      decide,
      chunkSize,
      yieldIntervalMs,
    });

    const items: BulkAppendLaneItem<SetWidgetValueCommand>[] = Array.from({ length: totalListings }, (_, index) => ({
      streamId: `widget-fairness-${index}`,
      command: { type: "SetValue", value: `v${index}` },
      context: context(),
    }));

    const bulkStartedAt = Date.now();
    const bulkRun = lane(items).then((outcomes) => {
      const bulkCompletedAt = Date.now();
      return { outcomes, bulkCompletedAt };
    });

    // Give the bulk run a head start so it is genuinely mid-flight, then issue an ordinary
    // interactive append against an unrelated stream while the bulk run is still chunking.
    await new Promise((resolve) => setTimeout(resolve, yieldIntervalMs));
    const interactiveStartedAt = Date.now();
    await eventStore.appendToStream({
      streamId: "widget-interactive",
      expectedVersion: "no_stream",
      context: context(),
      events: [{ eventType: "widget.value-set", payload: { value: "interactive" } }],
    });
    const interactiveCompletedAt = Date.now();
    const interactiveLatencyMs = interactiveCompletedAt - interactiveStartedAt;

    const { outcomes, bulkCompletedAt } = await bulkRun;
    const bulkDurationMs = bulkCompletedAt - bulkStartedAt;

    expect(outcomes.every((outcome) => outcome.outcome === "applied")).toBe(true);
    // The bulk run spans at least (chunks - 1) yields -- proof chunking + yielding actually happened.
    expect(bulkDurationMs).toBeGreaterThanOrEqual(yieldIntervalMs * 3);
    // The interactive append is not queued behind the whole bulk run: it completes quickly...
    expect(interactiveLatencyMs).toBeLessThan(bulkDurationMs);
    expect(interactiveLatencyMs).toBeLessThan(500);
    // ...and strictly before the bulk run as a whole finishes, proving real interleaving.
    expect(interactiveCompletedAt).toBeLessThan(bulkCompletedAt);
  });
});
