import { describe, expect, it } from "vitest";
import { createCartReadinessSnapshot } from "../../cart/domain/readiness";
import {
  decideCheckoutSession,
  evolveCheckoutSession,
  initialCheckoutSessionState,
  retainedOrderCartCleanup,
  type CheckoutSessionCommand,
  type CheckoutSessionState,
  type CheckoutSessionEvent,
} from "./domain";
import type { CheckoutFulfillmentPreview } from "./fulfillment-preview";

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
        price_currency_code: "USD",
        listing_stream_version: 7,
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

  it("rejects cart sessions when a cart line omits its selected Listing", () => {
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
            listingId: null,
            fulfillmentMode: "optimize",
            lockedListingId: null,
          },
        ],
        createdAt: "2026-04-29T00:00:00.000Z",
      }),
    ).toThrow("Cart lines require selected Listings.");
  });

  it("rejects cart sessions when a fulfillment group omits its selected Listing", () => {
    expect(() =>
      decideCheckoutSession(initialCheckoutSessionState, {
        type: "StartCheckoutSession",
        sessionId: "chk_1" as never,
        buyerAccountId: "acc_buyer" as never,
        sourceType: "cart",
        shippingOption: "standard",
        cartReadinessSnapshot: {
          ...cartReadinessSnapshot,
          fulfillmentGroups: cartReadinessSnapshot.fulfillmentGroups.map((group) => ({
            ...group,
            listingIds: [],
          })),
        },
        lines: [line],
        createdAt: "2026-04-29T00:00:00.000Z",
      }),
    ).toThrow("Cart groups require lines and selected Listings.");
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

describe("last recorded quote", () => {
  // Keyed by the event union, so a new session event fails typecheck here until
  // this enumeration states how it treats the retained quote.
  const everySessionEvent: Record<CheckoutSessionEvent["type"], true> = {
    "checkout.session.started": true,
    "checkout.session.optimization-goal-selected": true,
    "checkout.session.fulfillment-preview-recorded": true,
    "checkout.session.shipping-option-selected": true,
    "checkout.session.shipping-address-set": true,
    "checkout.session.authenticity-check-opt-in-selected": true,
    "checkout.session.orders-created": true,
    "checkout.session.cart-cleanup-completed": true,
    "checkout.session.reservations-recorded": true,
    "checkout.session.payment-started": true,
    "checkout.session.offer-submitted": true,
    "checkout.session.cancelled": true,
  };
  const at = (minute: number) => `2026-10-18T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const quote = (revision: string, totalAmount: string): CheckoutFulfillmentPreview => ({
    revision,
    optimizationGoal: "lowest-total",
    readyLineKeys: ["lst_1"],
    unavailableLineKeys: [],
    sellerGroups: [],
    totals: {
      itemSubtotalAmount: "25.00",
      shippingAmount: "4.00",
      salesTaxAmount: "0.00",
      totalAmount,
      packageCount: 1,
    },
    unavailableLines: [],
    materialChangeReasons: [],
  });
  const q1 = quote("rev_q1", "29.00");
  const q2 = quote("rev_q2", "31.00");
  const reservation = {
    holdId: "hld_1",
    lineKey: "lst_1",
    sellerAccountId: "acc_seller",
    inventoryItemId: "inv_1",
    quantity: 1,
    expiresAt: "2026-10-18T00:30:00.000Z",
    extensionCount: 0,
    status: "active" as const,
  };

  function session(seen: Set<string>) {
    return (state: CheckoutSessionState, command: CheckoutSessionCommand) => {
      const events = decideCheckoutSession(state, command);
      expect(events, command.type).not.toEqual([]);
      for (const event of events) seen.add(event.type);
      return events.reduce(evolveCheckoutSession, state);
    };
  }
  const quoteFacts = (state: CheckoutSessionState) => ({
    lastRecordedQuote: state.lastRecordedQuote,
    fulfillmentPreviewSnapshot: state.fulfillmentPreviewSnapshot,
    fulfillmentPreviewRevision: state.fulfillmentPreviewRevision,
  });
  const invalidated = (lastRecordedQuote: CheckoutFulfillmentPreview | null) => ({
    lastRecordedQuote,
    fulfillmentPreviewSnapshot: null,
    fulfillmentPreviewRevision: null,
  });
  const start = (
    sourceType: "buy-now" | "cart" | "offer-intent",
    preview?: CheckoutFulfillmentPreview,
  ): CheckoutSessionCommand => ({
    type: "StartCheckoutSession",
    sessionId: `chk_quote_${sourceType}` as never,
    buyerAccountId: "acc_buyer" as never,
    sourceType,
    shippingOption: "standard",
    fulfillmentPreviewRevision: preview?.revision ?? null,
    fulfillmentPreviewSnapshot: preview ?? null,
    ...(sourceType === "cart" ? { cartReadinessSnapshot } : {}),
    lines: [
      sourceType === "cart"
        ? line
        : sourceType === "buy-now"
          ? { ...line, cartLineId: null }
          : {
              ...line,
              listingId: null,
              cartLineId: null,
              lockedListingId: null,
              fulfillmentMode: "optimize" as const,
              offerPriceAmount: "20.00",
              offerPriceCurrencyCode: "USD",
            },
    ],
    createdAt: at(0),
  });

  function buyNowThroughInvalidationCancelAndOrders(seen: Set<string>) {
    const apply = session(seen);
    let state = apply(initialCheckoutSessionState, start("buy-now", q1));
    expect(quoteFacts(state)).toEqual({
      lastRecordedQuote: q1,
      fulfillmentPreviewSnapshot: q1,
      fulfillmentPreviewRevision: "rev_q1",
    });

    for (const command of [
      { type: "SelectOptimizationGoal", optimizationGoal: "fewest-shipments", selectedAt: at(1) },
      { type: "SelectShippingOption", shippingOption: "priority", selectedAt: at(2) },
      { type: "SetShippingAddress", shippingAddress, selectedAt: at(3) },
      { type: "SelectAuthenticityCheckOptIn", selected: false, quoteFingerprint: null, selectedAt: at(4) },
      { type: "RecordCheckoutReservations", reservations: [reservation], recordedAt: at(5) },
    ] satisfies CheckoutSessionCommand[]) {
      state = apply(state, command);
      expect(quoteFacts(state), command.type).toEqual(invalidated(q1));
    }
    expect(quoteFacts(apply(state, { type: "CancelCheckoutSession", cancelledAt: at(6) }))).toEqual(invalidated(q1));

    // A revision-only record carries no quote, so the last recorded quote stays.
    state = apply(state, {
      type: "RecordFulfillmentPreview",
      fulfillmentPreviewRevision: "rev_ack",
      recordedAt: at(7),
    });
    expect(quoteFacts(state)).toEqual({
      lastRecordedQuote: q1,
      fulfillmentPreviewSnapshot: null,
      fulfillmentPreviewRevision: "rev_ack",
    });
    state = apply(state, {
      type: "RecordFulfillmentPreview",
      fulfillmentPreviewRevision: "rev_q2",
      fulfillmentPreviewSnapshot: q2,
      recordedAt: at(8),
    });
    expect(quoteFacts(state)).toEqual({
      lastRecordedQuote: q2,
      fulfillmentPreviewSnapshot: q2,
      fulfillmentPreviewRevision: "rev_q2",
    });

    // Confirm sets the address, clearing the live snapshot, just before it creates orders.
    for (const command of [
      { type: "SetShippingAddress", shippingAddress, selectedAt: at(9) },
      { type: "RecordOrdersCreated", orderIds: ["ord_1" as never], recordedAt: at(10) },
      { type: "RecordPaymentStarted", paymentId: "pay_1" as never, recordedAt: at(11) },
    ] satisfies CheckoutSessionCommand[]) {
      state = apply(state, command);
      expect(quoteFacts(state), command.type).toEqual(invalidated(q2));
    }
  }

  it("retains the last recorded quote through invalidation", () => {
    buyNowThroughInvalidationCancelAndOrders(new Set());
  });

  it("keeps the retained quote on every other session event and stays null when never quoted", () => {
    const seen = new Set<string>();
    buyNowThroughInvalidationCancelAndOrders(seen);
    const apply = session(seen);

    let neverQuoted = apply(initialCheckoutSessionState, start("cart"));
    expect(neverQuoted.lastRecordedQuote).toBeNull();
    for (const command of [
      { type: "SetShippingAddress", shippingAddress, selectedAt: at(1) },
      { type: "CancelCheckoutSession", cancelledAt: at(2) },
    ] satisfies CheckoutSessionCommand[]) {
      neverQuoted = apply(neverQuoted, command);
      expect(quoteFacts(neverQuoted), command.type).toEqual(invalidated(null));
    }

    let cart = apply(initialCheckoutSessionState, start("cart"));
    for (const command of [
      {
        type: "RecordFulfillmentPreview",
        fulfillmentPreviewRevision: "rev_q1",
        fulfillmentPreviewSnapshot: q1,
        recordedAt: at(1),
      },
      { type: "SetShippingAddress", shippingAddress, selectedAt: at(2) },
      { type: "RecordOrdersCreated", orderIds: ["ord_cart" as never], recordedAt: at(3) },
      { type: "CompleteOrderCartCleanup", completedAt: at(4) },
    ] satisfies CheckoutSessionCommand[]) {
      cart = apply(cart, command);
      expect(cart.lastRecordedQuote, command.type).toEqual(q1);
    }
    expect(cart.orderCartCleanup?.status).toBe("complete");

    let offer = apply(initialCheckoutSessionState, start("offer-intent"));
    expect(offer.lastRecordedQuote).toBeNull();
    for (const command of [
      {
        type: "RecordFulfillmentPreview",
        fulfillmentPreviewRevision: "rev_q1",
        fulfillmentPreviewSnapshot: q1,
        recordedAt: at(1),
      },
      { type: "SetShippingAddress", shippingAddress, selectedAt: at(2) },
      { type: "RecordOfferSubmitted", offerId: "off_1", recordedAt: at(3) },
    ] satisfies CheckoutSessionCommand[]) {
      offer = apply(offer, command);
    }
    expect(quoteFacts(offer)).toEqual(invalidated(q1));

    expect([...seen].sort()).toEqual(Object.keys(everySessionEvent).sort());
  });
});
