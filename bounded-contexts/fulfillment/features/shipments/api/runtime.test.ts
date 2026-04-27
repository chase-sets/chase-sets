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
import { createFulfillmentShipmentRuntime } from "./runtime";

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
          correlationId: input.context.trace?.correlationId,
          causationId: input.context.trace?.causationId,
          commandId: input.context.trace?.commandId,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice(input.fromVersion ?? 0),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return {
    eventStore,
    readAllEvents: () => allEvents,
  };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) =>
      checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

describe("fulfillment shipment runtime", () => {
  it("creates a shipment from a ready local order source", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return { rows: [] };
        }

        if (sql.includes("FROM fulfillment_order_sources")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                buyer_account_id: "acc_buyer",
                seller_account_id: "acc_seller",
                shipping_option: "standard",
                status: "ready-for-fulfillment",
              },
            ],
          };
        }

        if (sql.includes("FROM fulfillment_order_source_lines")) {
          return {
            rows: [
              {
                order_line_id: "oli_1",
                catalog_catalog_item_id: "cat_1",
                product_id: "cat_1::",
                item_title: "Charizard",
                item_subtitle: null,
                product_summary: null,
                quantity: 1,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };

    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
    });

    await services.createShipmentForReadyOrder({
      orderId: "ord_1",
      readyForFulfillmentAt: "2026-04-02T00:00:00.000Z",
      context: {
        tenantId: "tnt_test" as never,
        audit: {
          performedByUserId: "usr_test" as never,
          forAccountId: "acc_buyer" as never,
        },
      },
    });

    const createdEvent = readAllEvents().find(
      (event) => event.eventType === "fulfillment.shipment.created",
    );

    expect(createdEvent?.payload).toMatchObject({
      orderId: "ord_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      shippingOption: "standard",
    });
  });
});
