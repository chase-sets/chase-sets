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

const commercialTermsResolver = {
  resolveListingTerms: vi.fn(async ({ sellerAccountId, amount }) => ({
    sellerAccountId,
    accountType: "business" as const,
    basisAmount: amount,
    marketplaceFeeAmount: "1.00",
    paymentFeeAmount: "0.50",
    sellerNetAmount: "18.50",
    scheduleId: "cts_default",
    agreementId: null,
    resolvedAt: "2026-03-31T00:00:00.000Z",
  })),
  resolveOrderTerms: vi.fn(async ({ sellerAccountId, amount }) => ({
    sellerAccountId,
    accountType: "business" as const,
    basisAmount: amount,
    marketplaceFeeAmount: "1.00",
    paymentFeeAmount: "0.50",
    sellerNetAmount: "18.50",
    scheduleId: "cts_default",
    agreementId: null,
    resolvedAt: "2026-03-31T00:00:00.000Z",
  })),
};

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_buyer" as never,
  },
};

type SupplyCandidate = Readonly<{
  listingId: string;
  sellerAccountId: string;
  inventoryRecordId: string;
  catalogItemId: string;
  catalogVersionKey: string;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: readonly unknown[];
  versionSummary: string | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  priceAmount: string;
  availableQuantity: number;
  updatedAt: string;
}>;

function createSupplyDb(
  resolver: (params: readonly unknown[] | undefined) => readonly SupplyCandidate[],
) {
  return {
    query: vi.fn(async (_sql: string, params?: readonly unknown[]) => ({
      rows: resolver(params).map((candidate) => ({
        listing_id: candidate.listingId,
        seller_account_id: candidate.sellerAccountId,
        inventory_record_id: candidate.inventoryRecordId,
        catalog_item_id: candidate.catalogItemId,
        catalog_version_key: candidate.catalogVersionKey,
        item_title: candidate.itemTitle,
        item_subtitle: candidate.itemSubtitle,
        version_selection: candidate.versionSelection,
        version_summary: candidate.versionSummary,
        storage_location_name: candidate.storageLocationName,
        ship_from_code: candidate.shipFromCode,
        price_amount: candidate.priceAmount,
        available_quantity: candidate.availableQuantity,
        updated_at: candidate.updatedAt,
      })),
    })),
  };
}

describe("ordering order runtime", () => {
  it("rejects checkout when active supply is insufficient", async () => {
    const { eventStore } = createInMemoryEventStore();
    const carts = {
      listCartLines: vi.fn(async () => [
        {
          buyer_account_id: "acc_buyer",
          line_id: "cli_1",
          catalog_item_id: "cat_1",
          catalog_version_key: "cat_1::",
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
    const db = createSupplyDb(() => [
      {
        listingId: "lst_1",
        sellerAccountId: "acc_seller",
        inventoryRecordId: "inv_1",
        catalogItemId: "cat_1",
        catalogVersionKey: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        versionSelection: [],
        versionSummary: null,
        storageLocationName: "North shelf",
        shipFromCode: "CHI",
        priceAmount: "10.00",
        availableQuantity: 1,
        updatedAt: "2026-03-31T00:00:00.000Z",
      },
    ]);

    const services = createOrderingOrderRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      carts: carts as never,
      commercialTermsResolver,
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
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
          catalog_version_key: "cat_1::",
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
          catalog_version_key: "cat_2::",
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
    const db = createSupplyDb((params) => {
      const catalogVersionKey = String(params?.[0] ?? "");

      if (catalogVersionKey === "cat_1::") {
        return [
          {
            listingId: "lst_a1",
            sellerAccountId: "acc_split_a",
            inventoryRecordId: "inv_a1",
            catalogItemId: "cat_1",
            catalogVersionKey: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            versionSelection: [],
            versionSummary: null,
            storageLocationName: "A",
            shipFromCode: "A",
            priceAmount: "5.00",
            availableQuantity: 1,
            updatedAt: "2026-03-31T00:00:00.000Z",
          },
          {
            listingId: "lst_b1",
            sellerAccountId: "acc_single",
            inventoryRecordId: "inv_b1",
            catalogItemId: "cat_1",
            catalogVersionKey: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            versionSelection: [],
            versionSummary: null,
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
          sellerAccountId: "acc_split_c",
          inventoryRecordId: "inv_c1",
          catalogItemId: "cat_2",
          catalogVersionKey: "cat_2::",
          itemTitle: "Blastoise",
          itemSubtitle: null,
          versionSelection: [],
          versionSummary: null,
          storageLocationName: "C",
          shipFromCode: "C",
          priceAmount: "5.00",
          availableQuantity: 1,
          updatedAt: "2026-03-31T00:00:00.000Z",
        },
        {
          listingId: "lst_b2",
          sellerAccountId: "acc_single",
          inventoryRecordId: "inv_b2",
          catalogItemId: "cat_2",
          catalogVersionKey: "cat_2::",
          itemTitle: "Blastoise",
          itemSubtitle: null,
          versionSelection: [],
          versionSummary: null,
          storageLocationName: "B",
          shipFromCode: "B",
          priceAmount: "5.50",
          availableQuantity: 1,
          updatedAt: "2026-03-31T00:00:00.000Z",
        },
      ];
    });

    const services = createOrderingOrderRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      carts: carts as never,
      commercialTermsResolver,
      shippingQuotePolicy: {
        quote: ({ itemSubtotalAmount }) => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount:
            Number(itemSubtotalAmount) >= 11 ? "4.99" : "7.99",
        }),
      },
    });

    const result = await services.checkoutCart(
      { buyerAccountId: "acc_buyer" as never, shippingOption: "standard" },
      context,
    );

    expect(result.orderIds).toHaveLength(1);

    const createdEvent = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(createdEvent?.payload).toMatchObject({
      sellerAccountId: "acc_single",
      itemSubtotalAmount: "11.00",
      totalAmount: "15.99",
      reservationRequests: [
        expect.objectContaining({
          sellerAccountId: "acc_single",
          inventoryRecordId: "inv_b1",
          quantity: 1,
        }),
        expect.objectContaining({
          sellerAccountId: "acc_single",
          inventoryRecordId: "inv_b2",
          quantity: 1,
        }),
      ],
    });
    expect(carts.checkout).toHaveBeenCalled();
  });

  it("constrains accepted-offer commitments to the accepting seller", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = createSupplyDb((params) => {
      expect(params?.[1]).toBe("acc_seller");
      return [
        {
          listingId: "lst_1",
          sellerAccountId: "acc_seller",
          inventoryRecordId: "inv_1",
          catalogItemId: "cat_1",
          catalogVersionKey: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          versionSelection: [],
          versionSummary: null,
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
      db: db as never,
      carts: {
        listCartLines: async () => [],
        checkout: async () => ({ version: 1 }),
      } as never,
      commercialTermsResolver,
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
      },
    });

    await services.createOrdersFromAcceptedOffer(
      {
        offerId: "off_1",
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        catalogItemId: "cat_1",
        catalogVersionKey: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        versionSelection: [],
        versionSummary: null,
        priceAmount: "10.00",
        quantityRequested: 1,
      },
      context,
    );

    expect(db.query).toHaveBeenCalledTimes(1);
    const createdEvent = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(createdEvent?.payload).toMatchObject({
      sourceType: "offer-acceptance",
      sourceReferenceId: "off_1",
      sellerAccountId: "acc_seller",
    });
  });

  it("releases inventory reservations when a buyer cancels a pending order", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();

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
                marketplace_fee_amount: "1.00",
                payment_fee_amount: "0.50",
                seller_net_amount: "18.50",
                terms_schedule_id: "cts_default",
                terms_agreement_id: null,
                terms_resolved_at: "2026-03-31T00:00:00.000Z",
                status: "pending-payment",
                created_at: "2026-03-31T00:00:00.000Z",
                updated_at: "2026-03-31T00:00:00.000Z",
                cancelled_at: null,
                cancellation_reason: null,
                ready_for_fulfillment_at: null,
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
      commercialTermsResolver,
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
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
        commercialTermsSnapshot: {
          marketplaceFeeAmount: "1.00",
          paymentFeeAmount: "0.50",
          sellerNetAmount: "18.50",
          termsScheduleId: "cts_default",
          termsAgreementId: null,
          termsResolvedAt: "2026-03-31T00:00:00.000Z",
        },
        lines: [
          {
            lineId: "oli_1" as never,
            listingId: "lst_1",
            inventoryRecordId: "inv_1",
            catalogItemId: "cat_1",
            catalogVersionKey: "cat_1::" as never,
            itemTitle: "Charizard",
            itemSubtitle: null,
            versionSelection: [],
            versionSummary: null,
            unitPriceAmount: "20.00",
            quantity: 1,
            lineTotalAmount: "20.00",
          },
        ],
        reservationRequests: [
          {
            reservationRequestId: "rsv_1",
            inventoryRecordId: "inv_1",
            sellerAccountId: "acc_seller",
            quantity: 1,
          },
        ],
      },
      context,
    });
    await services.commandHandler({
      streamId: "ordering.order-ord_1",
      command: {
        type: "RecordReservationConfirmed",
        reservationRequestId: "rsv_1",
        holdId: "hld_1",
        confirmedAt: "2026-03-31T00:00:00.000Z",
      },
      context,
    });

    await services.cancelBuyerOrder(
      { orderId: "ord_1", buyerAccountId: "acc_buyer" },
      context,
    );

    const cancellationEvent = readAllEvents().find(
      (event) => event.eventType === "ordering.order.cancelled",
    );
    expect(cancellationEvent?.payload).toMatchObject({
      reason: "buyer-cancelled",
      reservationRequests: [
        expect.objectContaining({
          reservationRequestId: "rsv_1",
          holdId: "hld_1",
          status: "confirmed",
        }),
      ],
    });
  });
});
