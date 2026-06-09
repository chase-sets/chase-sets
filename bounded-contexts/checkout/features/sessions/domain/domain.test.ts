import { describe, expect, it } from "vitest";
import { createCartReadinessSnapshot } from "../../cart/domain/readiness";
import { decideCheckoutSession, evolveCheckoutSession, initialCheckoutSessionState } from "./domain";

const line = {
  listingId: null,
  cartLineId: "cli_1",
  catalogItemId: "cat_1",
  productId: "cat_1::",
  itemTitle: "Charizard",
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  quantity: 1,
};

const shippingAddress = {
  shippingAddressId: "adr_home" as never,
  name: "Jane Smith",
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
} as const;

const cartReadinessSnapshot = createCartReadinessSnapshot([
  {
    line_id: "cli_1",
    catalog_catalog_item_id: "cat_1",
    product_id: "cat_1::",
    item_title: "Charizard",
    quantity: 1,
    fulfillment_mode: "locked-listing",
    locked_listing_id: "lst_1",
    seller_preference_id: null,
    availability_state: "available",
    seller_options: [
      {
        listing_id: "lst_1",
        seller_account_id: "acc_seller",
        seller_display_name: "Card Vault",
        price_amount: "25.00",
        available_quantity: 1,
        product_summary: null,
      },
    ],
    updated_at: "2026-04-29T00:00:00.000Z",
  },
]);

describe("checkout session domain", () => {
  it("starts, selects shipping, records orders, and records payment once", () => {
    const started = decideCheckoutSession(initialCheckoutSessionState, {
      type: "StartCheckoutSession",
      sessionId: "chk_1" as never,
      buyerAccountId: "acc_buyer" as never,
      sourceType: "cart",
      shippingOption: "standard",
      cartReadinessSnapshot,
      lines: [line],
      createdAt: "2026-04-29T00:00:00.000Z",
    });
    const startedState = started.reduce(evolveCheckoutSession, initialCheckoutSessionState);

    const selected = decideCheckoutSession(startedState, {
      type: "SelectShippingOption",
      shippingOption: "priority",
      selectedAt: "2026-04-29T00:01:00.000Z",
    });
    const selectedState = selected.reduce(evolveCheckoutSession, startedState);

    const addressed = decideCheckoutSession(selectedState, {
      type: "SetShippingAddress",
      shippingAddress,
      selectedAt: "2026-04-29T00:01:30.000Z",
    });
    const addressedState = addressed.reduce(evolveCheckoutSession, selectedState);

    const orders = decideCheckoutSession(addressedState, {
      type: "RecordOrdersCreated",
      orderIds: ["ord_1" as never],
      recordedAt: "2026-04-29T00:02:00.000Z",
    });
    const orderedState = orders.reduce(evolveCheckoutSession, addressedState);

    const payment = decideCheckoutSession(orderedState, {
      type: "RecordPaymentStarted",
      paymentId: "pay_1" as never,
      recordedAt: "2026-04-29T00:03:00.000Z",
    });
    const paidState = payment.reduce(evolveCheckoutSession, orderedState);

    expect(paidState).toMatchObject({
      sessionId: "chk_1",
      sourceType: "cart",
      shippingOption: "priority",
      shippingAddress,
      orderIds: ["ord_1"],
      paymentId: "pay_1",
    });
    expect(
      decideCheckoutSession(paidState, {
        type: "RecordPaymentStarted",
        paymentId: "pay_1" as never,
        recordedAt: "2026-04-29T00:04:00.000Z",
      }),
    ).toEqual([]);
  });

  it("rejects cart sessions without a resolved readiness snapshot", () => {
    expect(() =>
      decideCheckoutSession(initialCheckoutSessionState, {
        type: "StartCheckoutSession",
        sessionId: "chk_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sourceType: "cart",
        shippingOption: "standard",
        lines: [line],
        createdAt: "2026-04-29T00:00:00.000Z",
      }),
    ).toThrow("Cart readiness snapshot is required.");
  });
});
