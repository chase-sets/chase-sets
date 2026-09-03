import { describe, expect, it } from "vitest";
import { createCartReadinessSnapshot } from "../../cart/domain/readiness";
import {
  decideCheckoutSession,
  evolveCheckoutSession,
  initialCheckoutSessionState,
  retainedOrderCartCleanup,
  type CheckoutSessionState,
  type CheckoutSessionEvent,
} from "./domain";

const line = {
  listingId: "lst_1",
  cartLineId: "cli_1",
  catalogItemId: "cat_1",
  productId: "cat_1::",
  itemTitle: "Charizard",
  itemSubtitle: null,
  selectedOptions: [],
  productSummary: null,
  quantity: 1,
  fulfillmentMode: "locked-listing" as const,
  lockedListingId: "lst_1",
  sellerPreferenceId: null,
  availabilityState: "available" as const,
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
        product_measure_snapshot: {
          catalogItemId: "cat_1",
          productId: "cat_1::",
          selectedOptions: [],
          measureVersion: "pm_test_raw_v1",
        },
      },
    ],
    updated_at: "2026-04-29T00:00:00.000Z",
  },
]);

describe("checkout session domain", () => {
  it("retains presented anonymous provenance internally and replays old started events as Account-only", () => {
    const [started] = decideCheckoutSession(initialCheckoutSessionState, {
      type: "StartCheckoutSession",
      sessionId: "chk_union" as never,
      buyerAccountId: "acc_buyer" as never,
      sourceType: "cart",
      shippingOption: "standard",
      cartReadinessSnapshot,
      presentedAnonymousCartId: "anon_raw_marker",
      lines: [line],
      createdAt: "2026-04-29T00:00:00.000Z",
    });

    expect(started?.type).toBe("checkout.session.started");
    if (!started || started.type !== "checkout.session.started") {
      throw new Error("Expected checkout.session.started.");
    }
    expect(started.data).toMatchObject({ presentedAnonymousCartId: "anon_raw_marker" });
    expect(evolveCheckoutSession(initialCheckoutSessionState, started).presentedAnonymousCartId).toBe(
      "anon_raw_marker",
    );

    const { presentedAnonymousCartId: _omitted, ...oldData } = started.data;
    const oldState = evolveCheckoutSession(initialCheckoutSessionState, { ...started, data: oldData });
    expect(oldState.presentedAnonymousCartId).toBeNull();
  });

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
      splitGroupHandoff: {
        status: "ready",
        groups: [
          expect.objectContaining({
            lineIds: ["cli_1"],
            listingIds: ["lst_1"],
            sellerAccountId: "acc_seller",
            downstreamReferenceStatus: "not-started",
          }),
        ],
      },
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

  it("cancels active sessions, releases active reservations, and rejects cancellation after payment starts", () => {
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
    const reserved = decideCheckoutSession(startedState, {
      type: "RecordCheckoutReservations",
      reservations: [
        {
          holdId: "hld_1",
          lineKey: "cli_1",
          sellerAccountId: "acc_seller",
          inventoryItemId: "inv_1",
          quantity: 1,
          expiresAt: "2026-04-29T00:30:00.000Z",
          extensionCount: 0,
          status: "active",
        },
      ],
      recordedAt: "2026-04-29T00:01:00.000Z",
    });
    const reservedState = reserved.reduce(evolveCheckoutSession, startedState);

    const cancelled = decideCheckoutSession(reservedState, {
      type: "CancelCheckoutSession",
      cancelledAt: "2026-04-29T00:02:00.000Z",
    });
    expect(cancelled).toEqual([
      {
        type: "checkout.session.cancelled",
        data: {
          sessionId: "chk_1",
          cancelledAt: "2026-04-29T00:02:00.000Z",
          releasedReservationIds: ["hld_1"],
        },
      },
    ]);
    const cancelledState = cancelled.reduce(evolveCheckoutSession, reservedState);
    expect(cancelledState.cancelledAt).toBe("2026-04-29T00:02:00.000Z");
    expect(cancelledState.checkoutReservations).toEqual([
      expect.objectContaining({
        holdId: "hld_1",
        status: "released",
      }),
    ]);
    expect(
      decideCheckoutSession(cancelledState, {
        type: "CancelCheckoutSession",
        cancelledAt: "2026-04-29T00:03:00.000Z",
      }),
    ).toEqual([]);

    const addressed = decideCheckoutSession(startedState, {
      type: "SetShippingAddress",
      shippingAddress,
      selectedAt: "2026-04-29T00:00:30.000Z",
    });
    const addressedState = addressed.reduce(evolveCheckoutSession, startedState);
    const orders = decideCheckoutSession(addressedState, {
      type: "RecordOrdersCreated",
      orderIds: ["ord_1" as never],
      recordedAt: "2026-04-29T00:01:00.000Z",
    });
    const orderedState = orders.reduce(evolveCheckoutSession, addressedState);
    const payment = decideCheckoutSession(orderedState, {
      type: "RecordPaymentStarted",
      paymentId: "pay_1" as never,
      recordedAt: "2026-04-29T00:01:30.000Z",
    });
    const paidState = payment.reduce(evolveCheckoutSession, orderedState);
    expect(() =>
      decideCheckoutSession(paidState, {
        type: "CancelCheckoutSession",
        cancelledAt: "2026-04-29T00:02:00.000Z",
      }),
    ).toThrow("Checkout sessions cannot be cancelled after payment starts.");
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

  it("rejects cart sessions when split groups do not match checkout lines", () => {
    expect(() =>
      decideCheckoutSession(initialCheckoutSessionState, {
        type: "StartCheckoutSession",
        sessionId: "chk_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sourceType: "cart",
        shippingOption: "standard",
        cartReadinessSnapshot,
        lines: [
          {
            ...line,
            cartLineId: "cli_other",
          },
        ],
        createdAt: "2026-04-29T00:00:00.000Z",
      }),
    ).toThrow("Cart readiness split groups must match checkout line listings.");
  });

  it("rejects cart sessions when readiness omits split group facts", () => {
    expect(() =>
      decideCheckoutSession(initialCheckoutSessionState, {
        type: "StartCheckoutSession",
        sessionId: "chk_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sourceType: "cart",
        shippingOption: "standard",
        cartReadinessSnapshot: {
          ...cartReadinessSnapshot,
          fulfillmentGroups: [],
        },
        lines: [line],
        createdAt: "2026-04-29T00:00:00.000Z",
      }),
    ).toThrow("Cart readiness must include split group facts.");
  });

  it("does not create split group handoff facts for non-cart source intents", () => {
    const started = decideCheckoutSession(initialCheckoutSessionState, {
      type: "StartCheckoutSession",
      sessionId: "chk_buy_now" as never,
      buyerAccountId: "acc_buyer" as never,
      sourceType: "buy-now",
      shippingOption: "standard",
      lines: [
        {
          ...line,
          cartLineId: null,
        },
      ],
      createdAt: "2026-04-29T00:00:00.000Z",
    });

    expect(started[0]?.type).toBe("checkout.session.started");
    if (started[0]?.type !== "checkout.session.started") {
      throw new Error("Expected checkout session started event.");
    }
    expect(started[0].data.splitGroupHandoff).toBeNull();
  });
});

describe("union cleanup retained state replay", () => {
  function started() {
    return decideCheckoutSession(initialCheckoutSessionState, {
      type: "StartCheckoutSession",
      sessionId: "chk_replay" as never,
      buyerAccountId: "acc_buyer" as never,
      sourceType: "cart",
      presentedAnonymousCartId: "anon_raw_cleanup_marker",
      shippingOption: "standard",
      cartReadinessSnapshot,
      lines: [line],
      createdAt: "2026-09-01T00:00:00Z",
    }).reduce(evolveCheckoutSession, initialCheckoutSessionState);
  }
  function pending() {
    const state: CheckoutSessionState = { ...started(), shippingAddress, lines: [line, line] };
    const events = decideCheckoutSession(state, {
      type: "RecordOrdersCreated",
      orderIds: ["ord_1" as never],
      recordedAt: "2026-09-01T01:00:00Z",
    });
    return { state: events.reduce(evolveCheckoutSession, state), events };
  }
  it("reads old no-plan events and snapshots as inert, without reconstructing intent", () => {
    const { events } = pending();
    const event = events[0]!;
    if (event.type !== "checkout.session.orders-created") throw new Error("Expected order event");
    const { orderCartCleanupPlan: _omitted, ...data } = event.data;
    const legacy = evolveCheckoutSession({ ...started(), shippingAddress }, { ...event, data });
    expect(retainedOrderCartCleanup(legacy)).toBeUndefined();
    expect(retainedOrderCartCleanup(JSON.parse(JSON.stringify(legacy)))).toBeUndefined();
    expect(
      decideCheckoutSession(legacy, {
        type: "RecordOrdersCreated",
        orderIds: ["ord_other" as never],
        fulfilledLineKeys: ["cli_other"],
        recordedAt: "later",
      }),
    ).toEqual([]);
  });
  it("retains deduplicated immutable intent and explicit pending/complete day-after states", () => {
    const { state } = pending();
    expect(state.orderCartCleanup).toEqual({
      status: "pending",
      plan: {
        buyerAccountId: "acc_buyer",
        sourceOwnerKeys: ["acc_buyer", "anon_raw_cleanup_marker"],
        lineIds: ["cli_1"],
      },
    });
    expect(
      decideCheckoutSession(state, {
        type: "RecordOrdersCreated",
        orderIds: ["ord_other" as never],
        fulfilledLineKeys: ["other"],
        recordedAt: "later",
      }),
    ).toEqual([]);
    const completion = { type: "CompleteOrderCartCleanup", completedAt: "2026-09-02T00:00:00Z" } as const;
    const complete = decideCheckoutSession(state, completion).reduce(evolveCheckoutSession, state);
    expect(complete.orderCartCleanup?.status).toBe("complete");
    expect(decideCheckoutSession(complete, completion)).toEqual([]);
    expect(complete.updatedAt).toBe(state.updatedAt);
    expect(() => decideCheckoutSession(started(), completion)).toThrow("no retained cart cleanup plan");
  });
  it.each([
    null,
    {},
    { buyerAccountId: "acc_foreign", sourceOwnerKeys: ["acc_foreign"], lineIds: ["cli_1"] },
    { buyerAccountId: "acc_buyer", sourceOwnerKeys: ["acc_buyer", "anon_other"], lineIds: ["cli_1"] },
    { buyerAccountId: "acc_buyer", sourceOwnerKeys: ["acc_buyer", "anon_raw_cleanup_marker"], lineIds: ["foreign"] },
    {
      buyerAccountId: "acc_buyer",
      sourceOwnerKeys: ["acc_buyer", "anon_raw_cleanup_marker"],
      lineIds: ["cli_1", "cli_1"],
    },
  ])("refuses malformed present plan %j in history and snapshots", (plan) => {
    const state: CheckoutSessionState = { ...started(), shippingAddress };
    expect(() =>
      evolveCheckoutSession(state, {
        type: "checkout.session.orders-created",
        data: {
          sessionId: state.sessionId,
          orderIds: ["ord_1"],
          orderWriteCommitPositions: [],
          orderCartCleanupPlan: plan,
          recordedAt: "now",
        },
      } as unknown as CheckoutSessionEvent),
    ).toThrow("Invalid retained cart cleanup plan.");
    expect(() =>
      retainedOrderCartCleanup({
        ...pending().state,
        orderCartCleanup: { status: "pending", plan },
      } as unknown as CheckoutSessionState),
    ).toThrow("Invalid retained cart cleanup plan.");
  });
});
