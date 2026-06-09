import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createCheckoutSessionRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_buyer" as never,
    forAccountId: "acc_buyer" as never,
  },
};

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
          traceId: input.context.trace?.traceId,
          spanId: input.context.trace?.spanId,
          parentSpanId: input.context.trace?.parentSpanId,
          traceState: input.context.trace?.traceState,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice((input.fromVersion ?? 1) - 1),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return { allEvents, eventStore };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

function createCartServices() {
  return {
    listCartLines: vi.fn(async () => [
      {
        buyer_account_id: "acc_buyer",
        line_id: "cli_1",
        catalog_catalog_item_id: "cat_1",
        product_id: "cat_1::",
        item_language_code: "en",
        item_title: "Charizard",
        item_subtitle: null,
        item_image_url: null,
        item_image_srcset: null,
        item_image_loading_url: null,
        item_image_loading_alt: null,
        item_image_loading_srcset: null,
        selected_options: [],
        product_summary: null,
        quantity: 1,
        fulfillment_mode: "optimize",
        locked_listing_id: null,
        seller_preference_id: null,
        availability_state: "available",
        seller_options: [],
        created_at: "2026-06-09T00:00:00.000Z",
        updated_at: "2026-06-09T00:00:00.000Z",
      },
    ]),
    removeLine: vi.fn(async () => ({ lineId: "cli_1" as never, version: 1 })),
    checkout: vi.fn(async () => ({ version: 1 })),
  };
}

describe("checkout session runtime", () => {
  it("keeps the session projection scoped to session streams with per-event checkpoints", () => {
    const { eventStore } = createInMemoryEventStore();
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [] })) },
      cart: createCartServices() as never,
    });

    expect(services.projectors[0]).toMatchObject({
      projectionName: "checkout.session-projection",
      streamPrefixes: ["checkout.session-"],
      checkpointBatchSize: 1,
    });
  });

  it("can update a just-created session before checkout_session_pages has projected it", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("checkout_session_pages")) {
          throw new Error("checkout_session_pages should not be read by command continuations");
        }
        return { rows: [] };
      }),
    };
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db,
      cart: createCartServices() as never,
    });

    const created = await services.createFromCart(
      {
        accountId: "acc_buyer" as never,
        shippingOption: "standard",
        sessionIdOverride: "chk_projection_lag" as never,
      },
      context,
    );
    const result = await services.selectShippingOption(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        shippingOption: "priority",
      },
      context,
    );

    expect(result.session.shipping_option).toBe("priority");
    expect(result.session.buyer_account_id).toBe("acc_buyer");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("can update a just-created Buy Now session before checkout_session_pages has projected it", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("checkout_session_pages")) {
          throw new Error("checkout_session_pages should not be read by Buy Now command continuations");
        }

        if (sql.includes("checkout_catalog_items")) {
          return {
            rows: [
              {
                catalog_item_id: "cat_1",
                status: "active",
                product_schema: null,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };
    const services = createCheckoutSessionRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db,
      cart: createCartServices() as never,
    });

    const created = await services.createBuyNow(
      {
        accountId: "acc_buyer" as never,
        listingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 1,
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_1",
        shippingOption: "standard",
        sessionIdOverride: "chk_buy_now_projection_lag" as never,
      },
      context,
    );
    const result = await services.selectShippingOption(
      {
        sessionId: created.sessionId,
        accountId: "acc_buyer" as never,
        shippingOption: "priority",
      },
      context,
    );

    expect(result.session.session_id).toBe("chk_buy_now_projection_lag");
    expect(result.session.source_type).toBe("buy-now");
    expect(result.session.shipping_option).toBe("priority");
    expect(result.session.payment_id).toBeNull();
    expect(result.session.order_ids).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String(db.query.mock.calls[0]?.[0])).toContain("checkout_catalog_items");
  });
});
