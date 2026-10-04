import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { module as catalogModule } from "@chase-sets/catalog";
import { module as channelsModule } from "@chase-sets/channels";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { createId } from "@chase-sets/primitives/typed-ids";

const memoryStores = vi.hoisted(() => new WeakMap<object, ReturnType<typeof createInMemoryEventStore>>());
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/event-core-postgres")>();
  return {
    ...actual,
    createPostgresEventStore: (
      options: Parameters<typeof actual.createPostgresEventStore>[0],
    ): ReturnType<typeof actual.createPostgresEventStore> => {
      const memory = memoryStores.get(options.pool)?.eventStore;
      if (!memory) throw new Error("Synthetic composition requires an in-memory event store");
      return {
        ...memory,
        readStreamInTransaction: (_client, input) => memory.readStream(input),
        appendToStreamInTransaction: (_client, input) => memory.appendToStream(input),
      };
    },
  };
});

afterEach(() => vi.restoreAllMocks());

type QueryCall = Readonly<{ sql: string; values: readonly unknown[] }>;

function memoryPool(store: ReturnType<typeof createInMemoryEventStore>, query: PgQueryable["query"]): PgTransactionalPool {
  const pool = { query, connect: async () => ({ query, release: () => {} }) };
  memoryStores.set(pool, store);
  return pool;
}

function recordingPool() {
  const calls: QueryCall[] = [];
  const query: PgQueryable["query"] = async (sql, values = []) => {
    calls.push({ sql, values });
    return { rows: [], rowCount: 1 };
  };
  return { pool: memoryPool(createInMemoryEventStore(), query), calls };
}

describe("Catalog category producer-consumer contract", () => {
  it("routes a real Catalog category assignment to both Channels and Marketplace item/category bindings", async () => {
    const itemId = createId("cat");
    const categoryId = createId("ctg");
    const context: EventStoreContext = {
      tenantId: "tnt_synthetic",
      audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
    };
    const store = createInMemoryEventStore();
    const catalog = catalogModule.createServices(
      memoryPool(store, async () => {
        throw new Error("Catalog category composition must not access a database");
      }),
      {},
    );
    const commandHandler = vi.spyOn(catalog.items, "commandHandler");
    const api = catalogModule.buildApis(catalog).find((entry) => entry.mountPath === "/api/catalog");
    if (!api) throw new Error("Public Catalog API is missing");
    const app = new Hono<{ Variables: { context: EventStoreContext } }>();
    app.use("*", async (c, next) => {
      c.set("context", context);
      await next();
    });
    app.route(api.mountPath, api.router);

    const created = await app.request("/api/catalog/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId, languageCode: "en", title: "Synthetic category contract item" }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(store.allEvents).toHaveLength(1);
    expect(store.allEvents[0]?.eventType).toBe("catalog.catalog-item.created");
    commandHandler.mockClear();

    const assigned = await app.request(`/api/catalog/items/${itemId}/categories/${categoryId}`, { method: "POST" });
    expect(assigned.status, await assigned.clone().text()).toBe(201);
    expect(commandHandler).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ command: { type: "AssignCatalogItemToCategory", categoryId }, context }),
    );
    expect(store.allEvents).toHaveLength(2);
    const stored = store.allEvents[1];
    if (!stored) throw new Error("Catalog category assignment emitted no stored event");
    expect(stored.eventType).toBe("catalog.catalog-item.category-assigned");
    const event = toTransportEvent(stored);

    const channelsDb = recordingPool();
    const channels = channelsModule.createServices(channelsDb.pool, {
      channelSaleRecorder: async () => {
        throw new Error("Category projection must not record an external sale");
      },
    });
    const marketplaceDb = recordingPool();
    const marketplace = marketplaceModule.createServices(marketplaceDb.pool, {});
    const consumers = [
      {
        subscriptions: channelsModule.buildSubscriptions?.(channels),
        projectionName: "channel-catalog-publication-facts",
        calls: channelsDb.calls,
        sql: "INSERT INTO channels_catalog_item_category_facts",
        values: [itemId, categoryId, true, event.timing.recordedAt, event.streamVersion],
      },
      {
        subscriptions: marketplaceModule.buildSubscriptions?.(marketplace),
        projectionName: "marketplace-catalog-item-projection",
        calls: marketplaceDb.calls,
        sql: "UPDATE marketplace_catalog_items",
        values: [itemId, categoryId, event.timing.recordedAt],
      },
    ];
    for (const consumer of consumers) {
      const subscription = consumer.subscriptions?.find((entry) => entry.projectionName === consumer.projectionName);
      const handler = subscription?.handlers[stored.eventType];
      if (!handler) throw new Error(`${consumer.projectionName} has no category-assigned subscription handler`);
      await handler(event);
      expect(consumer.calls, consumer.projectionName).toHaveLength(1);
      expect(consumer.calls[0]?.sql, consumer.projectionName).toContain(consumer.sql);
      expect(consumer.calls[0]?.values, consumer.projectionName).toEqual(consumer.values);
    }
  });
});
