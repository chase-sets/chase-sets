import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresProjectionStore } from "./projection-store";
import { createIsolatedPostgresTestSchema, type IsolatedPostgresTestSchema } from "./postgres-db-test-support";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("postgres projection store real database integration", () => {
  let schema: IsolatedPostgresTestSchema;

  beforeAll(async () => {
    schema = await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "projection_store");
  });

  beforeEach(async () => {
    await schema.reset();
  });

  afterAll(async () => {
    await schema?.close();
  });

  it("keeps checkpoints monotonic", async () => {
    const store = createPostgresProjectionStore({
      db: schema.pool,
      now: () => "2026-06-28T12:00:00.000Z" as never,
    });

    await expect(store.loadCheckpoint("catalog.item-projection")).resolves.toBe("0");

    await store.saveCheckpoint("catalog.item-projection", "9" as never);
    await store.saveCheckpoint("catalog.item-projection", "3" as never);
    await expect(store.loadCheckpoint("catalog.item-projection")).resolves.toBe("9");

    await store.saveCheckpoint("catalog.item-projection", "10" as never);
    await expect(store.loadCheckpoint("catalog.item-projection")).resolves.toBe("10");
  });

  it("tracks poison events through blocked, retrying, and resolved stream lifecycle", async () => {
    const store = createPostgresProjectionStore({
      db: schema.pool,
      now: createClock([
        "2026-06-28T12:00:00.000Z",
        "2026-06-28T12:01:00.000Z",
        "2026-06-28T12:02:00.000Z",
        "2026-06-28T12:03:00.000Z",
      ]),
    });

    await store.recordPoisonEvent?.({
      projectionKey: "catalog.items",
      projectionName: "items",
      projectionKind: "subscription",
      targetContextName: "catalog-read",
      sourceContextName: "catalog",
      subscriptionVersion: 2,
      streamId: "catalog.item-item_bad",
      streamVersion: 1,
      eventId: "evt_poison_1",
      eventType: "catalog.item.created",
      globalPosition: "5" as never,
      failureKind: "poison",
      errorMessage: "bad payload",
      errorStack: "stack",
    });
    await store.recordDeferredBlockedStreamEvent?.({
      projectionKey: "catalog.items",
      streamId: "catalog.item-item_bad",
      streamVersion: 2,
      globalPosition: "6" as never,
    });

    await expect(store.loadProjectionErrorSummary?.("catalog.items")).resolves.toEqual({
      blockedStreamCount: 1,
      poisonEventCount: 1,
    });
    await expect(store.loadBlockedStream?.("catalog.items", "catalog.item-item_bad")).resolves.toMatchObject({
      firstBlockedGlobalPosition: "5",
      firstBlockedStreamVersion: 1,
      lastSeenGlobalPosition: "6",
      deferredEventCount: 1,
      state: "blocked",
    });
    await expect(store.listPoisonEvents?.("catalog.items")).resolves.toEqual([
      expect.objectContaining({
        eventId: "evt_poison_1",
        state: "blocked",
        retryCount: 0,
        resolvedAt: null,
      }),
    ]);

    await store.markBlockedStreamRetrying?.("catalog.items", "catalog.item-item_bad");
    await expect(store.loadBlockedStream?.("catalog.items", "catalog.item-item_bad")).resolves.toMatchObject({
      state: "retrying",
    });
    await expect(store.listPoisonEvents?.("catalog.items")).resolves.toEqual([
      expect.objectContaining({
        eventId: "evt_poison_1",
        state: "retrying",
        retryCount: 1,
      }),
    ]);

    await store.resolveBlockedStream?.("catalog.items", "catalog.item-item_bad");
    await expect(store.loadBlockedStream?.("catalog.items", "catalog.item-item_bad")).resolves.toBeNull();
    await expect(store.listPoisonEvents?.("catalog.items")).resolves.toEqual([]);
    await expect(store.loadProjectionErrorSummary?.("catalog.items")).resolves.toEqual({
      blockedStreamCount: 0,
      poisonEventCount: 0,
    });
  });
});

function createClock(timestamps: readonly string[]): () => never {
  let index = 0;

  return () => timestamps[Math.min(index++, timestamps.length - 1)] as never;
}
