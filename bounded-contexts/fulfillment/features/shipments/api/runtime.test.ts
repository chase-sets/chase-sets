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
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
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

  it("purchases USPS postage through a sandbox-compatible provider", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const postageLabelProvider: PostageLabelProvider = {
      providerName: "sandbox-usps",
      providerMode: "test",
      purchaseUspsLabel: vi.fn(async () => ({
        providerName: "sandbox-usps",
        providerMode: "test",
        providerShipmentId: "sandbox_shipment_1",
        providerLabelId: "sandbox_label_1",
        providerRateId: "sandbox_rate_1",
        carrierName: "USPS",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
        labelReference: "sandbox_label_1",
        labelDocumentUrl: "https://sandbox.test/label.pdf",
        trackingIdentifier: "940000000000000000",
        postageAmountCents: 499,
        postageCurrency: "USD",
        purchasedAt: "2026-04-02T00:10:00.000Z",
      })),
      voidLabel: vi.fn(async () => ({
        providerName: "sandbox-usps",
        providerMode: "test",
        refundReference: "sandbox_refund_1",
        refundStatus: "submitted",
        voidedAt: "2026-04-02T00:15:00.000Z",
      })),
    };
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM fulfillment_shipment_pages")) {
          return {
            rows: [
              {
                shipment_id: "shp_1",
                order_id: "ord_1",
                seller_account_id: "acc_seller",
                status: "awaiting-label",
                package_status: "packed",
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
      postageLabelProvider,
    });
    const context = {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_seller" as never,
      },
    };

    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "CreateShipment",
        shipmentId: "shp_1" as never,
        orderId: "ord_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        lines: [
          {
            lineId: "spl_1" as never,
            orderLineId: "oli_1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            productSummary: null,
            quantity: 1,
          },
        ],
        createdAt: "2026-04-02T00:00:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_1",
      command: {
        type: "PrepareShipmentPackage",
        packageCount: 1,
        preparedAt: "2026-04-02T00:05:00.000Z",
      },
      context,
    });

    await services.purchaseUspsLabel(
      {
        shipmentId: "shp_1",
        sellerAccountId: "acc_seller",
        serviceLevel: "USPS_GROUND_ADVANTAGE",
        sender: {
          name: "Seller",
          street1: "1 Main St",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
        },
        recipient: {
          name: "Buyer",
          street1: "2 Market St",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
        package: {
          lengthInches: 7,
          widthInches: 5,
          heightInches: 1,
          weightOunces: 4,
        },
      },
      context,
    );

    const attachedEvent = readAllEvents().find(
      (event) => event.eventType === "fulfillment.shipment.label-attached",
    );
    expect(attachedEvent?.payload).toMatchObject({
      carrierName: "USPS",
      labelDocumentUrl: "https://sandbox.test/label.pdf",
      trackingIdentifier: "940000000000000000",
      postageProviderName: "sandbox-usps",
      postageProviderMode: "test",
    });
  });
});
