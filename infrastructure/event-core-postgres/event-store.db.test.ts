import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore } from "./event-store";
import { createIsolatedPostgresTestSchema, type IsolatedPostgresTestSchema } from "./postgres-db-test-support";

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

  function createEventId() {
    return `evt_db_${nextEventId++}` as never;
  }
});

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
