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
import { createOrderingOrderRuntime } from "./runtime";

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

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_buyer" as never,
  },
};

describe("ordering order runtime", () => {
  it("rejects checkout when active supply is insufficient", async () => {
    const { eventStore } = createInMemoryEventStore();
    const carts = {
      listCartLines: vi.fn(async () => [
        {
          buyer_account_id: "acc_buyer",
          line_id: "cli_1",
          catalog_item_id: "cat_1",
          item_title: "Charizard",
          item_subtitle: null,
          version_selection: [],
          version_summary: null,
          quantity: 2,
          created_at: "2026-03-31T00:00:00.000Z",
          updated_at: "2026-03-31T00:00:00.000Z",
        },
      ]),
      checkout: vi.fn(async () => ({ version: 1 })),
    };

    const services = createOrderingOrderRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: {} as never,
      carts: carts as never,
      supplyResolver: {
        resolveCandidates: async () => [
          {
            listingId: "lst_1",
            sellerAccountId: "acc_seller" as never,
            inventoryRecordId: "inv_1",
            catalogItemId: "cat_1",
            itemTitle: "Charizard",
            itemSubtitle: null,
            versionSelection: [],
            versionSummary: null,
            condition: "NM",
            storageLocationName: "North shelf",
            shipFromCode: "CHI",
            priceAmount: "10.00",
            availableQuantity: 1,
            updatedAt: "2026-03-31T00:00:00.000Z",
          },
        ],
      },
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
      },
      inventoryReservations: {
        createReservation: async () => {
          throw new Error("should not reserve inventory");
        },
        releaseReservation: async () => {},
      },
    });

    await expect(
      services.checkoutCart(
        { buyerAccountId: "acc_buyer" as never, shippingOption: "standard" },
        context,
      ),
    ).rejects.toThrow("Not enough active supply is available for Charizard.");
  });

  it("chooses the lowest total buyer cost, not just the lowest unit price", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const carts = {
      listCartLines: vi.fn(async () => [
        {
          buyer_account_id: "acc_buyer",
          line_id: "cli_1",
          catalog_item_id: "cat_1",
          item_title: "Charizard",
          item_subtitle: null,
          version_selection: [],
          version_summary: null,
          quantity: 1,
          created_at: "2026-03-31T00:00:00.000Z",
          updated_at: "2026-03-31T00:00:00.000Z",
        },
        {
          buyer_account_id: "acc_buyer",
          line_id: "cli_2",
          catalog_item_id: "cat_2",
          item_title: "Blastoise",
          item_subtitle: null,
          version_selection: [],
          version_summary: null,
          quantity: 1,
          created_at: "2026-03-31T00:00:00.000Z",
          updated_at: "2026-03-31T00:00:00.000Z",
        },
      ]),
      checkout: vi.fn(async () => ({ version: 1 })),
    };
    const createReservation = vi.fn(async ({ sellerAccountId, inventoryRecordId, quantity }) => ({
      holdId: `hld_${inventoryRecordId}`,
      inventoryRecordId,
      sellerAccountId,
      quantity,
    }));

    const services = createOrderingOrderRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: {} as never,
      carts: carts as never,
      supplyResolver: {
        resolveCandidates: async (demand) => {
          if (demand.catalogItemId === "cat_1") {
            return [
              {
                listingId: "lst_a1",
                sellerAccountId: "acc_split_a" as never,
                inventoryRecordId: "inv_a1",
                catalogItemId: "cat_1",
                itemTitle: "Charizard",
                itemSubtitle: null,
                versionSelection: [],
                versionSummary: null,
                condition: "NM",
                storageLocationName: "A",
                shipFromCode: "A",
                priceAmount: "5.00",
                availableQuantity: 1,
                updatedAt: "2026-03-31T00:00:00.000Z",
              },
              {
                listingId: "lst_b1",
                sellerAccountId: "acc_single" as never,
                inventoryRecordId: "inv_b1",
                catalogItemId: "cat_1",
                itemTitle: "Charizard",
                itemSubtitle: null,
                versionSelection: [],
                versionSummary: null,
                condition: "NM",
                storageLocationName: "B",
                shipFromCode: "B",
                priceAmount: "5.50",
                availableQuantity: 1,
                updatedAt: "2026-03-31T00:00:00.000Z",
              },
            ];
          }

          return [
            {
              listingId: "lst_c1",
              sellerAccountId: "acc_split_c" as never,
              inventoryRecordId: "inv_c1",
              catalogItemId: "cat_2",
              itemTitle: "Blastoise",
              itemSubtitle: null,
              versionSelection: [],
              versionSummary: null,
              condition: "NM",
              storageLocationName: "C",
              shipFromCode: "C",
              priceAmount: "5.00",
              availableQuantity: 1,
              updatedAt: "2026-03-31T00:00:00.000Z",
            },
            {
              listingId: "lst_b2",
              sellerAccountId: "acc_single" as never,
              inventoryRecordId: "inv_b2",
              catalogItemId: "cat_2",
              itemTitle: "Blastoise",
              itemSubtitle: null,
              versionSelection: [],
              versionSummary: null,
              condition: "NM",
              storageLocationName: "B",
              shipFromCode: "B",
              priceAmount: "5.50",
              availableQuantity: 1,
              updatedAt: "2026-03-31T00:00:00.000Z",
            },
          ];
        },
      },
      shippingQuotePolicy: {
        quote: ({ itemSubtotalAmount }) => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount:
            Number(itemSubtotalAmount) >= 11 ? "4.99" : "7.99",
        }),
      },
      inventoryReservations: {
        createReservation,
        releaseReservation: async () => {},
      },
    });

    const result = await services.checkoutCart(
      { buyerAccountId: "acc_buyer" as never, shippingOption: "standard" },
      context,
    );

    expect(result.orderIds).toHaveLength(1);
    expect(createReservation).toHaveBeenCalledTimes(2);
    expect(createReservation.mock.calls.every((call) => call[0].sellerAccountId === "acc_single"))
      .toBe(true);

    const createdEvent = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(createdEvent?.payload).toMatchObject({
      sellerAccountId: "acc_single",
      itemSubtotalAmount: "11.00",
      totalAmount: "15.99",
    });
    expect(carts.checkout).toHaveBeenCalled();
  });

  it("constrains accepted-offer commitments to the accepting seller", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const resolveCandidates = vi.fn(async (demand) => {
      expect(demand.sellerAccountId).toBe("acc_seller");
      return [
        {
          listingId: "lst_1",
          sellerAccountId: "acc_seller" as never,
          inventoryRecordId: "inv_1",
          catalogItemId: "cat_1",
          itemTitle: "Charizard",
          itemSubtitle: null,
          versionSelection: [],
          versionSummary: null,
          condition: "NM",
          storageLocationName: "North shelf",
          shipFromCode: "CHI",
          priceAmount: "99.00",
          availableQuantity: 1,
          updatedAt: "2026-03-31T00:00:00.000Z",
        },
      ];
    });

    const services = createOrderingOrderRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: {} as never,
      carts: {
        listCartLines: async () => [],
        checkout: async () => ({ version: 1 }),
      } as never,
      supplyResolver: { resolveCandidates },
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
      },
      inventoryReservations: {
        createReservation: async ({ sellerAccountId, inventoryRecordId, quantity }) => ({
          holdId: "hld_1",
          inventoryRecordId,
          sellerAccountId,
          quantity,
        }),
        releaseReservation: async () => {},
      },
    });

    await services.createOrdersFromAcceptedOffer(
      {
        offerId: "off_1",
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        catalogItemId: "cat_1",
        itemTitle: "Charizard",
        itemSubtitle: null,
        versionSelection: [],
        versionSummary: null,
        priceAmount: "10.00",
        quantityRequested: 1,
      },
      context,
    );

    expect(resolveCandidates).toHaveBeenCalledTimes(1);
    const createdEvent = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(createdEvent?.payload).toMatchObject({
      sourceType: "offer-acceptance",
      sourceReferenceId: "off_1",
      sellerAccountId: "acc_seller",
    });
  });

  it("releases inventory reservations when a buyer cancels a pending order", async () => {
    const { eventStore } = createInMemoryEventStore();
    const releaseReservation = vi.fn(async () => {});

    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM ordering_order_pages")) {
          return {
            rows: [
              {
                order_id: "ord_1",
                source_type: "cart-checkout",
                source_reference_id: null,
                buyer_account_id: "acc_buyer",
                buyer_display_name: "Buyer",
                seller_account_id: "acc_seller",
                seller_display_name: "Seller",
                shipping_option: "standard",
                item_subtotal_amount: "20.00",
                shipping_base_amount: "4.99",
                shipping_discount_amount: "0.00",
                shipping_charge_amount: "4.99",
                total_amount: "24.99",
                status: "pending-payment",
                created_at: "2026-03-31T00:00:00.000Z",
                updated_at: "2026-03-31T00:00:00.000Z",
                cancelled_at: null,
                line_count: 1,
                total_quantity: 1,
              },
            ],
          };
        }

        if (sql.includes("FROM ordering_order_line_pages")) {
          return {
            rows: [],
          };
        }

        if (sql.includes("FROM ordering_order_hold_pages")) {
          return {
            rows: [
              {
                hold_id: "hld_1",
                inventory_record_id: "inv_1",
                seller_account_id: "acc_seller",
                quantity: 1,
                status: "active",
                created_at: "2026-03-31T00:00:00.000Z",
                released_at: null,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };

    const services = createOrderingOrderRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      carts: {
        listCartLines: async () => [],
        checkout: async () => ({ version: 1 }),
      } as never,
      supplyResolver: {
        resolveCandidates: async () => [],
      },
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
      },
      inventoryReservations: {
        createReservation: async ({ sellerAccountId, inventoryRecordId, quantity }) => ({
          holdId: "hld_1",
          inventoryRecordId,
          sellerAccountId,
          quantity,
        }),
        releaseReservation,
      },
    });

    await services.commandHandler({
      streamId: "ordering.order-ord_1",
      command: {
        type: "CreateOrder",
        orderId: "ord_1" as never,
        sourceType: "cart-checkout",
        sourceReferenceId: null,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        itemSubtotalAmount: "20.00",
        shippingBaseAmount: "4.99",
        shippingDiscountAmount: "0.00",
        shippingChargeAmount: "4.99",
        totalAmount: "24.99",
        lines: [
          {
            lineId: "oli_1" as never,
            listingId: "lst_1",
            inventoryRecordId: "inv_1",
            catalogItemId: "cat_1",
            itemTitle: "Charizard",
            itemSubtitle: null,
            versionSelection: [],
            versionSummary: null,
            condition: "NM",
            unitPriceAmount: "20.00",
            quantity: 1,
            lineTotalAmount: "20.00",
          },
        ],
        inventoryReservations: [
          {
            holdId: "hld_1",
            inventoryRecordId: "inv_1",
            sellerAccountId: "acc_seller",
            quantity: 1,
          },
        ],
      },
      context,
    });

    await services.cancelBuyerOrder(
      { orderId: "ord_1", buyerAccountId: "acc_buyer" },
      context,
    );

    expect(releaseReservation).toHaveBeenCalledWith({
      sellerAccountId: "acc_seller",
      holdId: "hld_1",
      context,
    });
  });
});
