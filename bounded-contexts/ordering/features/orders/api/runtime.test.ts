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

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_buyer" as never,
  },
};

const shippingAddress = {
  name: "Jane Smith",
  company: null,
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: null,
  email: "jane@example.com",
} as const;

const shipFromAddress = {
  name: "Seller Shipping",
  company: "Chase Sets",
  line1: "1 Warehouse Way",
  line2: null,
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: "5125550100",
  email: "shipping@example.com",
} as const;

const taxSnapshot = {
  taxableAmount: "24.99",
  salesTaxAmount: "0.00",
  jurisdictionCountry: "US",
  jurisdictionState: "IL",
  rateBps: 0,
  providerName: "local-tax-stub",
  providerQuoteReference: null,
  quotedAt: "2026-03-31T00:00:00.000Z",
} as const;

type SupplyCandidate = Readonly<{
  listingId: string;
  sellerAccountId: string;
  inventoryItemId: string;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly unknown[];
  productSummary: string | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  shipFromAddress?: typeof shipFromAddress;
  priceAmount: string;
  marketplaceSalesFeeUnitAmount?: string;
  sellerNetUnitAmount?: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId?: string | null;
  termsAgreementId?: string | null;
  termsResolvedAt?: string;
  availableQuantity: number;
  updatedAt: string;
}>;

function createSupplyDb(
  resolver: (params: readonly unknown[] | undefined) => readonly SupplyCandidate[],
) {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM ordering_order_pages")) {
        return { rows: [] };
      }

      return {
      rows: resolver(params).map((candidate) => ({
        listing_id: candidate.listingId,
        seller_account_id: candidate.sellerAccountId,
        inventory_item_id: candidate.inventoryItemId,
        catalog_catalog_item_id: candidate.catalogItemId,
        product_id: candidate.productId,
        item_title: candidate.itemTitle,
        item_subtitle: candidate.itemSubtitle,
        selected_options: candidate.selectedOptions,
        product_summary: candidate.productSummary,
        storage_location_name: candidate.storageLocationName,
        ship_from_code: candidate.shipFromCode,
        ship_from_address: candidate.shipFromAddress ?? shipFromAddress,
        price_amount: candidate.priceAmount,
        marketplace_sales_fee_unit_amount: candidate.marketplaceSalesFeeUnitAmount ?? "1.00",
        seller_net_unit_amount: candidate.sellerNetUnitAmount ?? "19.00",
        shipping_allowance_percentage_bps: candidate.shippingAllowancePercentageBps ?? 500,
        terms_schedule_id: candidate.termsScheduleId ?? "cts_default",
        terms_agreement_id: candidate.termsAgreementId ?? null,
        terms_resolved_at: candidate.termsResolvedAt ?? "2026-03-31T00:00:00.000Z",
        available_quantity: candidate.availableQuantity,
        updated_at: candidate.updatedAt,
      })),
    };
    }),
  };
}

describe("ordering order runtime", () => {
  it("blocks checkout and previews unavailable lines when active supply is insufficient", async () => {
    const { eventStore } = createInMemoryEventStore();
    const carts = {
      listCartLines: vi.fn(async () => [
        {
          buyer_account_id: "acc_buyer",
          line_id: "cli_1",
          catalog_catalog_item_id: "cat_1",
          product_id: "cat_1::",
          item_title: "Charizard",
          item_subtitle: null,
          selected_options: [],
          product_summary: null,
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
        inventoryItemId: "inv_1",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
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
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
      },
    });

    const checkoutParams = {
      buyerAccountId: "acc_buyer" as never,
      checkoutSessionId: "chk_insufficient",
      sourceType: "cart-checkout" as const,
      shippingOption: "standard" as const,
      shippingAddress,
      lines: [
        {
          listingId: null,
          cartLineId: "cli_1",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 2,
        },
      ],
    };

    const preview = await services.previewCheckoutFulfillment(checkoutParams);

    expect(preview.readyLineKeys).toEqual([]);
    expect(preview.unavailableLines).toEqual([
      expect.objectContaining({
        lineKey: "cli_1",
        itemTitle: "Charizard",
        reason: "No active supply can fulfill this product.",
      }),
    ]);
    await expect(
      services.createOrdersFromCheckout(checkoutParams, context),
    ).rejects.toThrow("No checkout lines are currently fulfillable.");
  });

  it("keeps buyer cost lowest by rewarding same-seller checkout grouping", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const carts = {
      listCartLines: vi.fn(async () => [
        {
          buyer_account_id: "acc_buyer",
          line_id: "cli_1",
          catalog_catalog_item_id: "cat_1",
          product_id: "cat_1::",
          item_title: "Charizard",
          item_subtitle: null,
          selected_options: [],
          product_summary: null,
          quantity: 1,
          created_at: "2026-03-31T00:00:00.000Z",
          updated_at: "2026-03-31T00:00:00.000Z",
        },
        {
          buyer_account_id: "acc_buyer",
          line_id: "cli_2",
          catalog_catalog_item_id: "cat_2",
          product_id: "cat_2::",
          item_title: "Blastoise",
          item_subtitle: null,
          selected_options: [],
          product_summary: null,
          quantity: 1,
          created_at: "2026-03-31T00:00:00.000Z",
          updated_at: "2026-03-31T00:00:00.000Z",
        },
      ]),
      checkout: vi.fn(async () => ({ version: 1 })),
    };
    const db = createSupplyDb((params) => {
      const productId = String(params?.[0] ?? "");

      if (productId === "cat_1::") {
        return [
          {
            listingId: "lst_a1",
            sellerAccountId: "acc_split_a",
            inventoryItemId: "inv_a1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            storageLocationName: "A",
            shipFromCode: "A",
            priceAmount: "5.00",
            availableQuantity: 1,
            updatedAt: "2026-03-31T00:00:00.000Z",
          },
          {
            listingId: "lst_b1",
            sellerAccountId: "acc_single",
            inventoryItemId: "inv_b1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
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
          inventoryItemId: "inv_c1",
          catalogItemId: "cat_2",
          productId: "cat_2::",
          itemTitle: "Blastoise",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          storageLocationName: "C",
          shipFromCode: "C",
          priceAmount: "5.00",
          availableQuantity: 1,
          updatedAt: "2026-03-31T00:00:00.000Z",
        },
        {
          listingId: "lst_b2",
          sellerAccountId: "acc_single",
          inventoryItemId: "inv_b2",
          catalogItemId: "cat_2",
          productId: "cat_2::",
          itemTitle: "Blastoise",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
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

    const result = await services.createOrdersFromCheckout(
      {
        buyerAccountId: "acc_buyer" as never,
        checkoutSessionId: "chk_best_cost",
        sourceType: "cart-checkout",
        shippingOption: "standard",
        shippingAddress,
        lines: [
          {
            listingId: null,
            cartLineId: "cli_1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            quantity: 1,
          },
          {
            listingId: null,
            cartLineId: "cli_2",
            catalogItemId: "cat_2",
            productId: "cat_2::",
            itemTitle: "Blastoise",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            quantity: 1,
          },
        ],
      },
      context,
    );

    expect(result.orderIds).toHaveLength(1);

    const createdEvents = readAllEvents()
      .filter((event) => event.eventType === "ordering.order.created")
      .map((event) => event.payload);
    expect(createdEvents).toEqual([
      expect.objectContaining({
        sellerAccountId: "acc_single",
        itemSubtotalAmount: "11.00",
        shippingBaseAmount: "4.99",
        shippingDiscountAmount: "0.55",
        shippingAllowanceAmount: "0.55",
        shippingOverageAmount: "0.00",
        shippingChargeAmount: "4.44",
        totalAmount: "15.44",
      }),
    ]);
  });

  it("groups same-seller checkout lines and applies the buyer shipping allowance as a shipping credit", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = createSupplyDb((params) => {
      const productId = String(params?.[0] ?? "");
      return [
        {
          listingId: productId === "cat_1::" ? "lst_1" : "lst_2",
          sellerAccountId: "acc_seller",
          inventoryItemId: productId === "cat_1::" ? "inv_1" : "inv_2",
          catalogItemId: productId === "cat_1::" ? "cat_1" : "cat_2",
          productId,
          itemTitle: productId === "cat_1::" ? "Charizard" : "Blastoise",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          storageLocationName: "A",
          shipFromCode: "A",
          priceAmount: productId === "cat_1::" ? "10.00" : "4.99",
          availableQuantity: 1,
          updatedAt: "2026-03-31T00:00:00.000Z",
        },
      ];
    });
    const taxQuoteResolver = {
      quoteTax: vi.fn(async (input: { itemSubtotalAmount: string; shippingAmount: string }) => ({
        taxableAmount: (
          Number.parseFloat(input.itemSubtotalAmount) +
          Number.parseFloat(input.shippingAmount)
        ).toFixed(2),
        taxAmount: "1.57",
        jurisdictionCountry: "US",
        jurisdictionState: "IL",
        rateBps: 1000,
        itemTaxable: true,
        shippingTaxable: true,
        marketplaceCheckoutFeeTaxable: false,
        providerName: "test-tax",
        providerQuoteReference: "tax_1",
        quotedAt: "2026-03-31T00:00:00.000Z",
      })),
    };

    const services = createOrderingOrderRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      carts: {
        listCartLines: async () => [],
        checkout: async () => ({ version: 1 }),
      } as never,
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
      },
      taxQuoteResolver: taxQuoteResolver as never,
    });

    const result = await services.createOrdersFromCheckout(
      {
        buyerAccountId: "acc_buyer" as never,
        checkoutSessionId: "chk_allowance",
        sourceType: "cart-checkout",
        shippingOption: "standard",
        shippingAddress,
        lines: [
          {
            listingId: null,
            cartLineId: "cli_1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            quantity: 1,
          },
          {
            listingId: null,
            cartLineId: "cli_2",
            catalogItemId: "cat_2",
            productId: "cat_2::",
            itemTitle: "Blastoise",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            quantity: 1,
          },
        ],
      },
      context,
    );

    expect(result.orderIds).toHaveLength(1);
    expect(taxQuoteResolver.quoteTax).toHaveBeenCalledWith(
      expect.objectContaining({
        itemSubtotalAmount: "14.99",
        shippingAmount: "4.25",
      }),
    );
    const createdEvent = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(createdEvent?.payload).toMatchObject({
      sellerAccountId: "acc_seller",
      itemSubtotalAmount: "14.99",
      shippingBaseAmount: "4.99",
      shippingDiscountAmount: "0.74",
      shippingAllowanceAmount: "0.74",
      shippingOverageAmount: "0.00",
      shippingChargeAmount: "4.25",
      salesTaxAmount: "1.57",
      totalAmount: "20.81",
      commercialTermsSnapshot: {
        sellerItemNetAmount: "38.00",
        shippingAllowanceAmount: "0.74",
        sellerShippingPayoutAmount: "4.25",
        sellerPayoutAmount: "42.25",
      },
    });
  });

  it("constrains accepted-offer commitments to the accepting seller", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = createSupplyDb((params) => {
      expect(params?.[1]).toBe("acc_seller");
      return [
        {
          listingId: "lst_1",
          sellerAccountId: "acc_seller",
          inventoryItemId: "inv_1",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
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
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        priceAmount: "10.00",
        marketplaceSalesFeeUnitAmount: "0.50",
        sellerNetUnitAmount: "9.50",
        termsScheduleId: "cts_offer",
        termsAgreementId: null,
        termsResolvedAt: "2026-03-31T00:00:00.000Z",
        quantityRequested: 1,
        shippingDestinationSnapshot: shippingAddress,
      },
      context,
    );

    expect(db.query).toHaveBeenCalledTimes(1);
    const createdEvent = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(createdEvent?.payload).toMatchObject({
      sourceType: "offer-acceptance",
      sourceReferenceId: "off_1",
      sellerAccountId: "acc_seller",
      commercialTermsSnapshot: {
        marketplaceSalesFeeAmount: "0.50",
        sellerNetAmount: "9.50",
        termsScheduleId: "cts_offer",
      },
      lines: [
        expect.objectContaining({
          marketplaceSalesFeeUnitAmount: "0.50",
          marketplaceSalesFeeTotalAmount: "0.50",
          sellerNetUnitAmount: "9.50",
          sellerNetTotalAmount: "9.50",
        }),
      ],
    });
  });

  it("groups accepted offer batches by buyer and seller into one allowance-bearing order", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = createSupplyDb((params) => {
      const productId = String(params?.[0] ?? "");
      expect(params?.[1]).toBe("acc_seller");
      return [
        {
          listingId: productId === "cat_1::" ? "lst_1" : "lst_2",
          sellerAccountId: "acc_seller",
          inventoryItemId: productId === "cat_1::" ? "inv_1" : "inv_2",
          catalogItemId: productId === "cat_1::" ? "cat_1" : "cat_2",
          productId,
          itemTitle: productId === "cat_1::" ? "Charizard" : "Blastoise",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          storageLocationName: "A",
          shipFromCode: "A",
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
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
      },
    });

    const result = await services.createOrdersFromAcceptedOfferBatch(
      {
        acceptanceBatchId: "ofb_1",
        offers: [
          {
            offerId: "off_1",
            buyerAccountId: "acc_buyer" as never,
            sellerAccountId: "acc_seller" as never,
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            priceAmount: "10.00",
            marketplaceSalesFeeUnitAmount: "0.50",
            sellerNetUnitAmount: "9.50",
            shippingAllowancePercentageBps: 500,
            termsScheduleId: "cts_offer",
            termsAgreementId: null,
            termsResolvedAt: "2026-03-31T00:00:00.000Z",
            quantityRequested: 1,
            shippingDestinationSnapshot: shippingAddress,
          },
          {
            offerId: "off_2",
            buyerAccountId: "acc_buyer" as never,
            sellerAccountId: "acc_seller" as never,
            catalogItemId: "cat_2",
            productId: "cat_2::",
            itemTitle: "Blastoise",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            priceAmount: "10.00",
            marketplaceSalesFeeUnitAmount: "0.50",
            sellerNetUnitAmount: "9.50",
            shippingAllowancePercentageBps: 500,
            termsScheduleId: "cts_offer",
            termsAgreementId: null,
            termsResolvedAt: "2026-03-31T00:00:00.000Z",
            quantityRequested: 1,
            shippingDestinationSnapshot: shippingAddress,
          },
        ],
      },
      context,
    );

    expect(result.orderIds).toHaveLength(1);
    const createdEvent = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(createdEvent?.payload).toMatchObject({
      sourceType: "offer-acceptance",
      sourceReferenceId: "ofb_1",
      buyerAccountId: "acc_buyer",
      sellerAccountId: "acc_seller",
      itemSubtotalAmount: "20.00",
      shippingAllowanceAmount: "1.00",
      shippingOverageAmount: "3.99",
      shippingChargeAmount: "1.00",
      totalAmount: "21.00",
      commercialTermsSnapshot: {
        marketplaceSalesFeeAmount: "1.00",
        sellerItemNetAmount: "19.00",
        shippingAllowanceAmount: "1.00",
        sellerShippingPayoutAmount: "1.00",
        sellerPayoutAmount: "20.00",
      },
    });
    expect((createdEvent?.payload as { lines?: unknown[] } | undefined)?.lines).toHaveLength(2);
  });

  it("creates buy-now orders from the requested listing only", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = createSupplyDb((params) => {
      expect(params?.[0]).toBe("lst_buy_now");
      return [
        {
          listingId: "lst_buy_now",
          sellerAccountId: "acc_seller",
          inventoryItemId: "inv_buy_now",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          storageLocationName: "North shelf",
          shipFromCode: "CHI",
          priceAmount: "12.00",
          availableQuantity: 2,
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
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
      },
    });

    await services.createOrdersFromCheckout(
      {
        buyerAccountId: "acc_buyer" as never,
        checkoutSessionId: "chk_buy_now",
        sourceType: "buy-now",
        shippingOption: "standard",
        shippingAddress,
        lines: [
          {
            listingId: "lst_buy_now",
            cartLineId: null,
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            quantity: 1,
          },
        ],
      },
      context,
    );

    const createdEvent = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(createdEvent?.payload).toMatchObject({
      sourceType: "buy-now",
      sourceReferenceId: "chk_buy_now",
      lines: [
        expect.objectContaining({
          listingId: "lst_buy_now",
          inventoryItemId: "inv_buy_now",
          unitPriceAmount: "12.00",
        }),
      ],
    });
  });

  it("reuses orders already created for a checkout session", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        expect(sql).toContain("FROM ordering_order_pages");
        expect(params).toEqual(["cart-checkout", "chk_existing"]);
        return {
          rows: [{ order_id: "ord_existing" }],
        };
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
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
      },
    });

    const result = await services.createOrdersFromCheckout(
      {
        buyerAccountId: "acc_buyer" as never,
        checkoutSessionId: "chk_existing",
        sourceType: "cart-checkout",
        shippingOption: "standard",
        shippingAddress,
        lines: [
          {
            listingId: null,
            cartLineId: "cli_1",
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            quantity: 1,
          },
        ],
      },
      context,
    );

    expect(result.orderIds).toEqual(["ord_existing"]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(readAllEvents()).toEqual([]);
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
                sales_tax_amount: "0.00",
                total_amount: "24.99",
                marketplace_sales_fee_amount: "1.00",
                seller_net_amount: "19.00",
                taxable_amount: "24.99",
                tax_jurisdiction_country: "US",
                tax_jurisdiction_state: "IL",
                tax_rate_bps: 0,
                tax_provider_name: "local-tax-stub",
                tax_provider_quote_reference: null,
                tax_quoted_at: "2026-03-31T00:00:00.000Z",
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
                inventory_item_id: "inv_1",
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
        salesTaxAmount: "0.00",
        taxSnapshot,
        totalAmount: "24.99",
        shippingDestinationSnapshot: shippingAddress,
        shippingOriginSnapshot: shipFromAddress,
        commercialTermsSnapshot: {
          marketplaceSalesFeeAmount: "1.00",
          sellerNetAmount: "19.00",
          termsScheduleId: "cts_default",
          termsAgreementId: null,
          termsResolvedAt: "2026-03-31T00:00:00.000Z",
        },
        lines: [
          {
            lineId: "oli_1" as never,
            listingId: "lst_1",
            inventoryItemId: "inv_1",
            catalogItemId: "cat_1",
            productId: "cat_1::" as never,
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            unitPriceAmount: "20.00",
            quantity: 1,
            lineTotalAmount: "20.00",
            marketplaceSalesFeeUnitAmount: "1.00",
            marketplaceSalesFeeTotalAmount: "1.00",
            sellerNetUnitAmount: "19.00",
            sellerNetTotalAmount: "19.00",
          },
        ],
        reservationRequests: [
          {
            reservationRequestId: "rsv_1",
            inventoryItemId: "inv_1",
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

    await services.cancelPurchase(
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
