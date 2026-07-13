import { describe, expect, it } from "vitest";
import { decidePayment, evolvePayment, initialPaymentState, type PaymentCommand, type PaymentState } from "./domain";

const commercialAmounts = {
  marketplaceSalesFeeAmount: "2.00",
  marketplaceCheckoutFeeAmount: "1.00",
  sellerNetAmount: "39.50",
} as const;

function evolve(state: PaymentState, command: PaymentCommand) {
  return decidePayment(state, command).reduce(evolvePayment, state);
}

function createdPaymentState(amount = "10.00") {
  return evolve(initialPaymentState, {
    type: "CreatePayment",
    paymentId: "pay_1" as never,
    buyerAccountId: "acc_buyer" as never,
    orderIds: ["ord_1" as never],
    amount,
    marketplaceSalesFeeAmount: "1.00",
    marketplaceCheckoutFeeAmount: "0.50",
    sellerNetAmount: "8.50",
    sellerPayouts: [
      {
        orderId: "ord_1" as never,
        sellerAccountId: "acc_seller" as never,
        sellerItemNetAmount: "8.00",
        shippingAllowanceAmount: "0.50",
        sellerShippingPayoutAmount: "0.50",
        protectionAmount: "0.10",
        protectionAllowanceAmount: "0.10",
        protectionOverageAmount: "0.00",
        sellerPayoutAmount: "8.50",
      },
    ],
    currencyCode: "usd",
    processorName: "stripe",
    processorPaymentKind: "payment-intent",
    processorPaymentReference: "pi_123",
    processorClientSecret: "pi_123_secret_456",
    processorStatus: "requires_payment_method",
    createdAt: "2026-04-01T00:00:00.000Z",
  });
}

function capturedPaymentState(amount = "10.00") {
  return evolve(createdPaymentState(amount), {
    type: "RecordPaymentCapture",
    processorStatus: "succeeded",
    capturedAt: "2026-04-01T00:01:00.000Z",
  });
}

function failedPaymentState() {
  return evolve(createdPaymentState(), {
    type: "RecordPaymentFailure",
    processorStatus: "requires_payment_method",
    failureCode: "card_declined",
    failureMessage: "Card was declined.",
    failedAt: "2026-04-01T00:01:00.000Z",
  });
}

function partiallyRefundedPaymentState() {
  return evolve(capturedPaymentState(), {
    type: "RecordPaymentRefund",
    refundId: "rfd_existing" as never,
    orderIds: ["ord_1" as never],
    processorStatus: "succeeded",
    processorRefundReference: "re_existing",
    amount: "4.00",
    refundedAmount: "4.00",
    refundedAt: "2026-04-01T00:02:00.000Z",
  });
}

function refundedPaymentState() {
  return evolve(capturedPaymentState(), {
    type: "RecordPaymentRefund",
    refundId: "rfd_full" as never,
    orderIds: ["ord_1" as never],
    processorStatus: "succeeded",
    processorRefundReference: "re_full",
    amount: "10.00",
    refundedAmount: "10.00",
    refundedAt: "2026-04-01T00:02:00.000Z",
  });
}

function disputePayment(state: PaymentState) {
  return evolve(state, {
    type: "RecordPaymentDispute",
    providerEventId: "evt_dispute_matrix",
    providerDisputeId: "dp_matrix",
    providerChargeReference: "ch_matrix",
    processorStatus: "needs_response",
    disputeStatus: "charge.dispute.created",
    disputeMessage: "needs_response",
    disputeLifecycleState: "created",
    disputeReason: "fraudulent",
    disputeEvidenceDueAt: "2026-08-04T00:00:00.000Z",
    amount: "10.00",
    disputedAt: "2026-04-01T00:02:30.000Z",
  });
}

describe("payments payment domain", () => {
  it("records payment authorization with the normalized provider payload", () => {
    expect(
      decidePayment(createdPaymentState(), {
        type: "RecordPaymentAuthorization",
        processorStatus: " requires_payment_method ",
        authorizedAt: "2026-04-01T00:00:30.000Z",
      }),
    ).toEqual([
      {
        type: "payments.payment-authorized",
        data: {
          paymentId: "pay_1",
          processorStatus: "requires_payment_method",
          authorizedAt: "2026-04-01T00:00:30.000Z",
        },
      },
    ]);
  });

  it("treats duplicate payment authorization as idempotent", () => {
    const authorizedState = evolve(createdPaymentState(), {
      type: "RecordPaymentAuthorization",
      processorStatus: "requires_capture",
      authorizedAt: "2026-04-01T00:00:30.000Z",
    });

    expect(
      decidePayment(authorizedState, {
        type: "RecordPaymentAuthorization",
        processorStatus: " requires_capture ",
        authorizedAt: "2026-04-01T00:00:40.000Z",
      }),
    ).toEqual([]);
  });

  it.each([
    ["captured", () => capturedPaymentState()],
    ["partially refunded", () => partiallyRefundedPaymentState()],
    ["refunded", () => refundedPaymentState()],
    ["disputed", () => disputePayment(capturedPaymentState())],
    [
      "cancelled",
      () =>
        evolve(createdPaymentState(), {
          type: "CancelPayment",
          cancelledAt: "2026-04-01T00:00:30.000Z",
        }),
    ],
  ] as const)("ignores an out-of-order authorization after the payment is %s", (_status, state) => {
    expect(
      decidePayment(state(), {
        type: "RecordPaymentAuthorization",
        processorStatus: "requires_capture",
        authorizedAt: "2026-04-01T00:02:00.000Z",
      }),
    ).toEqual([]);
  });

  it.each([
    ["pending confirmation", () => createdPaymentState()],
    ["failed", () => failedPaymentState()],
  ] as const)("cancels a %s payment with the exact public event payload", (_status, state) => {
    expect(
      decidePayment(state(), {
        type: "CancelPayment",
        cancelledAt: "2026-04-01T00:03:00.000Z",
      }),
    ).toEqual([
      {
        type: "payments.payment-cancelled",
        data: {
          paymentId: "pay_1",
          cancelledAt: "2026-04-01T00:03:00.000Z",
        },
      },
    ]);
  });

  it("treats duplicate cancellation as idempotent", () => {
    const cancelledState = evolve(createdPaymentState(), {
      type: "CancelPayment",
      cancelledAt: "2026-04-01T00:03:00.000Z",
    });

    expect(
      decidePayment(cancelledState, {
        type: "CancelPayment",
        cancelledAt: "2026-04-01T00:04:00.000Z",
      }),
    ).toEqual([]);
  });

  it.each([
    ["captured", () => capturedPaymentState()],
    ["partially refunded", () => partiallyRefundedPaymentState()],
    ["refunded", () => refundedPaymentState()],
    ["disputed", () => disputePayment(capturedPaymentState())],
  ] as const)("rejects cancellation after the payment is %s", (_status, state) => {
    expect(() =>
      decidePayment(state(), {
        type: "CancelPayment",
        cancelledAt: "2026-04-01T00:03:00.000Z",
      }),
    ).toThrow("Captured payments cannot be cancelled.");
  });

  it.each([
    [
      "RecordPaymentAuthorization",
      {
        type: "RecordPaymentAuthorization",
        processorStatus: "requires_capture",
        authorizedAt: "2026-04-01T00:00:30.000Z",
      },
    ],
    [
      "CancelPayment",
      {
        type: "CancelPayment",
        cancelledAt: "2026-04-01T00:00:30.000Z",
      },
    ],
  ] as const)("rejects %s before payment creation", (_type, command) => {
    expect(() => decidePayment(initialPaymentState, command)).toThrow("Payment must be created first.");
  });

  it("creates and captures a payment", () => {
    const created = decidePayment(initialPaymentState, {
      type: "CreatePayment",
      paymentId: "pay_1" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never, "ord_2" as never],
      amount: "42.50",
      ...commercialAmounts,
      currencyCode: "usd",
      processorName: "stripe",
      processorPaymentKind: "payment-intent",
      processorPaymentReference: "pi_123",
      processorClientSecret: "pi_123_secret_456",
      processorStatus: "requires_payment_method",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    const createdState = created.reduce(evolvePayment, initialPaymentState);
    const captured = decidePayment(createdState, {
      type: "RecordPaymentCapture",
      processorStatus: "succeeded",
      capturedAt: "2026-04-01T00:01:00.000Z",
    }).reduce(evolvePayment, createdState);

    expect(captured.status).toBe("captured");
    expect(captured.capturedAt).toBe("2026-04-01T00:01:00.000Z");
    expect(captured.orderIds).toEqual(["ord_1", "ord_2"]);
  });

  it("records a failure once and remains idempotent on duplicate failure webhooks", () => {
    const createdState = decidePayment(initialPaymentState, {
      type: "CreatePayment",
      paymentId: "pay_1" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      amount: "10.00",
      marketplaceSalesFeeAmount: "1.00",
      marketplaceCheckoutFeeAmount: "0.50",
      sellerNetAmount: "8.50",
      currencyCode: "usd",
      processorName: "stripe",
      processorPaymentKind: "payment-intent",
      processorPaymentReference: "pi_123",
      processorClientSecret: "pi_123_secret_456",
      processorStatus: "requires_payment_method",
      createdAt: "2026-04-01T00:00:00.000Z",
    }).reduce(evolvePayment, initialPaymentState);

    const failedEvents = decidePayment(createdState, {
      type: "RecordPaymentFailure",
      processorStatus: "requires_payment_method",
      failureCode: "card_declined",
      failureMessage: "Card was declined.",
      failedAt: "2026-04-01T00:02:00.000Z",
    });
    const failedState = failedEvents.reduce(evolvePayment, createdState);

    expect(failedState.status).toBe("failed");
    expect(failedState.failureCode).toBe("card_declined");
    expect(
      decidePayment(failedState, {
        type: "RecordPaymentFailure",
        processorStatus: "requires_payment_method",
        failureCode: "card_declined",
        failureMessage: "Card was declined.",
        failedAt: "2026-04-01T00:02:00.000Z",
      }),
    ).toEqual([]);
  });

  it("records cumulative refund provider facts as partial and final deltas", () => {
    const capturedState = capturedPaymentState();

    const firstRefundEvents = decidePayment(capturedState, {
      type: "RecordPaymentRefund",
      refundId: "rfd_1" as never,
      orderIds: ["ord_1" as never],
      processorStatus: "succeeded",
      processorRefundReference: "re_1",
      amount: "4.00",
      refundedAmount: "4.00",
      refundedAt: "2026-04-01T00:03:00.000Z",
    });
    const partiallyRefundedState = firstRefundEvents.reduce(evolvePayment, capturedState);
    const secondRefundEvents = decidePayment(partiallyRefundedState, {
      type: "RecordPaymentRefund",
      refundId: "rfd_2" as never,
      orderIds: ["ord_1" as never],
      processorStatus: "succeeded",
      processorRefundReference: "re_2",
      amount: "3.00",
      refundedAmount: "7.00",
      refundedAt: "2026-04-01T00:04:00.000Z",
    });
    const secondPartialState = secondRefundEvents.reduce(evolvePayment, partiallyRefundedState);
    const finalRefundEvents = decidePayment(secondPartialState, {
      type: "RecordPaymentRefund",
      refundId: "rfd_3" as never,
      orderIds: ["ord_1" as never],
      processorStatus: "succeeded",
      processorRefundReference: "re_3",
      amount: "3.00",
      refundedAmount: "10.00",
      refundedAt: "2026-04-01T00:05:00.000Z",
    });
    const refundedState = finalRefundEvents.reduce(evolvePayment, secondPartialState);

    expect(firstRefundEvents[0]?.data).toMatchObject({
      amount: "4.00",
      refundedAmount: "4.00",
      sellerPayouts: [expect.objectContaining({ sellerAccountId: "acc_seller" })],
    });
    expect(partiallyRefundedState.status).toBe("partially-refunded");
    expect(partiallyRefundedState.refundedAmount).toBe("4.00");
    expect(secondRefundEvents[0]?.data).toMatchObject({
      amount: "3.00",
      refundedAmount: "7.00",
    });
    expect(secondPartialState.status).toBe("partially-refunded");
    expect(finalRefundEvents[0]?.data).toMatchObject({
      amount: "3.00",
      refundedAmount: "10.00",
    });
    expect(refundedState.status).toBe("refunded");
    expect(refundedState.refundedAmount).toBe("10.00");
    expect(
      decidePayment(secondPartialState, {
        type: "RecordPaymentRefund",
        refundId: "rfd_2" as never,
        orderIds: ["ord_1" as never],
        processorStatus: "succeeded",
        processorRefundReference: "re_2",
        amount: "3.00",
        refundedAmount: "7.00",
        refundedAt: "2026-04-01T00:04:00.000Z",
      }),
    ).toEqual([]);
    expect(
      decidePayment(refundedState, {
        type: "RecordPaymentRefund",
        refundId: "rfd_3" as never,
        orderIds: ["ord_1" as never],
        processorStatus: "succeeded",
        processorRefundReference: "re_3",
        amount: "3.00",
        refundedAmount: "10.00",
        refundedAt: "2026-04-01T00:05:00.000Z",
      }),
    ).toEqual([]);
  });

  const refundSources = [
    {
      source: "requested refund",
      refundId: "rfd_matrix" as never,
      processorRefundReference: "re_matrix",
    },
    {
      source: "provider-originated refund",
      refundId: null,
      processorRefundReference: "re_provider_matrix",
    },
  ] as const;
  const refundStatuses = [
    { status: "captured", initiallyRefundedAmount: "0.00", disputed: false },
    { status: "partially-refunded", initiallyRefundedAmount: "4.00", disputed: false },
    { status: "disputed", initiallyRefundedAmount: "0.00", disputed: true },
  ] as const;
  const refundExtents = ["partial", "full"] as const;
  const refundMatrix = refundSources.flatMap((source) =>
    refundStatuses.flatMap((status) =>
      refundExtents.map((extent) => ({
        ...source,
        ...status,
        extent,
      })),
    ),
  );

  it.each(refundMatrix)(
    "records an exact $extent settlement fact for a $source from $status state",
    ({ refundId, processorRefundReference, initiallyRefundedAmount, disputed, extent }) => {
      let state = initiallyRefundedAmount === "0.00" ? capturedPaymentState() : partiallyRefundedPaymentState();
      const amount = extent === "full" ? (initiallyRefundedAmount === "0.00" ? "10.00" : "6.00") : "2.00";
      const refundedAmount = extent === "full" ? "10.00" : initiallyRefundedAmount === "0.00" ? "2.00" : "6.00";

      if (refundId) {
        state = evolve(state, {
          type: "RequestPaymentRefund",
          refundId,
          orderIds: ["ord_1" as never],
          amount,
          requestedAt: "2026-04-01T00:03:00.000Z",
        });
      }
      if (disputed) {
        state = disputePayment(state);
      }

      const command = {
        type: "RecordPaymentRefund",
        refundId,
        orderIds: ["ord_1" as never],
        processorStatus: "succeeded",
        processorRefundReference,
        amount,
        refundedAmount,
        refundedAt: "2026-04-01T00:04:00.000Z",
      } as const;
      const events = decidePayment(state, command);

      expect(events).toEqual([
        {
          type: "payments.payment-refunded",
          data: {
            paymentId: "pay_1",
            refundId,
            orderIds: ["ord_1"],
            buyerAccountId: "acc_buyer",
            amount,
            refundedAmount,
            orderRefundAmounts: [{ orderId: "ord_1", amount }],
            refundedOrderAmounts: [{ orderId: "ord_1", amount: refundedAmount }],
            orderRefundCaps: [{ orderId: "ord_1", amount: "10.00" }],
            currencyCode: "usd",
            processorName: "stripe",
            processorPaymentReference: "pi_123",
            sellerPayouts: [
              {
                orderId: "ord_1",
                sellerAccountId: "acc_seller",
                marketplaceSalesFeeAmount: "0.00",
                marketplaceSalesFeeLines: [],
                sellerItemNetAmount: "8.00",
                shippingAllowanceAmount: "0.50",
                sellerShippingPayoutAmount: "0.50",
                protectionAmount: "0.10",
                protectionAllowanceAmount: "0.10",
                protectionOverageAmount: "0.00",
                sellerPayoutAmount: "8.50",
              },
            ],
            processorRefundReference,
            processorStatus: "succeeded",
            refundedAt: "2026-04-01T00:04:00.000Z",
          },
        },
      ]);

      const refundedState = events.reduce(evolvePayment, state);
      expect(refundedState).toMatchObject({
        status: extent === "full" ? "refunded" : "partially-refunded",
        refundedAmount,
        refundedOrderAmounts: [{ orderId: "ord_1", amount: refundedAmount }],
      });
      expect(refundedState.refundRequests).toEqual([]);
      expect(decidePayment(refundedState, command)).toEqual([]);
    },
  );

  it("rejects missing, backwards, and over-cap refund provider amounts", () => {
    const capturedState = capturedPaymentState();
    const partialState = decidePayment(capturedState, {
      type: "RecordPaymentRefund",
      refundId: "rfd_1" as never,
      orderIds: ["ord_1" as never],
      processorStatus: "succeeded",
      processorRefundReference: "re_1",
      amount: "4.00",
      refundedAmount: "4.00",
      refundedAt: "2026-04-01T00:03:00.000Z",
    }).reduce(evolvePayment, capturedState);

    expect(() =>
      decidePayment(capturedState, {
        type: "RecordPaymentRefund",
        refundId: "rfd_missing" as never,
        orderIds: ["ord_1" as never],
        processorStatus: "succeeded",
        processorRefundReference: "re_missing",
        amount: null,
        refundedAt: "2026-04-01T00:03:00.000Z",
      }),
    ).toThrow("Refund webhook must include the refunded amount.");
    expect(() =>
      decidePayment(capturedState, {
        type: "RecordPaymentRefund",
        refundId: "rfd_over" as never,
        orderIds: ["ord_1" as never],
        processorStatus: "succeeded",
        processorRefundReference: "re_over",
        amount: "10.01",
        refundedAmount: "10.01",
        refundedAt: "2026-04-01T00:03:00.000Z",
      }),
    ).toThrow("Refunded amount cannot exceed the captured payment amount.");
    expect(() =>
      decidePayment(partialState, {
        type: "RecordPaymentRefund",
        refundId: "rfd_backwards" as never,
        orderIds: ["ord_1" as never],
        processorStatus: "succeeded",
        processorRefundReference: "re_backwards",
        amount: "3.00",
        refundedAmount: "3.00",
        refundedAt: "2026-04-01T00:04:00.000Z",
      }),
    ).toThrow("Refunded amount cannot move backwards.");
  });

  it("caps refund requests independently by order and emits filtered seller payout facts", () => {
    const createdState = decidePayment(initialPaymentState, {
      type: "CreatePayment",
      paymentId: "pay_multi" as never,
      buyerAccountId: "acc_buyer" as never,
      orderIds: ["ord_a" as never, "ord_b" as never],
      orderRefundCaps: [
        { orderId: "ord_a" as never, amount: "10.00" },
        { orderId: "ord_b" as never, amount: "15.00" },
      ],
      amount: "25.00",
      marketplaceSalesFeeAmount: "2.00",
      marketplaceCheckoutFeeAmount: "0.00",
      sellerNetAmount: "23.00",
      sellerPayouts: [
        {
          orderId: "ord_a" as never,
          sellerAccountId: "acc_seller_a" as never,
          sellerItemNetAmount: "9.00",
          shippingAllowanceAmount: "1.00",
          sellerShippingPayoutAmount: "1.00",
          sellerPayoutAmount: "10.00",
        },
        {
          orderId: "ord_b" as never,
          sellerAccountId: "acc_seller_b" as never,
          sellerItemNetAmount: "14.00",
          shippingAllowanceAmount: "1.00",
          sellerShippingPayoutAmount: "1.00",
          sellerPayoutAmount: "15.00",
        },
      ],
      currencyCode: "usd",
      processorName: "stripe",
      processorPaymentKind: "payment-intent",
      processorPaymentReference: "pi_multi",
      processorClientSecret: "pi_multi_secret",
      processorStatus: "requires_payment_method",
      createdAt: "2026-04-01T00:00:00.000Z",
    }).reduce(evolvePayment, initialPaymentState);
    const capturedState = decidePayment(createdState, {
      type: "RecordPaymentCapture",
      processorStatus: "succeeded",
      capturedAt: "2026-04-01T00:01:00.000Z",
    }).reduce(evolvePayment, createdState);
    const requestedAState = decidePayment(capturedState, {
      type: "RequestPaymentRefund",
      refundId: "rfd_a" as never,
      orderIds: ["ord_a" as never],
      amount: "10.00",
      requestedAt: "2026-04-01T00:02:00.000Z",
    }).reduce(evolvePayment, capturedState);

    expect(() =>
      decidePayment(requestedAState, {
        type: "RequestPaymentRefund",
        refundId: "rfd_a_over" as never,
        orderIds: ["ord_a" as never],
        amount: "0.01",
        requestedAt: "2026-04-01T00:02:01.000Z",
      }),
    ).toThrow("Refund amount cannot exceed the remaining refundable order amount.");
    expect(
      decidePayment(requestedAState, {
        type: "RequestPaymentRefund",
        refundId: "rfd_b" as never,
        orderIds: ["ord_b" as never],
        amount: "15.00",
        requestedAt: "2026-04-01T00:02:02.000Z",
      }),
    ).toHaveLength(1);

    const refundEvents = decidePayment(requestedAState, {
      type: "RecordPaymentRefund",
      refundId: "rfd_a" as never,
      orderIds: ["ord_a" as never],
      processorStatus: "succeeded",
      processorRefundReference: "re_a",
      amount: "10.00",
      refundedAmount: "10.00",
      refundedAt: "2026-04-01T00:03:00.000Z",
    });

    expect(refundEvents[0]?.type).toBe("payments.payment-refunded");
    if (refundEvents[0]?.type !== "payments.payment-refunded") {
      throw new Error("Expected refund provider fact.");
    }
    const refundEvent = refundEvents[0];

    expect(refundEvent.data).toMatchObject({
      orderIds: ["ord_a"],
      amount: "10.00",
      refundedAmount: "10.00",
      orderRefundAmounts: [{ orderId: "ord_a", amount: "10.00" }],
      sellerPayouts: [expect.objectContaining({ sellerAccountId: "acc_seller_a" })],
    });
    expect(refundEvent.data.sellerPayouts).toHaveLength(1);
  });

  it("allows disputes after refunds but forbids captures after terminal provider states", () => {
    const capturedState = capturedPaymentState();
    const partialState = decidePayment(capturedState, {
      type: "RecordPaymentRefund",
      refundId: "rfd_1" as never,
      orderIds: ["ord_1" as never],
      processorStatus: "succeeded",
      processorRefundReference: "re_1",
      amount: "4.00",
      refundedAmount: "4.00",
      refundedAt: "2026-04-01T00:03:00.000Z",
    }).reduce(evolvePayment, capturedState);
    const refundedState = decidePayment(partialState, {
      type: "RecordPaymentRefund",
      refundId: "rfd_2" as never,
      orderIds: ["ord_1" as never],
      processorStatus: "succeeded",
      processorRefundReference: "re_2",
      amount: "6.00",
      refundedAmount: "10.00",
      refundedAt: "2026-04-01T00:04:00.000Z",
    }).reduce(evolvePayment, partialState);

    const disputedPartialState = decidePayment(partialState, {
      type: "RecordPaymentDispute",
      providerEventId: "evt_dispute",
      providerDisputeId: "dp_123",
      providerChargeReference: "ch_123",
      processorStatus: "needs_response",
      disputeStatus: "charge.dispute.created",
      disputeMessage: "needs_response",
      disputeLifecycleState: "created",
      disputeReason: "fraudulent",
      disputeEvidenceDueAt: "2026-08-04T00:00:00.000Z",
      amount: "6.00",
      disputedAt: "2026-04-01T00:05:00.000Z",
    }).reduce(evolvePayment, partialState);

    expect(disputedPartialState.status).toBe("disputed");
    expect(
      decidePayment(partialState, {
        type: "RecordPaymentDispute",
        providerEventId: "evt_dispute",
        providerDisputeId: "dp_123",
        providerChargeReference: "ch_123",
        processorStatus: "needs_response",
        disputeStatus: "charge.dispute.created",
        disputeMessage: "needs_response",
        disputeLifecycleState: "created",
        disputeReason: "fraudulent",
        disputeEvidenceDueAt: "2026-08-04T00:00:00.000Z",
        amount: "6.00",
        disputedAt: "2026-04-01T00:05:00.000Z",
      })[0]?.data,
    ).toMatchObject({
      providerEventId: "evt_dispute",
      providerDisputeId: "dp_123",
      providerChargeReference: "ch_123",
      disputeLifecycleState: "created",
      disputeReason: "fraudulent",
      disputeEvidenceDueAt: "2026-08-04T00:00:00.000Z",
      sellerPayouts: [expect.objectContaining({ sellerAccountId: "acc_seller" })],
    });
    expect(
      decidePayment(refundedState, {
        type: "RecordPaymentDispute",
        processorStatus: "needs_response",
        disputeStatus: "charge.dispute.created",
        disputeMessage: "needs_response",
        amount: "6.00",
        disputedAt: "2026-04-01T00:05:00.000Z",
      }).reduce(evolvePayment, refundedState).status,
    ).toBe("disputed");
    expect(() =>
      decidePayment(refundedState, {
        type: "RecordPaymentCapture",
        processorStatus: "succeeded",
        capturedAt: "2026-04-01T00:06:00.000Z",
      }),
    ).toThrow("Refunded payments cannot be captured.");
    expect(() =>
      decidePayment(disputedPartialState, {
        type: "RecordPaymentCapture",
        processorStatus: "succeeded",
        capturedAt: "2026-04-01T00:06:00.000Z",
      }),
    ).toThrow("Disputed payments cannot be captured.");
  });

  it("rejects invalid payment creation", () => {
    expect(() =>
      decidePayment(initialPaymentState, {
        type: "CreatePayment",
        paymentId: "pay_1" as never,
        buyerAccountId: "acc_buyer" as never,
        orderIds: [],
        amount: "0.00",
        marketplaceSalesFeeAmount: "0.00",
        marketplaceCheckoutFeeAmount: "0.00",
        sellerNetAmount: "0.00",
        currencyCode: "usd",
        processorName: "stripe",
        processorPaymentKind: "payment-intent",
        processorPaymentReference: "pi_123",
        processorClientSecret: null,
        processorStatus: "requires_payment_method",
        createdAt: "2026-04-01T00:00:00.000Z",
      }),
    ).toThrow("Payments must include at least one order.");
  });
});
