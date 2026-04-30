import { describe, expect, it } from "vitest";
import {
  decideCheckoutSession,
  evolveCheckoutSession,
  initialCheckoutSessionState,
} from "./domain";

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

describe("checkout session domain", () => {
  it("starts, selects shipping, records orders, and records payment once", () => {
    const started = decideCheckoutSession(initialCheckoutSessionState, {
      type: "StartCheckoutSession",
      sessionId: "chk_1" as never,
      buyerAccountId: "acc_buyer" as never,
      sourceType: "cart",
      shippingOption: "standard",
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

    const orders = decideCheckoutSession(selectedState, {
      type: "RecordOrdersCreated",
      orderIds: ["ord_1" as never],
      recordedAt: "2026-04-29T00:02:00.000Z",
    });
    const orderedState = orders.reduce(evolveCheckoutSession, selectedState);

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
});
