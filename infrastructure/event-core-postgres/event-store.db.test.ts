import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY, createPostgresEventStore } from "./event-store";
import { createIsolatedPostgresTestSchema, type IsolatedPostgresTestSchema } from "./postgres-db-test-support";
import { withPgTransaction, type PgPoolClient, type PgTransactionalPool } from "./types";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
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

  it("does not expose a later committed append while a lower global position is in flight", async () => {
    const store = createPostgresEventStore({ pool: schema.pool, createEventId });
    const lowPositionClient = await beginUncommittedAppendWithGlobalLock(schema.pool);
    let lowPositionClientReleased = false;

    const appendHighPosition = store.appendToStream({
      streamId: "catalog.item-high",
      expectedVersion: "no_stream",
      context: eventContext("tenant_a"),
      events: [eventToStore("catalog.item.created", { itemId: "high" })],
    });

    try {
      await expect(hasSettledWithin(appendHighPosition, 50)).resolves.toBe(false);
      await expect(store.readAll({ limit: 10 })).resolves.toEqual([]);

      await lowPositionClient.query("COMMIT");
      lowPositionClient.release();
      lowPositionClientReleased = true;

      await expect(appendHighPosition).resolves.toEqual([
        expect.objectContaining({
          streamId: "catalog.item-high",
          globalPosition: "2",
        }),
      ]);
      await expect(store.readAll({ limit: 10 })).resolves.toEqual([
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
    } finally {
      if (!lowPositionClientReleased) {
        await lowPositionClient.query("ROLLBACK").catch(() => undefined);
        lowPositionClient.release();
      }
    }
  });

  function createEventId() {
    return `evt_db_${nextEventId++}` as never;
  }
});

async function beginUncommittedAppendWithGlobalLock(pool: IsolatedPostgresTestSchema["pool"]): Promise<PgPoolClient> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY]);
    await client.query(
      `INSERT INTO event_store_streams (stream_id, current_version, updated_at)
       VALUES ('catalog.item-low', 0, $1::timestamptz)`,
      ["2026-06-28T12:00:00.000Z"],
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
         'evt_db_low',
         'catalog.item-low',
         1,
         'tenant_a',
         'catalog',
         'catalog.item',
         'catalog.item.created',
         '{"itemId":"low"}'::jsonb,
         '{}'::jsonb,
         $1::timestamptz,
         $1::timestamptz,
         'user_db_test',
         'account_db_test'
       )`,
      ["2026-06-28T12:00:00.000Z"],
    );
    await client.query(
      `UPDATE event_store_streams
       SET current_version = 1, updated_at = $2::timestamptz
       WHERE stream_id = $1`,
      ["catalog.item-low", "2026-06-28T12:00:00.000Z"],
    );

    return client;
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
