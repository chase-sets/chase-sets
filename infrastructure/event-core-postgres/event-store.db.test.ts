import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@chase-sets/primitives/json";
import {
  EVENT_STORE_READ_PAGE_SIZE_MAX,
  globalPositionFromBigInt,
  globalPositionToBigInt,
  type EventStoreContext,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { toTransportEvent, type TransportEvent } from "@chase-sets/event-core/transport";
import {
  EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
  createPostgresEventStore,
  readGapSafeEventStoreHead,
} from "./event-store";
import { createIsolatedPostgresTestSchema, type IsolatedPostgresTestSchema } from "./postgres-db-test-support";
import { withPgTransaction, type PgPoolClient, type PgTransactionalPool } from "./types";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("postgres event store real database integration", () => {
  let schema: IsolatedPostgresTestSchema;
  let nextEventId: number;

  beforeAll(async () => {
    schema = await createIsolatedPostgresTestSchema(adminDatabaseUrl!, "event_store");
  });

  beforeEach(async () => {
    nextEventId = 1;
    await schema.reset();
  });

  afterAll(async () => {
    await schema?.close();
  });

  it("appends events and rejects optimistic-concurrency conflicts", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-06-28T12:00:00.000Z" as never,
      createEventId,
    });

    await expect(
      store.appendToStream({
        streamId: "commerce.order-ord_1",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [
          eventToStore("commerce.order.created", { orderId: "ord_1" }),
          eventToStore("commerce.order.confirmed", { orderId: "ord_1" }),
        ],
      }),
    ).resolves.toMatchObject([
      { eventId: "evt_db_1", streamVersion: 1, globalPosition: "1" },
      { eventId: "evt_db_2", streamVersion: 2, globalPosition: "2" },
    ]);

    await expect(
      store.appendToStream({
        streamId: "commerce.order-ord_1",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [eventToStore("commerce.order.cancelled", { orderId: "ord_1" })],
      }),
    ).rejects.toMatchObject({
      code: "concurrency_conflict",
      details: {
        expectedVersion: "no_stream",
        currentVersion: 2,
      },
    });

    await expect(
      store.appendToStream({
        streamId: "commerce.order-ord_1",
        expectedVersion: 1,
        context: eventContext("tenant_a"),
        events: [eventToStore("commerce.order.cancelled", { orderId: "ord_1" })],
      }),
    ).rejects.toMatchObject({
      code: "concurrency_conflict",
      details: {
        expectedVersion: 1,
        currentVersion: 2,
      },
    });
  });

  it("treats a duplicate caller-supplied event id retry as an idempotent no-op", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-06-28T12:00:00.000Z" as never,
      createEventId,
    });
    const event = {
      eventId: "evt_db_command_1" as never,
      eventType: "payments.refund.requested",
      payload: { paymentId: "pay_1", refundId: "ref_1" },
      metadata: { commandId: "cmd_1" },
    };

    const first = await store.appendToStream({
      streamId: "payments.payment-pay_1",
      expectedVersion: "no_stream",
      context: eventContext("tenant_a"),
      events: [event],
    });
    const retry = await store.appendToStream({
      streamId: "payments.payment-pay_1",
      expectedVersion: "any",
      context: eventContext("tenant_a"),
      events: [event],
    });

    expect(first).toMatchObject([{ eventId: "evt_db_command_1", streamVersion: 1, globalPosition: "1" }]);
    expect(retry).toEqual(first);
    await expect(store.readAll({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        eventId: "evt_db_command_1",
        streamId: "payments.payment-pay_1",
        streamVersion: 1,
      }),
    ]);
    await expect(
      store.appendToStream({
        streamId: "payments.payment-pay_1",
        expectedVersion: "any",
        context: eventContext("tenant_a"),
        events: [
          {
            ...event,
            payload: { paymentId: "pay_1", refundId: "ref_changed" },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "concurrency_conflict",
      message: "Event id was already used with different event data.",
    });
  });

  it("rolls back earlier stream appends when a later stream append conflicts", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-06-28T12:00:00.000Z" as never,
      createEventId,
    });

    await store.appendToStream({
      streamId: "commerce.order-ord_dual_conflict",
      expectedVersion: "no_stream",
      context: eventContext("tenant_a"),
      events: [eventToStore("commerce.order.created", { orderId: "ord_dual_conflict" })],
    });

    await expect(
      store.appendToStreams!([
        {
          streamId: "commerce.order-ord_dual_new",
          expectedVersion: "no_stream",
          context: eventContext("tenant_a"),
          events: [eventToStore("commerce.order.created", { orderId: "ord_dual_new" })],
        },
        {
          streamId: "commerce.order-ord_dual_conflict",
          expectedVersion: "no_stream",
          context: eventContext("tenant_a"),
          events: [eventToStore("commerce.order.confirmed", { orderId: "ord_dual_conflict" })],
        },
      ]),
    ).rejects.toMatchObject({
      code: "concurrency_conflict",
      details: {
        expectedVersion: "no_stream",
        currentVersion: 1,
      },
    });

    await expect(store.readStream({ streamId: "commerce.order-ord_dual_new", limit: 10 })).resolves.toEqual([]);
    await expect(store.readStream({ streamId: "commerce.order-ord_dual_conflict", limit: 10 })).resolves.toHaveLength(
      1,
    );
  });

  it("rolls back every stream when a zero-event guard participant's expected version no longer matches", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-06-28T12:00:00.000Z" as never,
      createEventId,
    });

    // The guarded stream is read while it has no events, then moves before the
    // append. The guard contributes no events of its own.
    await store.appendToStream({
      streamId: "platform-policy.authority-guarded",
      expectedVersion: "no_stream",
      context: eventContext("tenant_a"),
      events: [eventToStore("platform-policy.authority.activated", { policyKey: "identity.terms" })],
    });

    await expect(
      store.appendToStreams!([
        {
          streamId: "platform-policy.authority-guarded",
          expectedVersion: "no_stream",
          context: eventContext("tenant_a"),
          events: [],
        },
        {
          streamId: "commerce.order-ord_guarded",
          expectedVersion: "no_stream",
          context: eventContext("tenant_a"),
          events: [eventToStore("commerce.order.created", { orderId: "ord_guarded" })],
        },
      ]),
    ).rejects.toMatchObject({
      code: "concurrency_conflict",
      details: { expectedVersion: "no_stream", currentVersion: 1 },
    });

    await expect(store.readStream({ streamId: "commerce.order-ord_guarded", limit: 10 })).resolves.toEqual([]);
    await expect(store.readStream({ streamId: "platform-policy.authority-guarded", limit: 10 })).resolves.toHaveLength(
      1,
    );
  });

  it("commits every stream when a zero-event guard participant still matches", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-06-28T12:00:00.000Z" as never,
      createEventId,
    });

    await store.appendToStreams!([
      {
        streamId: "platform-policy.authority-matching",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [],
      },
      {
        streamId: "commerce.order-ord_matching",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [eventToStore("commerce.order.created", { orderId: "ord_matching" })],
      },
    ]);

    await expect(store.readStream({ streamId: "commerce.order-ord_matching", limit: 10 })).resolves.toHaveLength(1);
    // A guard writes no events to the stream it protects, even though it
    // materializes that stream's row so concurrent writers serialize on it.
    await expect(store.readStream({ streamId: "platform-policy.authority-matching", limit: 10 })).resolves.toHaveLength(
      0,
    );
  });

  it("allows exactly one concurrent guarded append against a first activation of the guarded stream", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-06-28T12:00:00.000Z" as never,
      createEventId,
    });

    const guardedAppend = store.appendToStreams!([
      {
        streamId: "platform-policy.authority-race",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [],
      },
      {
        streamId: "commerce.order-ord_race",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [eventToStore("commerce.order.created", { orderId: "ord_race" })],
      },
    ]);

    const activation = store.appendToStream({
      streamId: "platform-policy.authority-race",
      expectedVersion: "no_stream",
      context: eventContext("tenant_a"),
      events: [eventToStore("platform-policy.authority.activated", { policyKey: "identity.terms" })],
    });

    const [guardedOutcome, activationOutcome] = await Promise.allSettled([guardedAppend, activation]);

    // Both transactions serialize on the guarded stream's row. The activation
    // always lands; the guarded append commits only if it got there first.
    expect(activationOutcome.status).toBe("fulfilled");
    const orderEvents = await store.readStream({ streamId: "commerce.order-ord_race", limit: 10 });
    if (guardedOutcome.status === "fulfilled") {
      expect(orderEvents).toHaveLength(1);
    } else {
      expect(guardedOutcome.reason).toMatchObject({ code: "concurrency_conflict" });
      expect(orderEvents).toHaveLength(0);
    }
  });

  it("allows exactly one simultaneous append with the same expected stream revision", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-06-28T12:00:00.000Z" as never,
      createEventId,
    });

    await store.appendToStream({
      streamId: "commerce.order-ord_concurrent_existing",
      expectedVersion: "no_stream",
      context: eventContext("tenant_a"),
      events: [eventToStore("commerce.order.created", { orderId: "ord_concurrent_existing" })],
    });

    const lockClient = await beginGlobalAppendLock(schema.pool);
    let lockClientReleased = false;
    const firstAppend = store.appendToStream({
      streamId: "commerce.order-ord_concurrent_existing",
      expectedVersion: 1,
      context: eventContext("tenant_a"),
      events: [eventToStore("commerce.order.confirmed", { orderId: "ord_concurrent_existing" })],
    });
    const secondAppend = store.appendToStream({
      streamId: "commerce.order-ord_concurrent_existing",
      expectedVersion: 1,
      context: eventContext("tenant_a"),
      events: [eventToStore("commerce.order.cancelled", { orderId: "ord_concurrent_existing" })],
    });

    try {
      await expect(hasSettledWithin(Promise.allSettled([firstAppend, secondAppend]), 50)).resolves.toBe(false);

      await lockClient.query("COMMIT");
      lockClient.release();
      lockClientReleased = true;

      const results = await Promise.allSettled([firstAppend, secondAppend]);
      const fulfilled = fulfilledResults(results);
      const rejected = rejectedResults(results);

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0]).toMatchObject([{ streamVersion: 2 }]);
      expect(rejected[0]).toMatchObject({
        code: "concurrency_conflict",
        details: {
          expectedVersion: 1,
          currentVersion: 2,
        },
      });
      await expect(
        store.readStream({ streamId: "commerce.order-ord_concurrent_existing", fromVersion: 1, limit: 10 }),
      ).resolves.toHaveLength(2);
    } finally {
      if (!lockClientReleased) {
        await lockClient.query("ROLLBACK").catch(() => undefined);
        lockClient.release();
      }
    }
  });

  it("allows exactly one parallel first append with no_stream expected revision", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-06-28T12:00:00.000Z" as never,
      createEventId,
    });
    const streamId = "commerce.order-ord_concurrent_first";
    const lockClient = await beginGlobalAppendLock(schema.pool);
    let lockClientReleased = false;
    const firstAppend = store.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context: eventContext("tenant_a"),
      events: [eventToStore("commerce.order.created", { orderId: "ord_concurrent_first", attempt: "first" })],
    });
    const secondAppend = store.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context: eventContext("tenant_a"),
      events: [eventToStore("commerce.order.created", { orderId: "ord_concurrent_first", attempt: "second" })],
    });

    try {
      await expect(hasSettledWithin(Promise.allSettled([firstAppend, secondAppend]), 50)).resolves.toBe(false);

      await lockClient.query("COMMIT");
      lockClient.release();
      lockClientReleased = true;

      const results = await Promise.allSettled([firstAppend, secondAppend]);
      const fulfilled = fulfilledResults(results);
      const rejected = rejectedResults(results);

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0]).toMatchObject([{ streamVersion: 1 }]);
      expect(rejected[0]).toMatchObject({
        code: "concurrency_conflict",
        details: {
          expectedVersion: "no_stream",
          currentVersion: 1,
        },
      });
      await expect(store.readStream({ streamId, fromVersion: 1, limit: 10 })).resolves.toHaveLength(1);
    } finally {
      if (!lockClientReleased) {
        await lockClient.query("ROLLBACK").catch(() => undefined);
        lockClient.release();
      }
    }
  });

  it("keeps the same pooled client available after rolled-back business errors", async () => {
    const pool = schema.pool as PgTransactionalPool & Readonly<{ idleCount: number; totalCount: number }>;

    await withPgTransaction(pool, async () => "warm");
    const baseline = {
      idleCount: pool.idleCount,
      totalCount: pool.totalCount,
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        withPgTransaction(pool, async () => {
          throw new Error(`business conflict ${attempt}`);
        }),
      ).rejects.toThrow(`business conflict ${attempt}`);
    }

    expect(pool.totalCount).toBe(baseline.totalCount);
    expect(pool.idleCount).toBe(baseline.idleCount);
  });

  it("reads a stream from the requested stream version in stream-version order", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });

    await appendEvents(store, "catalog.item-item_1", "tenant_a", [
      ["catalog.item.created", { itemId: "item_1" }],
      ["catalog.item.updated", { itemId: "item_1", field: "name" }],
      ["catalog.item.published", { itemId: "item_1" }],
    ]);
    await appendEvents(store, "catalog.item-item_2", "tenant_a", [["catalog.item.created", { itemId: "item_2" }]]);

    await expect(store.readStream({ streamId: "catalog.item-item_1", fromVersion: 2, limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        streamId: "catalog.item-item_1",
        streamVersion: 2,
        eventType: "catalog.item.updated",
      }),
      expect.objectContaining({
        streamId: "catalog.item-item_1",
        streamVersion: 3,
        eventType: "catalog.item.published",
      }),
    ]);
  });

  it("filters global reads by tenant, event type, and stream prefix", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });

    await appendEvents(store, "catalog.item-item_1", "tenant_a", [["catalog.item.created", { itemId: "item_1" }]]);
    await appendEvents(store, "catalog.item-item_2", "tenant_b", [["catalog.item.updated", { itemId: "item_2" }]]);
    await appendEvents(store, "commerce.order-ord_1", "tenant_a", [["commerce.order.created", { orderId: "ord_1" }]]);
    await appendEvents(store, "catalog.box-box_1", "tenant_a", [["catalog.box.created", { boxId: "box_1" }]]);

    await expect(store.readAll({ tenantId: "tenant_a" as never, limit: 10 })).resolves.toEqual([
      expect.objectContaining({ streamId: "catalog.item-item_1", tenantId: "tenant_a" }),
      expect.objectContaining({ streamId: "commerce.order-ord_1", tenantId: "tenant_a" }),
      expect.objectContaining({ streamId: "catalog.box-box_1", tenantId: "tenant_a" }),
    ]);

    await expect(
      store.readAll({ eventTypes: ["catalog.item.created", "catalog.item.created"], limit: 10 }),
    ).resolves.toEqual([
      expect.objectContaining({
        streamId: "catalog.item-item_1",
        eventType: "catalog.item.created",
      }),
    ]);

    await expect(store.readAll({ streamPrefixes: ["catalog.item-"], limit: 10 })).resolves.toEqual([
      expect.objectContaining({ streamId: "catalog.item-item_1" }),
      expect.objectContaining({ streamId: "catalog.item-item_2" }),
    ]);

    await expect(
      store.readAll({
        tenantId: "tenant_a" as never,
        eventTypes: ["catalog.item.created", "catalog.item.updated"],
        streamPrefixes: ["catalog.item-"],
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        streamId: "catalog.item-item_1",
        tenantId: "tenant_a",
        eventType: "catalog.item.created",
      }),
    ]);
  });

  it("honors a captured inclusive horizon at and below its position while excluding a later append", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });

    await appendEvents(store, "catalog.item-horizon", "tenant_a", [
      ["catalog.item.created", { itemId: "horizon" }],
      ["catalog.item.updated", { itemId: "horizon" }],
    ]);
    const horizon = await readGapSafeEventStoreHead(schema.pool);
    await appendEvents(store, "catalog.item-above-horizon", "tenant_a", [
      ["catalog.item.created", { itemId: "above-horizon" }],
    ]);

    const page = await store.readAll({ atOrBeforeGlobalPosition: horizon, limit: 10 });

    expect(horizon).toBe("2");
    expect(page.map((event) => event.globalPosition)).toEqual(["1", "2"]);
    expect(page.at(-1)?.globalPosition).toBe(horizon);
    expect(page.map((event) => event.streamId)).not.toContain("catalog.item-above-horizon");
  });

  it("refuses a horizon above the real gap-safe head instead of clamping it", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });
    await appendEvents(store, "catalog.item-available", "tenant_a", [
      ["catalog.item.created", { itemId: "available" }],
    ]);
    const available = await readGapSafeEventStoreHead(schema.pool);
    const requested = globalPositionFromBigInt(globalPositionToBigInt(available) + 1n);

    await expect(store.readAll({ atOrBeforeGlobalPosition: requested, limit: 10 })).rejects.toThrow(
      `Event store read horizon ${requested} exceeds available global position ${available}.`,
    );
    await expect(readGapSafeEventStoreHead(schema.pool)).resolves.toBe(available);
  });

  it("refuses a malformed horizon before issuing any query to the real PostgreSQL pool", async () => {
    let queryCount = 0;
    const countingPool: PgTransactionalPool = {
      query: (async (sql: string, params?: readonly unknown[]) => {
        queryCount += 1;
        return schema.pool.query(sql, params);
      }) as PgTransactionalPool["query"],
      connect: () => schema.pool.connect(),
    };
    const store = createPostgresEventStore({ pool: countingPool, createEventId });

    await expect(store.readAll({ atOrBeforeGlobalPosition: "007" as never, limit: 10 })).rejects.toThrow(
      "GlobalPosition must be a canonical unsigned base-10 string.",
    );
    expect(queryCount).toBe(0);
  });

  it("honors zero and refuses above zero against an empty PostgreSQL event store", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });

    await expect(readGapSafeEventStoreHead(schema.pool)).resolves.toBe("0");
    await expect(store.readAll({ atOrBeforeGlobalPosition: "0" as never, limit: 10 })).resolves.toEqual([]);
    await expect(store.readAll({ atOrBeforeGlobalPosition: "1" as never, limit: 10 })).rejects.toThrow(
      "Event store read horizon 1 exceeds available global position 0.",
    );
  });

  it("keeps PostgreSQL and in-memory horizon projections byte-identical", async () => {
    const postgresStore = createPostgresEventStore({ pool: schema.pool, createEventId });
    const memoryStore = createInMemoryEventStore().eventStore;
    const inputs = [
      {
        streamId: "catalog.item-differential-1",
        expectedVersion: "no_stream" as const,
        context: eventContext("tenant_a"),
        events: [
          eventToStore("catalog.item.created", { itemId: "differential-1" }),
          eventToStore("catalog.item.updated", { itemId: "differential-1" }),
        ],
      },
      {
        streamId: "catalog.item-differential-2",
        expectedVersion: "no_stream" as const,
        context: eventContext("tenant_a"),
        events: [eventToStore("catalog.item.created", { itemId: "differential-2" })],
      },
    ] as const;

    for (const input of inputs) {
      await postgresStore.appendToStream(input);
      await memoryStore.appendToStream(input);
    }

    const readInput = {
      afterGlobalPosition: "1" as never,
      atOrBeforeGlobalPosition: "3" as never,
      tenantId: "tenant_a" as never,
      eventTypes: ["catalog.item.updated", "catalog.item.created"],
      streamPrefixes: ["catalog.item-differential-"],
      limit: 10,
    } as const;
    const project = (events: readonly StoredEvent[]) =>
      events.map(({ streamId, globalPosition, eventType }) => ({ streamId, globalPosition, eventType }));

    const postgresProjection = project(await postgresStore.readAll(readInput));
    const memoryProjection = project(await memoryStore.readAll(readInput));

    expect(JSON.stringify(postgresProjection)).toBe(JSON.stringify(memoryProjection));
    expect(postgresProjection).toEqual(memoryProjection);
    expect(postgresProjection).toEqual([
      {
        streamId: "catalog.item-differential-1",
        globalPosition: "2",
        eventType: "catalog.item.updated",
      },
      {
        streamId: "catalog.item-differential-2",
        globalPosition: "3",
        eventType: "catalog.item.created",
      },
    ]);
  });

  it("composes the horizon with tenant, prefix, event type, and after-position predicates", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });
    await appendEvents(store, "catalog.item-before-cursor", "tenant_a", [
      ["catalog.item.created", { itemId: "before-cursor" }],
    ]);
    await appendEvents(store, "catalog.item-foreign", "tenant_b", [["catalog.item.created", { itemId: "foreign" }]]);
    await appendEvents(store, "catalog.item-included-1", "tenant_a", [
      ["catalog.item.created", { itemId: "included-1" }],
    ]);
    await appendEvents(store, "catalog.item-wrong-type", "tenant_a", [
      ["catalog.item.updated", { itemId: "wrong-type" }],
    ]);
    await appendEvents(store, "catalog.item-included-2", "tenant_a", [
      ["catalog.item.created", { itemId: "included-2" }],
    ]);
    const horizon = await readGapSafeEventStoreHead(schema.pool);
    await appendEvents(store, "catalog.item-above-horizon", "tenant_a", [
      ["catalog.item.created", { itemId: "above-horizon" }],
    ]);

    const input = {
      afterGlobalPosition: "1" as never,
      atOrBeforeGlobalPosition: horizon,
      tenantId: "tenant_a" as never,
      eventTypes: ["catalog.item.created"],
      streamPrefixes: ["catalog.item-"],
      limit: 10,
    } as const;
    const page = await store.readAll(input);

    expect(input).toEqual({
      afterGlobalPosition: "1",
      atOrBeforeGlobalPosition: "5",
      tenantId: "tenant_a",
      eventTypes: ["catalog.item.created"],
      streamPrefixes: ["catalog.item-"],
      limit: 10,
    });
    expect(page.map((event) => event.globalPosition)).toEqual(["3", "5"]);
    expect(page.map((event) => event.streamId)).not.toContain("catalog.item-foreign");
    expect(page.map((event) => event.streamId)).not.toContain("catalog.item-above-horizon");
  });

  it("preserves the 500 page and 501 refusal boundaries under a horizon", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });
    await appendEvents(
      store,
      "catalog.item-page-boundary",
      "tenant_a",
      Array.from(
        { length: EVENT_STORE_READ_PAGE_SIZE_MAX },
        (_, index) => ["catalog.item.updated", { itemId: "page-boundary", revision: index + 1 }] as const,
      ),
    );
    const horizon = await readGapSafeEventStoreHead(schema.pool);

    const page = await store.readAll({
      atOrBeforeGlobalPosition: horizon,
      limit: EVENT_STORE_READ_PAGE_SIZE_MAX,
    });
    const positions = page.map((event) => globalPositionToBigInt(event.globalPosition));

    expect(page).toHaveLength(EVENT_STORE_READ_PAGE_SIZE_MAX);
    expect(page.at(-1)?.globalPosition).toBe(horizon);
    expect(positions.every((position, index) => index === 0 || position > positions[index - 1]!)).toBe(true);
    await expect(
      store.readAll({
        atOrBeforeGlobalPosition: horizon,
        limit: EVENT_STORE_READ_PAGE_SIZE_MAX + 1,
      }),
    ).rejects.toThrow("Event store read limit must be an integer between 1 and 500.");
  });

  it("uses production event-store read indexes for filtered readAll plans", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });

    await appendEvents(store, "catalog.item-item_1", "tenant_a", [["catalog.item.created", { itemId: "item_1" }]]);
    await appendEvents(store, "catalog.item-item_2", "tenant_b", [["catalog.item.updated", { itemId: "item_2" }]]);
    await appendEvents(store, "commerce.order-ord_1", "tenant_a", [["commerce.order.created", { orderId: "ord_1" }]]);

    await withPgTransaction(schema.pool, async (client) => {
      await client.query("SET LOCAL enable_seqscan = off");
      const explain = await client.query<Readonly<{ "QUERY PLAN": unknown }>>(
        `EXPLAIN (FORMAT JSON, COSTS OFF)
         SELECT event_id,
                stream_id,
                stream_version,
                global_position,
                tenant_id,
                stream_context_name,
                stream_category,
                event_type,
                payload,
                metadata,
                occurred_at,
                recorded_at,
                performed_by_user_id,
                for_account_id,
                trace_id,
                span_id,
                parent_span_id,
                trace_state
         FROM event_store_events AS events
         WHERE events.global_position > $1::bigint
           AND events.global_position <= $2::bigint
           AND events.global_position <= $3::bigint
           AND events.tenant_id = $4
           AND events.event_type = ANY($5::text[])
           AND ((events.stream_context_name = $6 AND events.stream_id LIKE $7 || '%' ESCAPE '\\'))
         ORDER BY events.global_position ASC
         LIMIT $8`,
        [0, 3, 3, "tenant_a", ["catalog.item.created", "catalog.item.updated"], "catalog", "catalog.item-", 10],
      );
      const plan = explain.rows[0]?.["QUERY PLAN"] ?? "";
      const planText = JSON.stringify(plan);
      const indexNames = collectExplainIndexNames(plan);

      expect(planText).not.toContain("Seq Scan");
      expect(indexNames).toEqual(
        expect.arrayContaining([
          // For a multi-event-type catch-up page ordered by global position, Postgres can prefer the
          // tenant/global index and apply the type/prefix filters while preserving the requested order.
          "event_store_events_tenant_global_idx",
        ]),
      );
      expect(indexNames).not.toContain("event_store_events_global_idx");
    });
  });

  it("keeps mixed stream-prefix filters and dashed aggregate ids visible in global reads", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });

    await appendEvents(store, "marketplace.review-rev_1", "tenant_a", [
      ["marketplace.review.created", { reviewId: "rev_1" }],
    ]);
    await appendEvents(store, "identity.account-acct_1", "tenant_a", [
      ["identity.account.created", { accountId: "acct_1" }],
    ]);
    await appendEvents(store, "commerce.order-ord-123", "tenant_a", [
      ["commerce.order.created", { orderId: "ord-123" }],
    ]);

    await expect(store.readAll({ streamPrefixes: ["marketplace.review-", "identity."], limit: 10 })).resolves.toEqual([
      expect.objectContaining({ streamId: "marketplace.review-rev_1" }),
      expect.objectContaining({ streamId: "identity.account-acct_1" }),
    ]);

    await expect(store.readAll({ streamPrefixes: ["commerce.order-"], limit: 10 })).resolves.toEqual([
      expect.objectContaining({ streamId: "commerce.order-ord-123" }),
    ]);
  });

  it("does not let a catch-up checkpoint skip a lower in-flight global position", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });
    const lowPositionClient = await beginUncommittedAppendWithSharedFence(schema.pool, {
      eventId: "evt_db_low",
      streamId: "catalog.item-low",
      itemId: "low",
    });
    let lowPositionClientReleased = false;
    await appendRawEventWithSharedFence(schema.pool, {
      eventId: "evt_db_high",
      streamId: "catalog.item-high",
      itemId: "high",
    });
    const catchUpRead = store.readAll({ limit: 10 });

    try {
      // A bare `global_position > checkpoint` read settles here with position 2,
      // advances to 2, and permanently skips the still-invisible position 1.
      await expect(hasSettledWithin(catchUpRead, 50)).resolves.toBe(false);

      await lowPositionClient.query("COMMIT");
      lowPositionClient.release();
      lowPositionClientReleased = true;

      const catchUpEvents = await catchUpRead;
      expect(catchUpEvents).toEqual([
        expect.objectContaining({
          eventId: "evt_db_low",
          streamId: "catalog.item-low",
          globalPosition: "1",
        }),
        expect.objectContaining({
          streamId: "catalog.item-high",
          globalPosition: "2",
        }),
      ]);
      expect(catchUpEvents.at(-1)?.globalPosition).toBe("2");
    } finally {
      if (!lowPositionClientReleased) {
        await lowPositionClient.query("ROLLBACK").catch(() => undefined);
        lowPositionClient.release();
      }
    }
  });

  it("keeps independent stream appends concurrent while a lower position is in flight", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });
    const lowPositionClient = await beginUncommittedAppendWithSharedFence(schema.pool, {
      eventId: "evt_db_concurrent_low",
      streamId: "catalog.item-concurrent-low",
      itemId: "concurrent-low",
    });
    let lowPositionClientReleased = false;
    const highPositionAppend = store.appendToStream({
      streamId: "catalog.item-concurrent-high",
      expectedVersion: "no_stream",
      context: eventContext("tenant_a"),
      events: [eventToStore("catalog.item.created", { itemId: "concurrent-high" })],
    });

    try {
      await expect(hasSettledWithin(highPositionAppend, 250)).resolves.toBe(true);
      await expect(highPositionAppend).resolves.toEqual([
        expect.objectContaining({
          streamId: "catalog.item-concurrent-high",
          globalPosition: "2",
        }),
      ]);

      await lowPositionClient.query("COMMIT");
      lowPositionClient.release();
      lowPositionClientReleased = true;

      await expect(store.readAll({ limit: 10 })).resolves.toEqual([
        expect.objectContaining({ streamId: "catalog.item-concurrent-low", globalPosition: "1" }),
        expect.objectContaining({ streamId: "catalog.item-concurrent-high", globalPosition: "2" }),
      ]);
    } finally {
      if (!lowPositionClientReleased) {
        await lowPositionClient.query("ROLLBACK").catch(() => undefined);
        lowPositionClient.release();
      }
      await highPositionAppend.catch(() => undefined);
    }
  });

  it("delivers every parallel distinct-stream append through paged catch-up", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });
    const workerCount = 16;
    let appendsSettled = false;
    const appends = Promise.all(
      Array.from({ length: workerCount }, (_, worker) =>
        store.appendToStream({
          streamId: `catalog.item-worker-${worker}` as never,
          expectedVersion: "no_stream",
          context: eventContext("tenant_a"),
          events: [eventToStore("catalog.item.created", { itemId: `worker-${worker}` })],
        }),
      ),
    ).finally(() => {
      appendsSettled = true;
    });
    const observedEventIds = new Set<string>();
    let checkpoint = "0";
    const pollCatchUp = async (): Promise<boolean> => {
      const page = await store.readAll({ afterGlobalPosition: checkpoint as never, limit: 3 });
      if (page.length === 0) {
        return false;
      }
      for (const event of page) {
        observedEventIds.add(event.eventId);
      }
      checkpoint = page.at(-1)!.globalPosition;
      return true;
    };

    while (!appendsSettled) {
      await pollCatchUp();
    }
    const appended = await appends;
    while (await pollCatchUp()) {
      // Drain every page committed after the last concurrent poll.
    }

    const expectedEventIds = new Set(appended.flat().map((event) => event.eventId));
    expect(observedEventIds).toEqual(expectedEventIds);
    expect(observedEventIds.size).toBe(workerCount);
  });

  it("commits sibling streams even when one stream conflicts in an independent multi-stream append", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-07-09T12:00:00.000Z" as never,
      createEventId,
    });

    await store.appendToStream({
      streamId: "marketplace.listing-lst_conflict",
      expectedVersion: "no_stream",
      context: eventContext("tenant_a"),
      events: [eventToStore("marketplace.listing.created", { listingId: "lst_conflict" })],
    });

    const results = await store.appendToStreamsIndependently!([
      {
        streamId: "marketplace.listing-lst_conflict",
        expectedVersion: 5, // stale -- real current version is 1
        context: eventContext("tenant_a"),
        events: [eventToStore("marketplace.listing.price-updated", { priceAmount: "9.99" })],
      },
      {
        streamId: "marketplace.listing-lst_sibling",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [eventToStore("marketplace.listing.created", { listingId: "lst_sibling" })],
      },
    ]);

    expect(results).toMatchObject([
      {
        streamId: "marketplace.listing-lst_conflict",
        outcome: "conflict",
        storedEvents: [],
        error: { code: "concurrency_conflict" },
      },
      { streamId: "marketplace.listing-lst_sibling", outcome: "appended" },
    ]);

    // The conflicting stream stays at its pre-batch version; the sibling committed.
    await expect(store.readStream({ streamId: "marketplace.listing-lst_conflict", limit: 10 })).resolves.toHaveLength(
      1,
    );
    await expect(store.readStream({ streamId: "marketplace.listing-lst_sibling", limit: 10 })).resolves.toHaveLength(1);
  });

  it("replays a deterministic independent append before rejecting its stale retry version", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });
    const input = {
      streamId: "marketplace.listing-lst_retry",
      expectedVersion: "no_stream" as const,
      context: eventContext("tenant_a"),
      events: [
        {
          ...eventToStore("marketplace.listing.price-updated", { priceAmount: "90.00" }),
          eventId: "repricing:round-1:product-1:lst_retry:price:0" as never,
        },
      ],
    };
    const [first] = await store.appendToStreamsIndependently!([input]);
    const [retry] = await store.appendToStreamsIndependently!([{ ...input, expectedVersion: 0 }]);

    expect(first).toMatchObject({ outcome: "appended", storedEvents: [{ streamVersion: 1 }] });
    expect(retry).toEqual(first);
    await expect(store.readStream({ streamId: input.streamId, limit: 10 })).resolves.toHaveLength(1);
  });

  it("appends every stream in a chunk through one multi-row INSERT with contiguous global positions", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-07-09T12:00:00.000Z" as never,
      createEventId,
    });

    const results = await store.appendToStreamsIndependently!([
      {
        streamId: "marketplace.listing-lst_chunk_1",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [eventToStore("marketplace.listing.created", { listingId: "lst_chunk_1" })],
      },
      {
        streamId: "marketplace.listing-lst_chunk_2",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [eventToStore("marketplace.listing.created", { listingId: "lst_chunk_2" })],
      },
      {
        streamId: "marketplace.listing-lst_chunk_3",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [eventToStore("marketplace.listing.created", { listingId: "lst_chunk_3" })],
      },
    ]);

    expect(results.every((result) => result.outcome === "appended")).toBe(true);

    const allEvents = await store.readAll({ limit: 10 });
    expect(allEvents.map((event) => event.globalPosition)).toEqual(["1", "2", "3"]);
    expect(allEvents.map((event) => event.streamId)).toEqual([
      "marketplace.listing-lst_chunk_1",
      "marketplace.listing-lst_chunk_2",
      "marketplace.listing-lst_chunk_3",
    ]);
    expect(allEvents.every((event) => event.streamVersion === 1)).toBe(true);

    // A single-append shape check: independent-append results carry the same StoredEvent shape.
    const single = await store.readStream({ streamId: "marketplace.listing-lst_chunk_1", limit: 10 });
    expect(results[0]?.storedEvents[0]).toEqual(single[0]);
  });

  it("acquires the shared append fence exactly once per independent-append chunk", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-07-09T12:00:00.000Z" as never,
      createEventId,
    });

    const lockClient = await beginGlobalAppendLock(schema.pool);
    let lockClientReleased = false;
    const chunkAppend = store.appendToStreamsIndependently!([
      {
        streamId: "marketplace.listing-lst_lock_1",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [eventToStore("marketplace.listing.created", { listingId: "lst_lock_1" })],
      },
      {
        streamId: "marketplace.listing-lst_lock_2",
        expectedVersion: "no_stream",
        context: eventContext("tenant_a"),
        events: [eventToStore("marketplace.listing.created", { listingId: "lst_lock_2" })],
      },
    ]);

    try {
      // The chunk's SELECT ... FOR UPDATE pre-checks can run before the shared
      // append fence, but the INSERT that finally commits the chunk cannot
      // proceed while another session holds the exclusive side.
      await expect(hasSettledWithin(chunkAppend, 50)).resolves.toBe(false);

      await lockClient.query("COMMIT");
      lockClient.release();
      lockClientReleased = true;

      const results = await chunkAppend;
      expect(results.every((result) => result.outcome === "appended")).toBe(true);
    } finally {
      if (!lockClientReleased) {
        await lockClient.query("ROLLBACK").catch(() => undefined);
        lockClient.release();
      }
    }
  });

  it("preserves projection-critical checkout and identity events through bulk appends", async () => {
    const store = createPostgresEventStore({
      pool: schema.pool,
      now: () => "2026-07-06T20:00:30.000Z" as never,
      createEventId,
    });
    await createProjectionRegressionTables(schema.pool);

    const checkoutEvents = createCheckoutProjectionEvents();
    const identityEvent = createIdentityConsentRecordedEvent();

    const appendedCheckoutEvents = await store.appendToStream({
      streamId: "checkout.session-chk_projection_poison",
      expectedVersion: "no_stream",
      context: eventContext("tenant_projection"),
      events: checkoutEvents,
    });
    const appendedIdentityEvents = await store.appendToStream({
      streamId: "identity.consent-cons_projection_poison",
      expectedVersion: "no_stream",
      context: eventContext("tenant_projection"),
      events: [identityEvent],
    });

    expect(appendedCheckoutEvents.map((event) => event.eventId)).toEqual([
      "evt_checkout_started",
      "evt_checkout_shipping_address_set",
      "evt_checkout_orders_created",
      "evt_checkout_payment_started",
    ]);
    expect(appendedCheckoutEvents.map((event) => event.streamVersion)).toEqual([1, 2, 3, 4]);
    expect(appendedCheckoutEvents.map((event) => event.globalPosition)).toEqual(["1", "2", "3", "4"]);
    expect(appendedIdentityEvents).toMatchObject([{ eventId: "evt_identity_consent_recorded", globalPosition: "5" }]);

    const storedEvents = await store.readAll({ limit: 20 });
    expect(
      storedEvents.map(({ eventId, eventType, streamVersion, globalPosition }) => ({
        eventId,
        eventType,
        streamVersion,
        globalPosition,
      })),
    ).toEqual([
      {
        eventId: "evt_checkout_started",
        eventType: "checkout.session.started",
        streamVersion: 1,
        globalPosition: "1",
      },
      {
        eventId: "evt_checkout_shipping_address_set",
        eventType: "checkout.session.shipping-address-set",
        streamVersion: 2,
        globalPosition: "2",
      },
      {
        eventId: "evt_checkout_orders_created",
        eventType: "checkout.session.orders-created",
        streamVersion: 3,
        globalPosition: "3",
      },
      {
        eventId: "evt_checkout_payment_started",
        eventType: "checkout.session.payment-started",
        streamVersion: 4,
        globalPosition: "4",
      },
      {
        eventId: "evt_identity_consent_recorded",
        eventType: "identity.consent.recorded",
        streamVersion: 1,
        globalPosition: "5",
      },
    ]);
    expect(storedEvents[0]).toMatchObject({
      payload: checkoutEvents[0].payload,
      metadata: checkoutEvents[0].metadata,
      occurredAt: "2026-07-06T20:00:00.000Z",
      recordedAt: "2026-07-06T20:00:30.000Z",
    });
    expect(storedEvents[3]).toMatchObject({
      payload: checkoutEvents[3].payload,
      metadata: checkoutEvents[3].metadata,
      occurredAt: "2026-07-06T20:00:15.000Z",
      recordedAt: "2026-07-06T20:00:30.000Z",
    });
    expect(storedEvents[4]).toMatchObject({
      payload: identityEvent.payload,
      metadata: identityEvent.metadata,
      occurredAt: "2026-07-06T20:01:00.000Z",
      recordedAt: "2026-07-06T20:00:30.000Z",
    });

    for (const event of storedEvents) {
      await applyProjectionRegressionEvent(schema.pool, event);
    }

    await expect(readCheckoutSessionProjectionRow(schema.pool, "chk_projection_poison")).resolves.toMatchObject({
      session_id: "chk_projection_poison",
      buyer_account_id: "acc_buyer_projection",
      source_type: "cart",
      optimization_goal: "lowest-total",
      shipping_option: "standard",
      shipping_address_id: "addr_projection",
      payment_id: "pay_projection",
      order_ids: ["ord_projection_1", "ord_projection_2"],
      order_write_commit_positions: ["17", "18"],
      updated_at_iso: "2026-07-06T20:00:15.000Z",
    });
    await expect(readIdentityConsentProjectionRow(schema.pool, "cons_projection_poison")).resolves.toMatchObject({
      consent_id: "cons_projection_poison",
      subject_type: "user",
      user_id: "user_projection",
      account_id: "account_projection",
      policy_key: "marketplace-terms",
      policy_version: "2026-07-06",
      recorded_at_iso: "2026-07-06T20:01:00.000Z",
      updated_at_iso: "2026-07-06T20:00:30.000Z",
    });
  });

  function createEventId() {
    return `evt_db_${nextEventId++}` as never;
  }
});

async function beginGlobalAppendLock(pool: IsolatedPostgresTestSchema["pool"]): Promise<PgPoolClient> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY]);
    return client;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release(error);
    throw error;
  }
}

async function beginUncommittedAppendWithSharedFence(
  pool: IsolatedPostgresTestSchema["pool"],
  event: Readonly<{ eventId: string; streamId: string; itemId: string }>,
): Promise<PgPoolClient> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock_shared($1::bigint)", [
      EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
    ]);
    await client.query(
      `INSERT INTO event_store_streams (stream_id, current_version, updated_at)
       VALUES ($1, 0, $2::timestamptz)`,
      [event.streamId, "2026-06-28T12:00:00.000Z"],
    );
    await client.query(
      `INSERT INTO event_store_events (
         event_id,
         stream_id,
         stream_version,
         tenant_id,
         stream_context_name,
         stream_category,
         event_type,
         payload,
         metadata,
         occurred_at,
         recorded_at,
         performed_by_user_id,
         for_account_id
       ) VALUES (
         $2,
         $3,
         1,
         'tenant_a',
         'catalog',
         'catalog.item',
         'catalog.item.created',
         jsonb_build_object('itemId', $4::text),
         '{}'::jsonb,
         $1::timestamptz,
         $1::timestamptz,
         'user_db_test',
         'account_db_test'
       )`,
      ["2026-06-28T12:00:00.000Z", event.eventId, event.streamId, event.itemId],
    );
    await client.query(
      `UPDATE event_store_streams
       SET current_version = 1, updated_at = $2::timestamptz
       WHERE stream_id = $1`,
      [event.streamId, "2026-06-28T12:00:00.000Z"],
    );

    return client;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release(error);
    throw error;
  }
}

async function appendRawEventWithSharedFence(
  pool: IsolatedPostgresTestSchema["pool"],
  event: Readonly<{ eventId: string; streamId: string; itemId: string }>,
): Promise<void> {
  const client = await beginUncommittedAppendWithSharedFence(pool, event);

  try {
    await client.query("COMMIT");
    client.release();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release(error);
    throw error;
  }
}

async function hasSettledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
}

function fulfilledResults<T>(results: readonly PromiseSettledResult<T>[]): T[] {
  return results
    .filter((result): result is PromiseFulfilledResult<T> => result.status === "fulfilled")
    .map((result) => result.value);
}

function rejectedResults<T>(results: readonly PromiseSettledResult<T>[]): unknown[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
}

function eventContext(tenantId: string): EventStoreContext {
  return {
    tenantId: tenantId as never,
    audit: {
      performedByUserId: "user_db_test" as never,
      forAccountId: "account_db_test" as never,
    },
  };
}

function eventToStore(eventType: string, payload: JsonObject) {
  return {
    eventType,
    payload,
  };
}

async function appendEvents(
  store: ReturnType<typeof createPostgresEventStore>,
  streamId: string,
  tenantId: string,
  events: readonly (readonly [eventType: string, payload: JsonObject])[],
): Promise<void> {
  await store.appendToStream({
    streamId,
    expectedVersion: "no_stream",
    context: eventContext(tenantId),
    events: events.map(([eventType, payload]) => eventToStore(eventType, payload)),
  });
}

async function createProjectionRegressionTables(pool: PgTransactionalPool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS checkout_session_pages;
    DROP TABLE IF EXISTS identity_consents;

    CREATE TABLE checkout_session_pages (
      session_id text PRIMARY KEY,
      buyer_account_id text NOT NULL,
      source_type text NOT NULL,
      optimization_goal text NOT NULL DEFAULT 'lowest-total',
      fulfillment_preview_revision text NULL,
      fulfillment_preview_snapshot jsonb NULL,
      cart_readiness_snapshot jsonb NULL,
      split_group_handoff jsonb NULL,
      shipping_option text NOT NULL,
      shipping_address_id text NULL,
      shipping_address jsonb NULL,
      lines jsonb NOT NULL DEFAULT '[]'::jsonb,
      order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      order_write_commit_positions jsonb NOT NULL DEFAULT '[]'::jsonb,
      payment_id text NULL,
      submitted_offer_id text NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );

    CREATE TABLE identity_consents (
      consent_id text PRIMARY KEY,
      subject_type text NOT NULL,
      user_id text NULL,
      account_id text NULL,
      policy_key text NOT NULL,
      policy_version text NOT NULL,
      recorded_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

function createCheckoutProjectionEvents() {
  return [
    {
      eventId: "evt_checkout_started" as never,
      eventType: "checkout.session.started",
      payload: {
        sessionId: "chk_projection_poison",
        buyerAccountId: "acc_buyer_projection",
        sourceType: "cart",
        optimizationGoal: "lowest-total",
        fulfillmentPreviewRevision: null,
        fulfillmentPreviewSnapshot: null,
        cartReadinessSnapshot: {
          schemaVersion: "checkout.cart-readiness.v1",
          source: "cart",
          status: "ready",
          snapshotId: "ready_projection",
          includedLineIds: ["cli_projection"],
          unresolvedLineIds: [],
          fulfillmentGroups: [
            {
              groupId: "grp_projection",
              lineIds: ["cli_projection"],
              listingIds: ["lst_projection"],
              sellerAccountId: "acc_seller_projection",
              downstreamReferenceStatus: "not-started",
            },
          ],
        },
        splitGroupHandoff: {
          status: "ready",
          supportReference: "CS-READY-PROJECTION",
          groups: [
            {
              groupId: "grp_projection",
              lineIds: ["cli_projection"],
              listingIds: ["lst_projection"],
              sellerAccountId: "acc_seller_projection",
              downstreamReferenceStatus: "not-started",
            },
          ],
        },
        shippingOption: "standard",
        lines: [
          {
            listingId: "lst_projection",
            cartLineId: "cli_projection",
            catalogItemId: "cat_projection",
            productId: "cat_projection::",
            itemTitle: "Projection Test Card",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            quantity: 1,
            fulfillmentMode: "locked-listing",
            lockedListingId: "lst_projection",
            sellerPreferenceId: null,
            availabilityState: "available",
          },
        ],
        createdAt: "2026-07-06T20:00:00.000Z",
      },
      metadata: { commandId: "cmd_checkout_projection", projectionRegression: true },
      occurredAt: "2026-07-06T20:00:00.000Z" as never,
    },
    {
      eventId: "evt_checkout_shipping_address_set" as never,
      eventType: "checkout.session.shipping-address-set",
      payload: {
        sessionId: "chk_projection_poison",
        shippingAddress: {
          shippingAddressId: "addr_projection",
          name: "Projection Buyer",
          line1: "1 Projection Way",
          line2: null,
          city: "Chicago",
          region: "IL",
          postalCode: "60601",
          country: "US",
        },
        selectedAt: "2026-07-06T20:00:05.000Z",
      },
      metadata: { commandId: "cmd_checkout_projection" },
      occurredAt: "2026-07-06T20:00:05.000Z" as never,
    },
    {
      eventId: "evt_checkout_orders_created" as never,
      eventType: "checkout.session.orders-created",
      payload: {
        sessionId: "chk_projection_poison",
        orderIds: ["ord_projection_1", "ord_projection_2"],
        orderWriteCommitPositions: ["17", "18"],
        recordedAt: "2026-07-06T20:00:10.000Z",
      },
      metadata: { commandId: "cmd_checkout_projection" },
      occurredAt: "2026-07-06T20:00:10.000Z" as never,
    },
    {
      eventId: "evt_checkout_payment_started" as never,
      eventType: "checkout.session.payment-started",
      payload: {
        sessionId: "chk_projection_poison",
        paymentId: "pay_projection",
        recordedAt: "2026-07-06T20:00:15.000Z",
      },
      metadata: { commandId: "cmd_checkout_projection" },
      occurredAt: "2026-07-06T20:00:15.000Z" as never,
    },
  ];
}

function createIdentityConsentRecordedEvent() {
  return {
    eventId: "evt_identity_consent_recorded" as never,
    eventType: "identity.consent.recorded",
    payload: {
      consentId: "cons_projection_poison",
      subjectType: "user",
      userId: "user_projection",
      accountId: "account_projection",
      policyKey: "marketplace-terms",
      policyVersion: "2026-07-06",
      recordedAt: "2026-07-06T20:01:00.000Z",
    },
    metadata: { commandId: "cmd_identity_projection", projectionRegression: true },
    occurredAt: "2026-07-06T20:01:00.000Z" as never,
  };
}

async function applyProjectionRegressionEvent(pool: PgTransactionalPool, storedEvent: StoredEvent): Promise<void> {
  const event = toTransportEvent(storedEvent);

  if (event.type.startsWith("checkout.session.")) {
    await applyCheckoutSessionProjectionEvent(pool, event);
    return;
  }

  if (event.type === "identity.consent.recorded") {
    await applyIdentityConsentProjectionEvent(pool, event);
  }
}

async function applyCheckoutSessionProjectionEvent(pool: PgTransactionalPool, event: TransportEvent): Promise<void> {
  if (event.type === "checkout.session.started") {
    const data = event.data as {
      sessionId: string;
      buyerAccountId: string;
      sourceType: string;
      optimizationGoal?: string;
      fulfillmentPreviewRevision?: string | null;
      fulfillmentPreviewSnapshot?: unknown;
      cartReadinessSnapshot?: unknown;
      splitGroupHandoff?: unknown;
      shippingOption: string;
      lines: unknown;
      createdAt: string;
    };

    await pool.query(
      `INSERT INTO checkout_session_pages (
         session_id,
         buyer_account_id,
         source_type,
         optimization_goal,
         fulfillment_preview_revision,
         fulfillment_preview_snapshot,
         cart_readiness_snapshot,
         split_group_handoff,
         shipping_option,
         shipping_address_id,
         shipping_address,
         lines,
         order_ids,
         order_write_commit_positions,
         payment_id,
         submitted_offer_id,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, $10, '[]'::jsonb, '[]'::jsonb, NULL, NULL, $11, $11)
       ON CONFLICT (session_id) DO UPDATE
       SET buyer_account_id = EXCLUDED.buyer_account_id,
           source_type = EXCLUDED.source_type,
           optimization_goal = EXCLUDED.optimization_goal,
           fulfillment_preview_revision = EXCLUDED.fulfillment_preview_revision,
           fulfillment_preview_snapshot = EXCLUDED.fulfillment_preview_snapshot,
           cart_readiness_snapshot = EXCLUDED.cart_readiness_snapshot,
           split_group_handoff = EXCLUDED.split_group_handoff,
           shipping_option = EXCLUDED.shipping_option,
           shipping_address_id = EXCLUDED.shipping_address_id,
           shipping_address = EXCLUDED.shipping_address,
           lines = EXCLUDED.lines,
           updated_at = EXCLUDED.updated_at`,
      [
        data.sessionId,
        data.buyerAccountId,
        data.sourceType,
        data.optimizationGoal === "fewest-shipments" ? "fewest-shipments" : "lowest-total",
        data.fulfillmentPreviewRevision ?? null,
        JSON.stringify(data.fulfillmentPreviewSnapshot ?? null),
        JSON.stringify(data.cartReadinessSnapshot ?? null),
        JSON.stringify(data.splitGroupHandoff ?? null),
        data.shippingOption,
        JSON.stringify(Array.isArray(data.lines) ? data.lines : []),
        data.createdAt,
      ],
    );
    return;
  }

  if (event.type === "checkout.session.shipping-address-set") {
    const data = event.data as {
      sessionId: string;
      shippingAddress: { shippingAddressId?: string | null } | null;
      selectedAt: string;
    };

    await pool.query(
      `UPDATE checkout_session_pages
       SET shipping_address_id = $2,
           shipping_address = $3,
           fulfillment_preview_revision = NULL,
           fulfillment_preview_snapshot = NULL,
           updated_at = $4
       WHERE session_id = $1`,
      [
        data.sessionId,
        data.shippingAddress?.shippingAddressId ?? null,
        JSON.stringify(data.shippingAddress),
        data.selectedAt,
      ],
    );
    return;
  }

  if (event.type === "checkout.session.orders-created") {
    const data = event.data as {
      sessionId: string;
      orderIds: string[];
      orderWriteCommitPositions?: unknown;
      recordedAt: string;
    };

    await pool.query(
      `UPDATE checkout_session_pages
       SET order_ids = $2,
           order_write_commit_positions = $3,
           updated_at = $4
       WHERE session_id = $1`,
      [
        data.sessionId,
        JSON.stringify(data.orderIds),
        JSON.stringify(Array.isArray(data.orderWriteCommitPositions) ? data.orderWriteCommitPositions : []),
        data.recordedAt,
      ],
    );
    return;
  }

  if (event.type === "checkout.session.payment-started") {
    const data = event.data as {
      sessionId: string;
      paymentId: string;
      recordedAt: string;
    };

    await pool.query(
      `UPDATE checkout_session_pages
       SET payment_id = $2,
           updated_at = $3
       WHERE session_id = $1`,
      [data.sessionId, data.paymentId, data.recordedAt],
    );
  }
}

async function applyIdentityConsentProjectionEvent(pool: PgTransactionalPool, event: TransportEvent): Promise<void> {
  const { consentId, subjectType, userId, accountId, policyKey, policyVersion, recordedAt } = event.data as {
    consentId: string;
    subjectType: string;
    userId: string | null;
    accountId: string | null;
    policyKey: string;
    policyVersion: string;
    recordedAt: string;
  };

  await pool.query(
    `INSERT INTO identity_consents (
       consent_id,
       subject_type,
       user_id,
       account_id,
       policy_key,
       policy_version,
       recorded_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (consent_id) DO UPDATE
     SET subject_type = $2,
         user_id = $3,
         account_id = $4,
         policy_key = $5,
         policy_version = $6,
         recorded_at = $7,
         updated_at = $8`,
    [consentId, subjectType, userId, accountId, policyKey, policyVersion, recordedAt, event.timing.recordedAt],
  );
}

async function readCheckoutSessionProjectionRow(pool: PgTransactionalPool, sessionId: string): Promise<JsonObject> {
  const result = await pool.query<JsonObject>(
    `SELECT
       session_id,
       buyer_account_id,
       source_type,
       optimization_goal,
       shipping_option,
       shipping_address_id,
       payment_id,
       order_ids,
       order_write_commit_positions,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_iso,
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_iso
     FROM checkout_session_pages
     WHERE session_id = $1`,
    [sessionId],
  );

  return result.rows[0] ?? {};
}

async function readIdentityConsentProjectionRow(pool: PgTransactionalPool, consentId: string): Promise<JsonObject> {
  const result = await pool.query<JsonObject>(
    `SELECT
       consent_id,
       subject_type,
       user_id,
       account_id,
       policy_key,
       policy_version,
       to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at_iso,
       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at_iso
     FROM identity_consents
     WHERE consent_id = $1`,
    [consentId],
  );

  return result.rows[0] ?? {};
}

function collectExplainIndexNames(plan: unknown): string[] {
  const names = new Set<string>();
  collectExplainIndexNamesInto(plan, names);
  return [...names].sort();
}

function collectExplainIndexNamesInto(plan: unknown, names: Set<string>): void {
  if (Array.isArray(plan)) {
    for (const entry of plan) {
      collectExplainIndexNamesInto(entry, names);
    }
    return;
  }

  if (!plan || typeof plan !== "object") {
    return;
  }

  const record = plan as Record<string, unknown>;
  if (typeof record["Index Name"] === "string") {
    names.add(record["Index Name"]);
  }

  for (const value of Object.values(record)) {
    collectExplainIndexNamesInto(value, names);
  }
}
