import { describe, expect, it } from "vitest";
import type { PackagePlan } from "@chase-sets/product-measures";
import { decideOrderingOrder, evolveOrderingOrder, initialOrderingOrderState } from "./domain";
import type {
  CreateOrderCommand,
  OrderCancelledEvent,
  OrderingOrderEvent,
  OrderingOrderState,
  OrderStatusBeforeCancellation,
} from "./domain";

const commercialTermsSnapshot = {
  marketplaceSalesFeeAmount: "1.00",
  sellerNetAmount: "19.00",
  termsScheduleId: "cts_default",
  termsAgreementId: null,
  termsResolvedAt: "2026-03-31T00:00:00.000Z",
} as const;

const orderLineFees = {
  marketplaceSalesFeeUnitAmount: "1.00",
  marketplaceSalesFeeTotalAmount: "1.00",
  sellerNetUnitAmount: "19.00",
  sellerNetTotalAmount: "19.00",
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

const orderTaxFields = {
  salesTaxAmount: "0.00",
  taxSnapshot,
} as const;

const orderAddressSnapshots = {
  shippingDestinationSnapshot: {
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
  },
  shippingOriginSnapshot: {
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
  },
} as const;

const shippingPlanSnapshot: PackagePlan = {
  packagePlanVersion: "test-package-plan-v1",
  packageCount: 1,
  packages: [
    {
      packageId: "pkg_1",
      mailpieceClass: "parcel",
      lengthInches: 7,
      widthInches: 5,
      heightInches: 1,
      weightOunces: 4,
      billableWeightOunces: 4,
      serviceLevel: "standard-parcel",
      productMeasureVersions: ["pmv_1"],
    },
  ],
  letterEligibility: {
    eligible: false,
    reasons: ["test-order-uses-parcel"],
  },
  missingProductIds: [],
};

describe("ordering order domain", () => {
  const createOrderCommand = (sourceType: "cart-checkout" | "buy-now" | "offer-acceptance"): CreateOrderCommand => ({
    type: "CreateOrder",
    orderId: `ord_${sourceType}`,
    sourceType,
    sourceReferenceId: null,
    buyerAccountId: "acc_buyer",
    sellerAccountId: "acc_seller",
    shippingOption: "standard",
    itemSubtotalAmount: "20.00",
    shippingBaseAmount: "4.99",
    shippingDiscountAmount: "0.00",
    shippingChargeAmount: "4.99",
    shippingPlanSnapshot,
    ...orderTaxFields,
    totalAmount: "24.99",
    ...orderAddressSnapshots,
    commercialTermsSnapshot,
    lines: [
      {
        lineId: "oli_1",
        listingId: "lst_1",
        inventoryItemId: "inv_1",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        gradedCard: null,
        unitPriceAmount: "20.00",
        quantity: 1,
        lineTotalAmount: "20.00",
        ...orderLineFees,
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
  });

  it("creates and cancels a pending order", () => {
    const created = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout"));
    const createdState = created.reduce(evolveOrderingOrder, initialOrderingOrderState);
    const cancelled = decideOrderingOrder(createdState, {
      type: "CancelOrder",
      cancelledAt: "2026-03-31T00:00:00.000Z",
      reason: "buyer-cancelled",
    }).reduce(evolveOrderingOrder, createdState);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).toBe("2026-03-31T00:00:00.000Z");
    expect(
      decideOrderingOrder(cancelled, {
        type: "MarkReadyForFulfillment",
        readyForFulfillmentAt: "2026-04-01T00:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("publishes line-item amounts in an additive event without changing order-created", () => {
    const events = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout"));

    expect(events.map((event) => event.type)).toEqual([
      "ordering.order.created",
      "ordering.order.line-item-amounts-published",
    ]);
    expect(events[1]).toMatchObject({
      data: { orderId: "ord_cart-checkout", lineItems: [{ lineId: "oli_1", amount: "20.00" }] },
    });
  });

  it("snapshots one buyer Shipping amount from shipping and protection overflow", () => {
    const command: CreateOrderCommand = {
      ...createOrderCommand("cart-checkout"),
      shippingAllowanceAmount: "0.80",
      shippingOverageAmount: "4.19",
      protectionAmount: "0.20",
      protectionAllowanceAmount: "0.20",
      protectionOverageAmount: "0.00",
      shippingChargeAmount: "4.19",
      totalAmount: "24.19",
      commercialTermsSnapshot: {
        ...commercialTermsSnapshot,
        shippingAllowanceAmount: "0.80",
        sellerShippingPayoutAmount: "4.19",
        protectionAmount: "0.20",
        protectionAllowanceAmount: "0.20",
        protectionOverageAmount: "0.00",
        sellerPayoutAmount: "22.99",
      },
    };

    expect(decideOrderingOrder(initialOrderingOrderState, command)[0]).toMatchObject({
      type: "ordering.order.created",
      data: {
        shippingOverageAmount: "4.19",
        protectionAmount: "0.20",
        protectionAllowanceAmount: "0.20",
        protectionOverageAmount: "0.00",
        shippingChargeAmount: "4.19",
      },
    });
  });

  it("creates an order with no authenticity plan when the buyer did not opt in", () => {
    const createdState = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout")).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );

    expect(createdState.authenticityPlanSnapshot).toBeNull();
  });

  it("freezes the authenticity plan onto the order when the buyer opted in at checkout", () => {
    const command: CreateOrderCommand = {
      ...createOrderCommand("cart-checkout"),
      totalAmount: "34.99",
      authenticityPlanSnapshot: {
        feeAmount: "10.00",
        payer: "buyer",
        policyVersion: "authenticity-check-fee-v1",
        category: "any",
        thresholdAmount: "100.00",
        orderValueAmount: "150.00",
        quotedAt: "2026-03-31T00:00:00.000Z",
      },
    };
    const createdState = decideOrderingOrder(initialOrderingOrderState, command).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );

    expect(createdState.authenticityPlanSnapshot).toEqual({
      feeAmount: "10.00",
      payer: "buyer",
      policyVersion: "authenticity-check-fee-v1",
      category: "any",
      thresholdAmount: "100.00",
      orderValueAmount: "150.00",
      quotedAt: "2026-03-31T00:00:00.000Z",
    });
  });

  it("rejects a line total that does not equal unit price times quantity", () => {
    const command = createOrderCommand("cart-checkout");

    expect(() =>
      decideOrderingOrder(initialOrderingOrderState, {
        ...command,
        itemSubtotalAmount: "39.99",
        totalAmount: "44.98",
        lines: [{ ...command.lines[0]!, quantity: 2, lineTotalAmount: "39.99" }],
      }),
    ).toThrow("Order line total must equal unit price times quantity.");
  });

  it("rejects an item subtotal that does not equal the sum of line totals", () => {
    expect(() =>
      decideOrderingOrder(initialOrderingOrderState, {
        ...createOrderCommand("cart-checkout"),
        itemSubtotalAmount: "19.99",
        totalAmount: "24.98",
      }),
    ).toThrow("Order item subtotal must equal the sum of line totals.");
  });

  it("rejects an order total that does not equal every buyer charge component", () => {
    expect(() =>
      decideOrderingOrder(initialOrderingOrderState, {
        ...createOrderCommand("cart-checkout"),
        totalAmount: "25.00",
      }),
    ).toThrow("Order total must equal item subtotal, Shipping, sales tax, and authenticity check fee.");
  });

  it("rejects a line whose marketplace fee and seller net do not equal its line total", () => {
    const command = createOrderCommand("cart-checkout");

    expect(() =>
      decideOrderingOrder(initialOrderingOrderState, {
        ...command,
        commercialTermsSnapshot: {
          ...command.commercialTermsSnapshot,
          marketplaceSalesFeeAmount: "1.01",
          sellerNetAmount: "19.00",
        },
        lines: [
          {
            ...command.lines[0]!,
            marketplaceSalesFeeUnitAmount: "1.01",
            marketplaceSalesFeeTotalAmount: "1.01",
            sellerNetUnitAmount: "19.00",
            sellerNetTotalAmount: "19.00",
          },
        ],
      }),
    ).toThrow("Order line marketplace fee plus seller net must equal the line total.");
  });

  it("marks a pending order ready for fulfillment after payment capture", () => {
    const createdState = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout")).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );

    const pendingPaymentState = decideOrderingOrder(createdState, {
      type: "RecordReservationConfirmed",
      reservationRequestId: "rsv_1",
      holdId: "hld_1",
      confirmedAt: "2026-03-31T00:00:00.000Z",
    }).reduce(evolveOrderingOrder, createdState);

    const ready = decideOrderingOrder(pendingPaymentState, {
      type: "MarkReadyForFulfillment",
      readyForFulfillmentAt: "2026-04-01T00:00:00.000Z",
    }).reduce(evolveOrderingOrder, pendingPaymentState);

    expect(ready.status).toBe("ready-for-fulfillment");
    expect(ready.readyForFulfillmentAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("stamps a policy-tokenized payment deadline when reservations are confirmed", () => {
    const createdState = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout")).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );

    const events = decideOrderingOrder(createdState, {
      type: "RecordReservationConfirmed",
      reservationRequestId: "rsv_1",
      holdId: "hld_1",
      confirmedAt: "2026-03-31T00:00:00.000Z",
    });

    expect(events).toContainEqual({
      type: "ordering.order.pending-payment-recorded",
      data: {
        orderId: "ord_cart-checkout",
        pendingPaymentAt: "2026-03-31T00:00:00.000Z",
        paymentDeadlineAt: "2026-03-31T01:00:00.000Z",
        paymentDeadlinePolicy: "ordering-payment-deadline-card-v1",
      },
    });
  });

  it("rejects a reservation confirmation for an unknown request", () => {
    const createdState = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout")).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );

    expect(() =>
      decideOrderingOrder(createdState, {
        type: "RecordReservationConfirmed",
        reservationRequestId: "rsv_missing",
        holdId: "hld_1",
        confirmedAt: "2026-03-31T00:00:00.000Z",
      }),
    ).toThrow("Reservation confirmation must reference an existing reservation request.");
  });

  it("rejects payment-deadline cancellation after payment capture wins the race", () => {
    const createdState = decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout")).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );
    const pendingPaymentState = decideOrderingOrder(createdState, {
      type: "RecordReservationConfirmed",
      reservationRequestId: "rsv_1",
      holdId: "hld_1",
      confirmedAt: "2026-03-31T00:00:00.000Z",
    }).reduce(evolveOrderingOrder, createdState);
    const readyState = decideOrderingOrder(pendingPaymentState, {
      type: "MarkReadyForFulfillment",
      readyForFulfillmentAt: "2026-03-31T00:59:59.000Z",
    }).reduce(evolveOrderingOrder, pendingPaymentState);

    expect(() =>
      decideOrderingOrder(readyState, {
        type: "CancelOrder",
        cancelledAt: "2026-03-31T01:00:00.000Z",
        reason: "payment-deadline",
      }),
    ).toThrow("Payment-deadline cancellation requires a pending-payment order.");
  });

  it("rejects invalid order creation", () => {
    expect(() =>
      decideOrderingOrder(initialOrderingOrderState, {
        type: "CreateOrder",
        orderId: "ord_1",
        sourceType: "cart-checkout",
        sourceReferenceId: null,
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        shippingOption: "standard",
        itemSubtotalAmount: "0.00",
        shippingBaseAmount: "4.99",
        shippingDiscountAmount: "0.00",
        shippingChargeAmount: "4.99",
        shippingPlanSnapshot,
        ...orderTaxFields,
        totalAmount: "4.99",
        ...orderAddressSnapshots,
        commercialTermsSnapshot,
        lines: [],
        reservationRequests: [],
      }),
    ).toThrow("Orders must include at least one line.");
  });

  it.each(["cart-checkout", "buy-now", "offer-acceptance"] as const)(
    "rejects same-account self-dealing order creation from %s",
    (sourceType) => {
      expect(() =>
        decideOrderingOrder(initialOrderingOrderState, {
          ...createOrderCommand(sourceType),
          buyerAccountId: "acc_same",
          sellerAccountId: "acc_same",
          reservationRequests: [
            {
              reservationRequestId: "rsv_1",
              inventoryItemId: "inv_1",
              sellerAccountId: "acc_same",
              quantity: 1,
            },
          ],
        }),
      ).toThrow("Buyer and seller accounts must be different for an order.");
    },
  );

  const isCancelledEvent = (event: OrderingOrderEvent): event is OrderCancelledEvent =>
    event.type === "ordering.order.cancelled";

  const cancelledEventFrom = (events: readonly OrderingOrderEvent[]): OrderCancelledEvent => {
    const cancelled = events.find(isCancelledEvent);
    if (cancelled === undefined) {
      throw new Error(`Expected a cancellation event, saw [${events.map((event) => event.type).join(", ")}].`);
    }
    return cancelled;
  };

  // The three reachable pre-cancellation states, each built by driving real transitions
  // rather than hand-assembling aggregate state.
  const pendingReservationState = (): OrderingOrderState =>
    decideOrderingOrder(initialOrderingOrderState, createOrderCommand("cart-checkout")).reduce(
      evolveOrderingOrder,
      initialOrderingOrderState,
    );

  const pendingPaymentState = (): OrderingOrderState => {
    const created = pendingReservationState();
    return decideOrderingOrder(created, {
      type: "RecordReservationConfirmed",
      reservationRequestId: "rsv_1",
      holdId: "hld_1",
      confirmedAt: "2026-03-31T00:00:00.000Z",
    }).reduce(evolveOrderingOrder, created);
  };

  const readyForFulfillmentState = (): OrderingOrderState => {
    const pendingPayment = pendingPaymentState();
    return decideOrderingOrder(pendingPayment, {
      type: "MarkReadyForFulfillment",
      readyForFulfillmentAt: "2026-03-31T00:30:00.000Z",
    }).reduce(evolveOrderingOrder, pendingPayment);
  };

  const releasedAtReadyForFulfillmentState = (): OrderingOrderState => {
    const ready = readyForFulfillmentState();
    return decideOrderingOrder(ready, {
      type: "RecordReservationReleased",
      reservationRequestId: "rsv_1",
      holdId: "hld_1",
      releasedAt: "2026-03-31T00:40:00.000Z",
    }).reduce(evolveOrderingOrder, ready);
  };

  const rejectReservation = (state: OrderingOrderState, reservationRequestId: string) =>
    decideOrderingOrder(state, {
      type: "RecordReservationRejected",
      reservationRequestId,
      rejectedAt: "2026-03-31T03:00:00.000Z",
      reason: "inventory-unavailable",
    });

  it("pre-cancellation status excludes cancelled and the pre-creation null", () => {
    const pendingReservation: OrderStatusBeforeCancellation = "pending-reservation";
    const pendingPayment: OrderStatusBeforeCancellation = "pending-payment";
    const readyForFulfillment: OrderStatusBeforeCancellation = "ready-for-fulfillment";
    // @ts-expect-error null is the pre-creation sentinel, never a pre-cancellation status.
    const preCreation: OrderStatusBeforeCancellation = null;
    // @ts-expect-error cancelled is the post-transition steady state.
    const cancelled: OrderStatusBeforeCancellation = "cancelled";

    expect([pendingReservation, pendingPayment, readyForFulfillment]).toEqual([
      "pending-reservation",
      "pending-payment",
      "ready-for-fulfillment",
    ]);
    void preCreation;
    void cancelled;
  });

  it("both cancellation emitters carry buyer account and pre-cancellation status", () => {
    const viaCancelOrder = cancelledEventFrom(
      decideOrderingOrder(pendingReservationState(), {
        type: "CancelOrder",
        cancelledAt: "2026-03-31T02:00:00.000Z",
        reason: "buyer-cancelled",
      }),
    );
    const viaReservationRejection = cancelledEventFrom(rejectReservation(pendingReservationState(), "rsv_1"));

    // Buyer identity is the aggregate's own buyer, never the acting party.
    expect(viaCancelOrder.data).toMatchObject({
      buyerAccountId: "acc_buyer",
      statusBeforeCancellation: "pending-reservation",
    });
    expect(viaReservationRejection.data).toMatchObject({
      buyerAccountId: "acc_buyer",
      statusBeforeCancellation: "pending-reservation",
    });
  });

  it("pre-cancellation status equals the emission-site aggregate status", () => {
    // Per-emitter transition-derived rows. Each CancelOrder row uses a reason admissible at
    // that row's status: `payment-deadline` is admitted only at `pending-payment`.
    const rows = [
      {
        emitter: "CancelOrder",
        status: "pending-reservation",
        buildState: pendingReservationState,
        reason: "buyer-cancelled",
      },
      {
        emitter: "CancelOrder",
        status: "pending-payment",
        buildState: pendingPaymentState,
        reason: "payment-deadline",
      },
      {
        emitter: "CancelOrder",
        status: "ready-for-fulfillment",
        buildState: readyForFulfillmentState,
        reason: "seller-cancelled",
      },
      {
        emitter: "RecordReservationRejected",
        status: "pending-reservation",
        buildState: pendingReservationState,
        reason: "inventory-unavailable",
      },
    ] as const;

    const observed = rows.map((row) => {
      const state = row.buildState();
      const events =
        row.emitter === "CancelOrder"
          ? decideOrderingOrder(state, {
              type: "CancelOrder",
              cancelledAt: "2026-03-31T04:00:00.000Z",
              reason: row.reason,
            })
          : rejectReservation(state, "rsv_1");

      return {
        emitter: row.emitter,
        emissionSiteStatus: state.status,
        carried: cancelledEventFrom(events).data.statusBeforeCancellation,
      };
    });

    // Carried value equals the emission-site status verbatim, which equals the status the
    // transitions produce — no narrowing, defaulting, normalization, or re-read after the fold.
    expect(observed).toEqual(
      rows.map((row) => ({ emitter: row.emitter, emissionSiteStatus: row.status, carried: row.status })),
    );
    expect(observed.map((entry) => entry.carried)).not.toContain("cancelled");
  });

  it("reservation rejection cannot reach a post-reservation status", () => {
    // The emitter's only event-reachable pre-cancellation status.
    expect(
      cancelledEventFrom(rejectReservation(pendingReservationState(), "rsv_1")).data.statusBeforeCancellation,
    ).toBe("pending-reservation");

    // Past `pending-reservation` no request is still pending, so the command cannot emit a
    // cancellation there: a matched request throws, an unmatched id is inert.
    const pendingPayment = pendingPaymentState();
    expect(pendingPayment.status).toBe("pending-payment");
    expect(pendingPayment.reservationRequests[0]?.status).toBe("confirmed");
    expect(() => rejectReservation(pendingPayment, "rsv_1")).toThrow(
      "Only pending reservation requests can be rejected.",
    );
    expect(rejectReservation(pendingPayment, "rsv_missing")).toEqual([]);

    const released = releasedAtReadyForFulfillmentState();
    expect(released.status).toBe("ready-for-fulfillment");
    expect(released.reservationRequests[0]?.status).toBe("released");
    expect(() => rejectReservation(released, "rsv_1")).toThrow("Only pending reservation requests can be rejected.");
    expect(rejectReservation(released, "rsv_missing")).toEqual([]);
  });

  it("aggregate replay is unaffected by the added cancellation fields", () => {
    const state = pendingPaymentState();
    const enriched = cancelledEventFrom(
      decideOrderingOrder(state, {
        type: "CancelOrder",
        cancelledAt: "2026-03-31T05:00:00.000Z",
        reason: "payment-deadline",
      }),
    );

    // A cancellation written before this slice: the same event with the two properties
    // simply absent from its stored row. Only a cast expresses that against the enriched
    // domain type, and that absence is exactly the decode the evolver must keep tolerating.
    const historical = {
      type: "ordering.order.cancelled",
      data: {
        orderId: enriched.data.orderId,
        cancelledAt: enriched.data.cancelledAt,
        reason: enriched.data.reason,
        buyerEmail: enriched.data.buyerEmail,
        reservationRequests: enriched.data.reservationRequests,
      },
    } as OrderCancelledEvent;

    expect(historical.data).not.toHaveProperty("buyerAccountId");
    expect(historical.data).not.toHaveProperty("statusBeforeCancellation");
    expect(evolveOrderingOrder(state, historical)).toEqual(evolveOrderingOrder(state, enriched));
  });

  it("re-cancellation emits nothing after the added fields", () => {
    const state = pendingReservationState();
    const cancelled = decideOrderingOrder(state, {
      type: "CancelOrder",
      cancelledAt: "2026-03-31T06:00:00.000Z",
      reason: "buyer-cancelled",
    }).reduce(evolveOrderingOrder, state);

    expect(cancelled.status).toBe("cancelled");
    expect(
      decideOrderingOrder(cancelled, {
        type: "CancelOrder",
        cancelledAt: "2026-03-31T07:00:00.000Z",
        reason: "seller-cancelled",
      }),
    ).toEqual([]);
    expect(rejectReservation(cancelled, "rsv_1")).toEqual([]);
  });
});
