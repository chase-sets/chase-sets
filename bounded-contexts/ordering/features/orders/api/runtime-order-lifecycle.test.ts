import { describe, expect, it, vi } from "vitest";
import {
  context,
  createCheckpointStore,
  createInMemoryEventStore,
  createOrderingOrderRuntimeForTest,
  createSupplyDb,
  shipFromAddress,
  shippingAddress,
  taxSnapshot,
} from "./runtime-test-harness";

describe("ordering order runtime: order creation and cancellation", () => {
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
            marketplaceSalesFeePercentageBps: 500,
            marketplaceSalesFeeFixedAmount: "0.00",
            marketplaceSalesFeeCapAmount: "25.00",
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
            marketplaceSalesFeePercentageBps: 500,
            marketplaceSalesFeeFixedAmount: "0.00",
            marketplaceSalesFeeCapAmount: "25.00",
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
      shippingAllowanceAmount: "0.80",
      shippingOverageAmount: "4.19",
      protectionAmount: "0.20",
      protectionAllowanceAmount: "0.20",
      protectionOverageAmount: "0.00",
      shippingChargeAmount: "4.19",
      totalAmount: "24.19",
      commercialTermsSnapshot: {
        marketplaceSalesFeeAmount: "1.00",
        sellerItemNetAmount: "19.00",
        shippingAllowanceAmount: "0.80",
        sellerShippingPayoutAmount: "4.19",
        protectionAmount: "0.20",
        protectionAllowanceAmount: "0.20",
        protectionOverageAmount: "0.00",
        sellerPayoutAmount: "22.99",
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

  it("copies each listing fee-lock tranche into order lines for settlement", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = createSupplyDb(() => [
      {
        listingId: "lst_fee_locks",
        sellerAccountId: "acc_seller",
        inventoryItemId: "inv_fee_locks",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        storageLocationName: "North shelf",
        shipFromCode: "CHI",
        priceAmount: "12.00",
        availableQuantity: 3,
        feeLocks: [
          {
            unitCount: 2,
            terms: {
              shippingAllowancePercentageBps: 500,
              termsScheduleId: "cts_founder",
              termsAgreementId: "cta_founder",
              termsResolvedAt: "2026-07-01T00:00:00.000Z",
            },
            marketplaceSalesFeeUnitAmount: "0.00",
            sellerNetUnitAmount: "12.00",
          },
          {
            unitCount: 1,
            terms: {
              shippingAllowancePercentageBps: 500,
              termsScheduleId: "cts_standard",
              termsAgreementId: null,
              termsResolvedAt: "2026-09-01T00:00:00.000Z",
            },
            marketplaceSalesFeeUnitAmount: "0.60",
            sellerNetUnitAmount: "11.40",
          },
        ],
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      carts: { listCartLines: async () => [], checkout: async () => ({ version: 1 }) } as never,
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
        checkoutSessionId: "chk_fee_locks",
        sourceType: "buy-now",
        shippingOption: "standard",
        shippingAddress,
        lines: [
          {
            listingId: "lst_fee_locks",
            cartLineId: null,
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            quantity: 3,
          },
        ],
      },
      context,
    );

    const created = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(created?.payload).toMatchObject({
      commercialTermsSnapshot: {
        marketplaceSalesFeeAmount: "0.60",
        termsScheduleId: null,
        termsAgreementId: null,
      },
      lines: [
        expect.objectContaining({
          quantity: 1,
          marketplaceSalesFeeUnitAmount: "0.60",
        }),
        expect.objectContaining({
          quantity: 2,
          marketplaceSalesFeeUnitAmount: "0.00",
        }),
      ],
    });
  });

  it("threads byte-exact capped listing economics into a multi-quantity order", async () => {
    const examples = [
      { productId: "cat_10::", price: "10.00", quantity: 1, fee: "0.50", net: "9.50" },
      { productId: "cat_400::", price: "400.00", quantity: 1, fee: "20.00", net: "380.00" },
      { productId: "cat_600::", price: "600.00", quantity: 1, fee: "25.00", net: "575.00" },
      { productId: "cat_1000::", price: "1000.00", quantity: 3, fee: "25.00", net: "975.00" },
    ] as const;
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const db = createSupplyDb((params) => {
      const lookup = String(params?.[0]);
      const example = examples.find(
        (candidate) => candidate.productId === lookup || `lst_${candidate.price}` === lookup,
      )!;
      const productId = example.productId;
      return [
        {
          listingId: `lst_${example.price}`,
          sellerAccountId: "acc_seller",
          inventoryItemId: `inv_${example.price}`,
          catalogItemId: productId.split("::")[0]!,
          productId,
          itemTitle: `$${example.price} item`,
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          storageLocationName: "North shelf",
          shipFromCode: "CHI",
          priceAmount: example.price,
          availableQuantity: example.quantity,
          feeLocks: [
            {
              unitCount: example.quantity,
              terms: {
                marketplaceSalesFeePercentageBps: 500,
                marketplaceSalesFeeFixedAmount: "0.00",
                marketplaceSalesFeeCapAmount: "25.00",
                shippingAllowancePercentageBps: 500,
                termsScheduleId: "cts_standard",
                termsAgreementId: null,
                termsResolvedAt: "2026-07-12T00:00:00.000Z",
              },
              marketplaceSalesFeeUnitAmount: example.fee,
              sellerNetUnitAmount: example.net,
            },
          ],
          updatedAt: "2026-07-12T00:00:00.000Z",
        },
      ];
    });
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      carts: { listCartLines: async () => [], checkout: async () => ({ version: 1 }) } as never,
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
        checkoutSessionId: "chk_cap_examples",
        sourceType: "buy-now",
        shippingOption: "standard",
        shippingAddress,
        lines: examples.map((example) => ({
          listingId: `lst_${example.price}`,
          cartLineId: null,
          catalogItemId: example.productId.split("::")[0]!,
          productId: example.productId,
          itemTitle: `$${example.price} item`,
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: example.quantity,
        })),
      },
      context,
    );

    const created = readAllEvents().find((event) => event.eventType === "ordering.order.created");
    expect(created?.payload).toMatchObject({
      itemSubtotalAmount: "4010.00",
      commercialTermsSnapshot: {
        marketplaceSalesFeeAmount: "120.50",
        sellerNetAmount: "3889.50",
        marketplaceSalesFeeLines: examples.map((example) => ({
          unitPriceAmount: example.price,
          quantity: example.quantity,
          marketplaceSalesFeePercentageBps: 500,
          marketplaceSalesFeeFixedAmount: "0.00",
          marketplaceSalesFeeCapAmount: "25.00",
          marketplaceSalesFeeUnitAmount: example.fee,
          marketplaceSalesFeeTotalAmount: example.quantity === 1 ? example.fee : "75.00",
        })),
      },
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
        shippingPlanSnapshot: {} as never,
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
            gradedCard: null,
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

    await services.cancelPurchase({ orderId: "ord_1", buyerAccountId: "acc_buyer" }, context);

    const cancellationEvent = readAllEvents().find((event) => event.eventType === "ordering.order.cancelled");
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

  it("lets a buyer cancel a paid purchase before fulfillment packing starts", async () => {
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
                shipping_allowance_amount: "4.99",
                shipping_overage_amount: "0.00",
                shipping_charge_amount: "4.99",
                sales_tax_amount: "0.00",
                total_amount: "24.99",
                marketplace_sales_fee_amount: "1.00",
                seller_net_amount: "19.00",
                seller_item_net_amount: "19.00",
                seller_payout_amount: "23.99",
                shipping_allowance_percentage_bps: 500,
                taxable_amount: "24.99",
                tax_jurisdiction_country: "US",
                tax_jurisdiction_state: "IL",
                tax_rate_bps: 0,
                tax_provider_name: "local-tax-stub",
                tax_provider_quote_reference: null,
                tax_quoted_at: "2026-03-31T00:00:00.000Z",
                shipping_destination_snapshot: shippingAddress,
                shipping_origin_snapshot: shipFromAddress,
                terms_schedule_id: "cts_default",
                terms_agreement_id: null,
                terms_resolved_at: "2026-03-31T00:00:00.000Z",
                status: "ready-for-fulfillment",
                created_at: "2026-03-31T00:00:00.000Z",
                updated_at: "2026-04-01T00:00:00.000Z",
                cancelled_at: null,
                cancellation_reason: null,
                ready_for_fulfillment_at: "2026-04-01T00:00:00.000Z",
                self_service_cancellation_available: true,
                cancellation_unavailable_reason: null,
                line_count: 1,
                total_quantity: 1,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };

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
        shippingPlanSnapshot: {} as never,
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
            gradedCard: null,
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
        confirmedAt: "2026-03-31T00:01:00.000Z",
      },
      context,
    });
    await services.commandHandler({
      streamId: "ordering.order-ord_1",
      command: {
        type: "MarkReadyForFulfillment",
        readyForFulfillmentAt: "2026-04-01T00:00:00.000Z",
      },
      context,
    });

    await services.cancelPurchase({ orderId: "ord_1", buyerAccountId: "acc_buyer" }, context);

    expect(readAllEvents().some((event) => event.eventType === "ordering.order.cancelled")).toBe(true);
  });

  it("routes buyer cancellation to support after fulfillment packing starts", async () => {
    const { eventStore } = createInMemoryEventStore();
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
                shipping_allowance_amount: "4.99",
                shipping_overage_amount: "0.00",
                shipping_charge_amount: "4.99",
                sales_tax_amount: "0.00",
                total_amount: "24.99",
                marketplace_sales_fee_amount: "1.00",
                seller_net_amount: "19.00",
                seller_item_net_amount: "19.00",
                seller_payout_amount: "23.99",
                shipping_allowance_percentage_bps: 500,
                taxable_amount: "24.99",
                tax_jurisdiction_country: "US",
                tax_jurisdiction_state: "IL",
                tax_rate_bps: 0,
                tax_provider_name: "local-tax-stub",
                tax_provider_quote_reference: null,
                tax_quoted_at: "2026-03-31T00:00:00.000Z",
                shipping_destination_snapshot: shippingAddress,
                shipping_origin_snapshot: shipFromAddress,
                terms_schedule_id: "cts_default",
                terms_agreement_id: null,
                terms_resolved_at: "2026-03-31T00:00:00.000Z",
                status: "ready-for-fulfillment",
                created_at: "2026-03-31T00:00:00.000Z",
                updated_at: "2026-04-01T00:00:00.000Z",
                cancelled_at: null,
                cancellation_reason: null,
                ready_for_fulfillment_at: "2026-04-01T00:00:00.000Z",
                self_service_cancellation_available: false,
                cancellation_unavailable_reason: "fulfillment-started",
                line_count: 1,
                total_quantity: 1,
              },
            ],
          };
        }

        return { rows: [] };
      }),
    };

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

    await expect(services.cancelPurchase({ orderId: "ord_1", buyerAccountId: "acc_buyer" }, context)).rejects.toThrow(
      "Purchase cancellation is now handled through support because fulfillment has started.",
    );
  });
});
