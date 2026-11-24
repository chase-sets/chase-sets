import { describe, expect, it, vi } from "vitest";
import { defaultPostagePolicy, type PackagePlan, type PostagePolicy } from "@chase-sets/product-measures";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { defaultShippingQuotePolicy } from "../domain/policies";
import { defaultShippingRates, type ShippingRates } from "../domain/shipping-rates";
import {
  context,
  createCheckpointStore,
  createOrderingOrderRuntimeForTest,
  createSupplyDb,
  productMeasureForCandidate,
  shippingAddress,
  type SupplyCandidate,
} from "./runtime-test-harness";

describe("ordering order runtime: checkout supply and grouping", () => {
  it("returns the original order set when checkout creation is retried before projection catch-up", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
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
        priceAmount: "20.00",
        availableQuantity: 1,
        updatedAt: "2026-03-31T00:00:00.000Z",
      },
    ]);
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
        }),
      },
    });
    const params = {
      buyerAccountId: "acc_buyer" as never,
      checkoutSessionId: "chk_retry_before_projection",
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
          quantity: 1,
        },
      ],
    };

    const first = await services.createOrdersFromCheckout(params, context);
    const retried = await services.createOrdersFromCheckout(params, context);

    expect(retried.orderIds).toEqual(first.orderIds);
    expect(readAllEvents().filter((event) => event.eventType === "ordering.order.created")).toHaveLength(1);
  });

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

    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
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
    await expect(services.createOrdersFromCheckout(checkoutParams, context)).rejects.toThrow(
      "No checkout lines are currently fulfillable.",
    );
  });

  it("treats listing purchase limits as available supply for optimized checkout", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = createSupplyDb((params) => {
      const key = String(params?.[0] ?? "");
      if (key !== "cat_1::" && key !== "lst_discount" && key !== "lst_standard") {
        return [];
      }
      return [
        {
          listingId: "lst_discount",
          sellerAccountId: "acc_seller_a",
          inventoryItemId: "inv_discount",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          storageLocationName: "North shelf",
          shipFromCode: "CHI",
          priceAmount: "5.00",
          availableQuantity: 4,
          maxUnitsPerOrder: 1,
          updatedAt: "2026-03-31T00:00:00.000Z",
        },
        {
          listingId: "lst_standard",
          sellerAccountId: "acc_seller_b",
          inventoryItemId: "inv_standard",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemTitle: "Charizard",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          storageLocationName: "South shelf",
          shipFromCode: "STL",
          priceAmount: "10.00",
          availableQuantity: 4,
          updatedAt: "2026-03-31T00:00:00.000Z",
        },
      ];
    });

    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      shippingQuotePolicy: {
        quote: () => ({
          shippingOption: "standard",
          baseAmount: "0.00",
          discountAmount: "0.00",
          chargeAmount: "0.00",
        }),
      },
    });

    const preview = await services.previewCheckoutFulfillment({
      buyerAccountId: "acc_buyer" as never,
      checkoutSessionId: "chk_limits",
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
          quantity: 2,
        },
      ],
    });

    const allocations = preview.sellerGroups.flatMap((group) => group.lines);
    expect(allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ listingId: "lst_discount", quantity: 1 }),
        expect.objectContaining({ listingId: "lst_standard", quantity: 1 }),
      ]),
    );
    expect(preview.sellerGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deliveryEstimate: expect.objectContaining({
            earliestDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            latestDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            minimumTransitDays: 4,
            maximumTransitDays: 7,
          }),
        }),
      ]),
    );
  });

  it("changes checkout preview revision when the active postage policy requirements change", async () => {
    const { eventStore } = createInMemoryEventStore();
    let activePostagePolicy: PostagePolicy = {
      ...defaultPostagePolicy,
      policyVersion: "operator-postage-v1",
      signatureRequiredShippingOptions: [],
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

    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      postagePolicyResolver: vi.fn(async () => activePostagePolicy),
      shippingQuotePolicy: {
        quote: ({ packagePlan }) => ({
          shippingOption: "standard",
          baseAmount: packagePlan?.postagePolicySnapshot?.signatureRequired ? "6.99" : "4.99",
          discountAmount: "0.00",
          chargeAmount: packagePlan?.postagePolicySnapshot?.signatureRequired ? "6.99" : "4.99",
        }),
      },
    });
    const checkoutParams = {
      buyerAccountId: "acc_buyer" as never,
      checkoutSessionId: "chk_policy_revision",
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
          quantity: 1,
        },
      ],
    };

    const firstPreview = await services.previewCheckoutFulfillment(checkoutParams);
    activePostagePolicy = {
      ...activePostagePolicy,
      policyVersion: "operator-postage-v2",
      signatureRequiredShippingOptions: ["standard"],
    };
    const secondPreview = await services.previewCheckoutFulfillment(checkoutParams);

    expect(firstPreview.sellerGroups[0]?.postageRequirements).toMatchObject({
      policyVersion: "operator-postage-v1",
      signatureRequired: false,
    });
    expect(secondPreview.sellerGroups[0]?.postageRequirements).toMatchObject({
      policyVersion: "operator-postage-v2",
      signatureRequired: true,
      signatureReasons: ["shipping-option-requires-signature"],
    });
    expect(secondPreview.revision).not.toBe(firstPreview.revision);
    await expect(
      services.createOrdersFromCheckout(
        {
          ...checkoutParams,
          fulfillmentPreviewRevision: firstPreview.revision,
        },
        context,
      ),
    ).rejects.toThrow("Fulfillment changed. Review the latest checkout preview before continuing.");
  });

  it("rejects current checkout drafts when the package plan lacks a postage policy snapshot", async () => {
    const { eventStore } = createInMemoryEventStore();
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

    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      shippingQuotePolicy: {
        quote: ({ packagePlan }) => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: "4.99",
          packagePlan: packagePlan ? { ...packagePlan, postagePolicySnapshot: undefined } : undefined,
        }),
      },
    });

    await expect(
      services.previewCheckoutFulfillment({
        buyerAccountId: "acc_buyer" as never,
        checkoutSessionId: "chk_missing_postage_snapshot",
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
      }),
    ).rejects.toThrow("Shipping plan is missing a postage policy snapshot.");
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

    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      shippingQuotePolicy: {
        quote: ({ itemSubtotalAmount }) => ({
          shippingOption: "standard",
          baseAmount: "4.99",
          discountAmount: "0.00",
          chargeAmount: Number(itemSubtotalAmount) >= 11 ? "4.99" : "7.99",
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
    expect(result.commitPosition).toBe("2");
    expect(result.commitEventIds).toHaveLength(2);
    expect(result.commitEventIds).toContain("evt_1");
    expect(result.commitPositions).toEqual([
      {
        sourceContextName: "ordering",
        maxGlobalPosition: "2",
        eventIds: expect.arrayContaining(["evt_1"]),
      },
    ]);

    const createdEvents = readAllEvents()
      .filter((event) => event.eventType === "ordering.order.created")
      .map((event) => event.payload);
    expect(createdEvents).toEqual([
      expect.objectContaining({
        sellerAccountId: "acc_single",
        itemSubtotalAmount: "11.00",
        shippingBaseAmount: "4.99",
        shippingDiscountAmount: "0.44",
        shippingAllowanceAmount: "0.44",
        shippingOverageAmount: "4.55",
        protectionAmount: "0.11",
        protectionAllowanceAmount: "0.11",
        protectionOverageAmount: "0.00",
        shippingChargeAmount: "4.55",
        totalAmount: "15.55",
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
        taxableAmount: (Number.parseFloat(input.itemSubtotalAmount) + Number.parseFloat(input.shippingAmount)).toFixed(
          2,
        ),
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

    const services = createOrderingOrderRuntimeForTest({
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
        shippingAmount: "4.40",
      }),
    );
    const createdEvent = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(createdEvent?.payload).toMatchObject({
      sellerAccountId: "acc_seller",
      itemSubtotalAmount: "14.99",
      shippingBaseAmount: "4.99",
      shippingDiscountAmount: "0.59",
      shippingAllowanceAmount: "0.59",
      shippingOverageAmount: "4.40",
      protectionAmount: "0.15",
      protectionAllowanceAmount: "0.15",
      protectionOverageAmount: "0.00",
      shippingChargeAmount: "4.40",
      salesTaxAmount: "1.57",
      totalAmount: "20.96",
      commercialTermsSnapshot: {
        sellerItemNetAmount: "12.99",
        shippingAllowanceAmount: "0.59",
        sellerShippingPayoutAmount: "4.40",
        sellerPayoutAmount: "17.24",
      },
    });
  });

  it("calculates exact-cent shipping allowances without floating point round-down", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = createSupplyDb(() => [
      {
        listingId: "lst_low_value",
        sellerAccountId: "acc_seller",
        inventoryItemId: "inv_low_value",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        storageLocationName: "A",
        shipFromCode: "A",
        priceAmount: "1.40",
        marketplaceSalesFeeUnitAmount: "0.00",
        sellerNetUnitAmount: "1.40",
        shippingAllowancePercentageBps: 500,
        availableQuantity: 1,
        updatedAt: "2026-03-31T00:00:00.000Z",
      },
    ]);

    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
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
        checkoutSessionId: "chk_exact_allowance",
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

    const createdEvent = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(createdEvent?.payload).toMatchObject({
      itemSubtotalAmount: "1.40",
      shippingDiscountAmount: "0.05",
      shippingAllowanceAmount: "0.05",
      protectionAmount: "0.02",
      protectionAllowanceAmount: "0.02",
      shippingChargeAmount: "4.94",
      totalAmount: "6.34",
    });
  });
});

describe("ordering order runtime: Shipping Rates recorded under the default Shipping Quote Policy", () => {
  type CreatedOrderPayload = Readonly<{
    shippingOption: "standard" | "expedited" | "priority";
    itemSubtotalAmount: string;
    shippingBaseAmount: string;
    shippingPlanSnapshot: PackagePlan;
    commercialTermsSnapshot: Readonly<{ shippingRates?: ShippingRates }>;
  }>;

  const candidate: SupplyCandidate = {
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
    priceAmount: "20.00",
    availableQuantity: 1,
    updatedAt: "2026-03-31T00:00:00.000Z",
  };

  // 4.3 ounces plus 2 ounces of parcel packaging bills as a 7 ounce parcel.
  const sealedBoxCandidate: SupplyCandidate = {
    ...candidate,
    productMeasureSnapshot: {
      ...productMeasureForCandidate(candidate),
      measureVersion: "test-sealed-box-v1",
      unitLengthInches: 7,
      unitWidthInches: 5,
      unitHeightInches: 2,
      unitWeightOunces: 4.3,
      physicalFlags: ["rigid"],
      stackBehavior: "stackable-height",
    },
  };

  function createRuntimeWithDefaultQuote(
    supply: SupplyCandidate,
    shippingRatesResolver?: () => Promise<ShippingRates>,
  ) {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const quote = vi.fn(defaultShippingQuotePolicy.quote);
    const db = createSupplyDb(() => [supply]);
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      shippingQuotePolicy: { quote },
      shippingRatesResolver,
    });
    const createdOrders = () =>
      readAllEvents()
        .filter((event) => event.eventType === "ordering.order.created")
        .map((event) => event.payload as CreatedOrderPayload);
    return { services, quote, createdOrders, db };
  }

  function expectRecordedRatesAreTheRatesQuoted(
    order: CreatedOrderPayload,
    quote: ReturnType<typeof createRuntimeWithDefaultQuote>["quote"],
    resolvedRates: ShippingRates = defaultShippingRates,
  ) {
    const recorded = order.commercialTermsSnapshot.shippingRates;

    expect(recorded).toEqual(resolvedRates);
    expect(quote).toHaveBeenCalled();
    for (const [quoted] of quote.mock.calls) {
      expect(quoted.shippingRates).toEqual(recorded);
    }
    // The recorded rates and package plan reproduce the amount the order was charged.
    expect(
      defaultShippingQuotePolicy.quote({
        sellerAccountId: "acc_seller",
        shippingOption: order.shippingOption,
        itemSubtotalAmount: order.itemSubtotalAmount,
        quantity: 1,
        listingCount: 1,
        packagePlan: order.shippingPlanSnapshot,
        shippingRates: recorded!,
      }).baseAmount,
    ).toBe(order.shippingBaseAmount);
  }

  it("records the rates a checkout order was quoted under, with unchanged amounts and preview", async () => {
    const { services, quote, createdOrders } = createRuntimeWithDefaultQuote(sealedBoxCandidate);
    const checkoutParams = {
      buyerAccountId: "acc_buyer" as never,
      checkoutSessionId: "chk_recorded_rates",
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
          quantity: 1,
        },
      ],
    };

    const preview = await services.previewCheckoutFulfillment(checkoutParams);

    expect(preview.totals).toEqual({
      itemSubtotalAmount: "20.00",
      shippingAmount: "5.15",
      salesTaxAmount: "0.00",
      totalAmount: "25.15",
      packageCount: 1,
    });
    expect(preview.sellerGroups).toEqual([
      expect.objectContaining({ itemSubtotalAmount: "20.00", shippingChargeAmount: "5.15", totalAmount: "25.15" }),
    ]);
    expect(JSON.stringify(preview)).not.toContain("shippingRates");

    await services.createOrdersFromCheckout(checkoutParams, context);

    const [order, ...otherOrders] = createdOrders();
    expect(otherOrders).toEqual([]);
    // A 7 ounce standard parcel: 499 + 3 x 32 cents.
    expect(order).toMatchObject({
      itemSubtotalAmount: "20.00",
      shippingBaseAmount: "5.95",
      shippingDiscountAmount: "0.80",
      shippingAllowanceAmount: "0.80",
      shippingOverageAmount: "5.15",
      protectionAmount: "0.20",
      protectionAllowanceAmount: "0.20",
      protectionOverageAmount: "0.00",
      shippingChargeAmount: "5.15",
      salesTaxAmount: "0.00",
      totalAmount: "25.15",
      shippingPlanSnapshot: {
        packageCount: 1,
        packages: [{ mailpieceClass: "parcel", billableWeightOunces: 7 }],
      },
    });
    expectRecordedRatesAreTheRatesQuoted(order!, quote);
  });

  it("records the rates an accepted Offer order was quoted under, with unchanged amounts", async () => {
    const { services, quote, createdOrders } = createRuntimeWithDefaultQuote(candidate);

    await services.createOrdersFromAcceptedOffer(
      {
        offerId: "off_recorded_rates",
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        listingId: "lst_1",
        inventoryItemId: "inv_1",
        listingVersion: 3,
        feeQuoteFingerprint: "sha256:fee-quote",
        listingEvidencePolicyId: "pol_listing_evidence",
        listingEvidencePolicyVersion: 2,
        listingEvidencePolicyHash: "sha256:policy",
        listingEvidenceSnapshot: {
          schemaVersion: 1 as const,
          policyHash: "sha256:policy",
          snapshotHash: "sha256:evidence:lst_1",
          createdAt: "2026-03-31T00:00:00.000Z",
          evidence: [],
        },
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        priceAmount: "10.00",
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: "25.00",
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

    const [order, ...otherOrders] = createdOrders();
    expect(otherOrders).toEqual([]);
    // One raw card ships as a letter.
    expect(order).toMatchObject({
      sourceType: "offer-acceptance",
      itemSubtotalAmount: "10.00",
      shippingBaseAmount: "1.49",
      shippingDiscountAmount: "0.40",
      shippingAllowanceAmount: "0.40",
      shippingOverageAmount: "1.09",
      protectionAmount: "0.10",
      protectionAllowanceAmount: "0.10",
      protectionOverageAmount: "0.00",
      shippingChargeAmount: "1.09",
      salesTaxAmount: "0.00",
      totalAmount: "11.09",
      shippingPlanSnapshot: { packageCount: 1, packages: [{ mailpieceClass: "letter" }] },
    });
    expectRecordedRatesAreTheRatesQuoted(order!, quote);
  });

  // A 7 ounce standard parcel is 600 + 4 x 50 cents under these rates, and a letter is 200 cents.
  const revisedRates: ShippingRates = {
    letterAmount: "2.00",
    standardParcelAmount: "6.00",
    expeditedParcelAmount: "8.50",
    priorityParcelAmount: "11.00",
    parcelIncludedOunces: 3,
    parcelAdditionalOunceAmount: "0.50",
  };
  // A 7 ounce standard parcel is 700 + 2 x 25 cents under these rates.
  const laterRates: ShippingRates = {
    ...revisedRates,
    standardParcelAmount: "7.00",
    parcelIncludedOunces: 5,
    parcelAdditionalOunceAmount: "0.25",
  };
  const moreThanOneResolution = new Error("The Shipping Rates were resolved more than once in one operation.");

  const checkoutFor = (checkoutSessionId: string) => ({
    buyerAccountId: "acc_buyer" as never,
    checkoutSessionId,
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
        quantity: 1,
      },
    ],
  });

  const acceptedOffer = {
    offerId: "off_resolved_rates",
    buyerAccountId: "acc_buyer" as never,
    sellerAccountId: "acc_seller" as never,
    listingId: "lst_1",
    inventoryItemId: "inv_1",
    listingVersion: 3,
    feeQuoteFingerprint: "sha256:fee-quote",
    listingEvidencePolicyId: "pol_listing_evidence",
    listingEvidencePolicyVersion: 2,
    listingEvidencePolicyHash: "sha256:policy",
    listingEvidenceSnapshot: {
      schemaVersion: 1 as const,
      policyHash: "sha256:policy",
      snapshotHash: "sha256:evidence:lst_1",
      createdAt: "2026-03-31T00:00:00.000Z",
      evidence: [],
    },
    catalogItemId: "cat_1",
    productId: "cat_1::",
    itemTitle: "Charizard",
    itemSubtitle: null,
    selectedOptions: [],
    productSummary: null,
    priceAmount: "10.00",
    marketplaceSalesFeePercentageBps: 500,
    marketplaceSalesFeeFixedAmount: "0.00",
    marketplaceSalesFeeCapAmount: "25.00",
    marketplaceSalesFeeUnitAmount: "0.50",
    sellerNetUnitAmount: "9.50",
    termsScheduleId: "cts_offer",
    termsAgreementId: null,
    termsResolvedAt: "2026-03-31T00:00:00.000Z",
    quantityRequested: 1,
    shippingDestinationSnapshot: shippingAddress,
  };

  it("charges and records the resolved rates on a checkout preview and its order, resolving once per operation", async () => {
    // Each resolution returns a different revision and a third rejects, so an
    // operation that resolved twice would fail or quote two revisions.
    const shippingRatesResolver = vi
      .fn<() => Promise<ShippingRates>>()
      .mockResolvedValueOnce(revisedRates)
      .mockResolvedValueOnce(laterRates)
      .mockRejectedValue(moreThanOneResolution);
    const { services, quote, createdOrders } = createRuntimeWithDefaultQuote(sealedBoxCandidate, shippingRatesResolver);
    const checkoutParams = checkoutFor("chk_resolved_rates");

    const preview = await services.previewCheckoutFulfillment(checkoutParams);

    expect(shippingRatesResolver).toHaveBeenCalledTimes(1);
    expect(preview.totals).toEqual({
      itemSubtotalAmount: "20.00",
      shippingAmount: "7.20",
      salesTaxAmount: "0.00",
      totalAmount: "27.20",
      packageCount: 1,
    });
    expect(quote).toHaveBeenCalled();
    for (const [quoted] of quote.mock.calls) {
      expect(quoted.shippingRates).toBe(revisedRates);
    }
    quote.mockClear();

    // The confirmation sends no preview revision, so it is charged the rates in force now.
    await services.createOrdersFromCheckout(checkoutParams, context);

    expect(shippingRatesResolver).toHaveBeenCalledTimes(2);
    // The internal preview and the plan the order is created from quote one revision.
    expect(quote.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [quoted] of quote.mock.calls) {
      expect(quoted.shippingRates).toBe(laterRates);
    }
    const [order, ...otherOrders] = createdOrders();
    expect(otherOrders).toEqual([]);
    expect(order).toMatchObject({
      itemSubtotalAmount: "20.00",
      shippingBaseAmount: "7.50",
      shippingDiscountAmount: "0.80",
      shippingAllowanceAmount: "0.80",
      shippingOverageAmount: "6.70",
      shippingChargeAmount: "6.70",
      salesTaxAmount: "0.00",
      totalAmount: "26.70",
      shippingPlanSnapshot: {
        packageCount: 1,
        packages: [{ mailpieceClass: "parcel", billableWeightOunces: 7 }],
      },
    });
    expectRecordedRatesAreTheRatesQuoted(order!, quote, laterRates);
  });

  it("charges and records the resolved rates on an accepted Offer order, resolving once", async () => {
    const shippingRatesResolver = vi
      .fn<() => Promise<ShippingRates>>()
      .mockResolvedValueOnce(revisedRates)
      .mockRejectedValue(moreThanOneResolution);
    const { services, quote, createdOrders } = createRuntimeWithDefaultQuote(candidate, shippingRatesResolver);

    await services.createOrdersFromAcceptedOffer(acceptedOffer, context);

    expect(shippingRatesResolver).toHaveBeenCalledTimes(1);
    const [order, ...otherOrders] = createdOrders();
    expect(otherOrders).toEqual([]);
    // One raw card ships as a letter.
    expect(order).toMatchObject({
      sourceType: "offer-acceptance",
      itemSubtotalAmount: "10.00",
      shippingBaseAmount: "2.00",
      shippingDiscountAmount: "0.40",
      shippingAllowanceAmount: "0.40",
      shippingOverageAmount: "1.60",
      shippingChargeAmount: "1.60",
      salesTaxAmount: "0.00",
      totalAmount: "11.60",
      shippingPlanSnapshot: { packageCount: 1, packages: [{ mailpieceClass: "letter" }] },
    });
    expectRecordedRatesAreTheRatesQuoted(order!, quote, revisedRates);
  });

  it("refuses a confirmation previewed under earlier rates and, once acknowledged, creates the order at the new rates", async () => {
    let activeRates = defaultShippingRates;
    const { services, quote, createdOrders } = createRuntimeWithDefaultQuote(
      sealedBoxCandidate,
      async () => activeRates,
    );
    const checkoutParams = checkoutFor("chk_rates_revised_after_preview");

    const preview = await services.previewCheckoutFulfillment(checkoutParams);
    expect(preview.totals).toMatchObject({ shippingAmount: "5.15", totalAmount: "25.15" });

    activeRates = revisedRates;
    expect((await services.previewCheckoutFulfillment(checkoutParams)).revision).not.toBe(preview.revision);
    await expect(
      services.createOrdersFromCheckout({ ...checkoutParams, fulfillmentPreviewRevision: preview.revision }, context),
    ).rejects.toThrow("Fulfillment changed. Review the latest checkout preview before continuing.");
    expect(createdOrders()).toEqual([]);

    quote.mockClear();
    const created = await services.createOrdersFromCheckout(
      { ...checkoutParams, fulfillmentPreviewRevision: preview.revision, acknowledgedMaterialChanges: true },
      context,
    );

    expect(created.orderIds).toHaveLength(1);
    const [order, ...otherOrders] = createdOrders();
    expect(otherOrders).toEqual([]);
    expect(order).toMatchObject({
      shippingBaseAmount: "8.00",
      shippingOverageAmount: "7.20",
      shippingChargeAmount: "7.20",
      totalAmount: "27.20",
    });
    expectRecordedRatesAreTheRatesQuoted(order!, quote, revisedRates);
  });

  it("confirms a preview whose Shipping amount a rates revision left unchanged and records the revision in force", async () => {
    let activeRates = defaultShippingRates;
    const { services, quote, createdOrders } = createRuntimeWithDefaultQuote(
      sealedBoxCandidate,
      async () => activeRates,
    );
    const checkoutParams = checkoutFor("chk_rates_revised_without_moving_the_amount");

    const preview = await services.previewCheckoutFulfillment(checkoutParams);
    // The buyer chose standard shipping, which the priority parcel amount does not price.
    activeRates = { ...defaultShippingRates, priorityParcelAmount: "12.99" };
    quote.mockClear();

    await services.createOrdersFromCheckout(
      { ...checkoutParams, fulfillmentPreviewRevision: preview.revision },
      context,
    );

    const [order, ...otherOrders] = createdOrders();
    expect(otherOrders).toEqual([]);
    expect(order).toMatchObject({ shippingBaseAmount: "5.95", shippingChargeAmount: "5.15", totalAmount: "25.15" });
    expectRecordedRatesAreTheRatesQuoted(order!, quote, activeRates);
  });

  it("fails each planning operation and creates no order while the Shipping Rates cannot be resolved", async () => {
    const unavailable = new Error("Shipping Rates Policy is unavailable.");
    const shippingRatesResolver = vi
      .fn<() => Promise<ShippingRates>>()
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValue(revisedRates);
    const { services, quote, createdOrders, db } = createRuntimeWithDefaultQuote(candidate, shippingRatesResolver);
    const checkoutParams = checkoutFor("chk_rates_unavailable");

    await expect(services.previewCheckoutFulfillment(checkoutParams)).rejects.toBe(unavailable);
    await expect(services.createOrdersFromCheckout(checkoutParams, context)).rejects.toBe(unavailable);
    await expect(services.createOrdersFromAcceptedOffer(acceptedOffer, context)).rejects.toBe(unavailable);

    expect(shippingRatesResolver).toHaveBeenCalledTimes(3);
    expect(createdOrders()).toEqual([]);
    // No compiled rates stood in for the unresolved ones, and no order source was claimed.
    expect(quote).not.toHaveBeenCalled();
    expect(db.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO ordering_order_source_claims"))).toEqual([]);

    // The same checkout creates its order once the rates resolve.
    await services.createOrdersFromCheckout(checkoutParams, context);
    const [order, ...otherOrders] = createdOrders();
    expect(otherOrders).toEqual([]);
    expectRecordedRatesAreTheRatesQuoted(order!, quote, revisedRates);
  });
});
