import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import {
  context,
  createCheckpointStore,
  createOrderingOrderRuntimeForTest,
  createSupplyDb,
  shippingAddress,
} from "./runtime-test-harness";

const authenticityFeePolicyResolver = {
  resolveAuthenticityFeePolicy: vi.fn(async () => ({
    value: {
      optInThresholdAmount: "100.00",
      bands: [
        {
          minOrderValueAmount: "0.00",
          category: "any" as const,
          flatAmount: "8.00",
          percentageBps: 200,
          capAmount: "50.00",
        },
      ],
    },
    source: "policy" as const,
    documentId: "pol_authenticity_fee",
    effectiveFrom: "2026-05-03T00:00:00.000Z",
    resolvedAt: "2026-05-03T00:00:01.000Z",
  })),
};

function highValueSupplyDb() {
  return createSupplyDb(() => [
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
      priceAmount: "150.00",
      availableQuantity: 1,
      updatedAt: "2026-03-31T00:00:00.000Z",
    },
  ]);
}

function checkoutLines() {
  return [
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
  ];
}

describe("ordering order runtime: authenticity check opt-in (m109 #4275)", () => {
  it("offers an eligible authenticity check quote in the checkout preview above the opt-in threshold", async () => {
    const { eventStore } = createInMemoryEventStore();
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: highValueSupplyDb() as never,
      shippingQuotePolicy: {
        quote: () => ({ shippingOption: "standard", baseAmount: "4.99", discountAmount: "0.00", chargeAmount: "4.99" }),
      },
      authenticityFeePolicyResolver,
    });

    const preview = await services.previewCheckoutFulfillment({
      buyerAccountId: "acc_buyer" as never,
      checkoutSessionId: "chk_authenticity",
      sourceType: "cart-checkout",
      shippingOption: "standard",
      shippingAddress,
      lines: checkoutLines(),
    });

    expect(preview.authenticityCheckOffer).toMatchObject({
      eligible: true,
      order_value_amount: "150.00",
      fee_amount: "11.00",
    });
  });

  it("does not offer the authenticity check when the resolver host port is not wired", async () => {
    const { eventStore } = createInMemoryEventStore();
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: highValueSupplyDb() as never,
      shippingQuotePolicy: {
        quote: () => ({ shippingOption: "standard", baseAmount: "4.99", discountAmount: "0.00", chargeAmount: "4.99" }),
      },
    });

    const preview = await services.previewCheckoutFulfillment({
      buyerAccountId: "acc_buyer" as never,
      checkoutSessionId: "chk_no_resolver",
      sourceType: "cart-checkout",
      shippingOption: "standard",
      shippingAddress,
      lines: checkoutLines(),
    });

    expect(preview.authenticityCheckOffer).toBeNull();
  });

  it("freezes the authenticity plan onto the order and adds the fee to the order total when the buyer opts in", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: highValueSupplyDb() as never,
      shippingQuotePolicy: {
        quote: () => ({ shippingOption: "standard", baseAmount: "4.99", discountAmount: "0.00", chargeAmount: "4.99" }),
      },
      authenticityFeePolicyResolver,
    });

    const checkoutParams = {
      buyerAccountId: "acc_buyer" as never,
      checkoutSessionId: "chk_authenticity_optin",
      sourceType: "cart-checkout" as const,
      shippingOption: "standard" as const,
      shippingAddress,
      lines: checkoutLines(),
    };

    const preview = await services.previewCheckoutFulfillment(checkoutParams);
    const quoteFingerprint = preview.authenticityCheckOffer?.quote_fingerprint;
    expect(quoteFingerprint).toBeTruthy();

    await services.createOrdersFromCheckout(
      { ...checkoutParams, authenticityCheckOptIn: { selected: true, quoteFingerprint: quoteFingerprint! } },
      context,
    );

    const createdEvents = readAllEvents()
      .filter((event) => event.eventType === "ordering.order.created")
      .map((event) => event.payload as { authenticityPlanSnapshot: unknown; totalAmount: string });

    expect(createdEvents).toEqual([
      expect.objectContaining({
        totalAmount: "161.00",
        authenticityPlanSnapshot: expect.objectContaining({
          feeAmount: "11.00",
          payer: "buyer",
          policyVersion: "authenticity-check-fee-v1",
        }),
      }),
    ]);
  });

  it("rejects checkout with a stale authenticity fee quote fingerprint", async () => {
    const { eventStore } = createInMemoryEventStore();
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: highValueSupplyDb() as never,
      shippingQuotePolicy: {
        quote: () => ({ shippingOption: "standard", baseAmount: "4.99", discountAmount: "0.00", chargeAmount: "4.99" }),
      },
      authenticityFeePolicyResolver,
    });

    const checkoutParams = {
      buyerAccountId: "acc_buyer" as never,
      checkoutSessionId: "chk_authenticity_stale",
      sourceType: "cart-checkout" as const,
      shippingOption: "standard" as const,
      shippingAddress,
      lines: checkoutLines(),
    };

    await expect(
      services.createOrdersFromCheckout(
        { ...checkoutParams, authenticityCheckOptIn: { selected: true, quoteFingerprint: "stale-fingerprint" } },
        context,
      ),
    ).rejects.toThrow("authenticity_fee_quote_stale:");
  });

  it("rejects an authenticity check opt-in when order value has fallen below the threshold", async () => {
    const { eventStore } = createInMemoryEventStore();
    const lowValueDb = createSupplyDb(() => [
      {
        listingId: "lst_low",
        sellerAccountId: "acc_seller",
        inventoryItemId: "inv_low",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Common card",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        storageLocationName: "North shelf",
        shipFromCode: "CHI",
        priceAmount: "5.00",
        availableQuantity: 1,
        updatedAt: "2026-03-31T00:00:00.000Z",
      },
    ]);
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: lowValueDb as never,
      shippingQuotePolicy: {
        quote: () => ({ shippingOption: "standard", baseAmount: "4.99", discountAmount: "0.00", chargeAmount: "4.99" }),
      },
      authenticityFeePolicyResolver,
    });

    const checkoutParams = {
      buyerAccountId: "acc_buyer" as never,
      checkoutSessionId: "chk_authenticity_ineligible",
      sourceType: "cart-checkout" as const,
      shippingOption: "standard" as const,
      shippingAddress,
      lines: checkoutLines(),
    };

    await expect(
      services.createOrdersFromCheckout(
        { ...checkoutParams, authenticityCheckOptIn: { selected: true, quoteFingerprint: "anything" } },
        context,
      ),
    ).rejects.toThrow("Authenticity check is no longer available for this order.");
  });
});
