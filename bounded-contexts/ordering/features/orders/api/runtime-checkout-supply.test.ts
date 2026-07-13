import { describe, expect, it, vi } from "vitest";
import { defaultPostagePolicy, type PostagePolicy } from "@chase-sets/product-measures";
import {
  context,
  createCheckpointStore,
  createInMemoryEventStore,
  createOrderingOrderRuntimeForTest,
  createSupplyDb,
  shippingAddress,
} from "./runtime-test-harness";

describe("ordering order runtime: checkout supply and grouping", () => {
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
