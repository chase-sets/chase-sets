import { describe, expect, it } from "vitest";
import { decidePayment, evolvePayment, initialPaymentState } from "./domain";

const commercialAmounts = {
  marketplaceSalesFeeAmount: "2.00",
  marketplaceCheckoutFeeAmount: "1.00",
  sellerNetAmount: "39.50",
} as const;

function capturedPaymentState(amount = "10.00") {
  const createdState = decidePayment(initialPaymentState, {
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
  }).reduce(evolvePayment, initialPaymentState);

  return decidePayment(createdState, {
    type: "RecordPaymentCapture",
    processorStatus: "succeeded",
    capturedAt: "2026-04-01T00:01:00.000Z",
  }).reduce(evolvePayment, createdState);
}

describe("payments payment domain", () => {
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
      processorStatus: "succeeded",
      processorRefundReference: "re_1",
      amount: "4.00",
      refundedAt: "2026-04-01T00:03:00.000Z",
    });
    const partiallyRefundedState = firstRefundEvents.reduce(evolvePayment, capturedState);
    const secondRefundEvents = decidePayment(partiallyRefundedState, {
      type: "RecordPaymentRefund",
      processorStatus: "succeeded",
      processorRefundReference: "re_2",
      amount: "7.00",
      refundedAt: "2026-04-01T00:04:00.000Z",
    });
    const secondPartialState = secondRefundEvents.reduce(evolvePayment, partiallyRefundedState);
    const finalRefundEvents = decidePayment(secondPartialState, {
      type: "RecordPaymentRefund",
      processorStatus: "succeeded",
      processorRefundReference: "re_3",
      amount: "10.00",
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
        processorStatus: "succeeded",
        processorRefundReference: "re_2",
        amount: "7.00",
        refundedAt: "2026-04-01T00:04:00.000Z",
      }),
    ).toEqual([]);
  });

  it("rejects missing, backwards, and over-cap refund provider amounts", () => {
    const capturedState = capturedPaymentState();
    const partialState = decidePayment(capturedState, {
      type: "RecordPaymentRefund",
      processorStatus: "succeeded",
      processorRefundReference: "re_1",
      amount: "4.00",
      refundedAt: "2026-04-01T00:03:00.000Z",
    }).reduce(evolvePayment, capturedState);

    expect(() =>
      decidePayment(capturedState, {
        type: "RecordPaymentRefund",
        processorStatus: "succeeded",
        processorRefundReference: "re_missing",
        amount: null,
        refundedAt: "2026-04-01T00:03:00.000Z",
      }),
    ).toThrow("Refund webhook must include the cumulative refunded amount.");
    expect(() =>
      decidePayment(capturedState, {
        type: "RecordPaymentRefund",
        processorStatus: "succeeded",
        processorRefundReference: "re_over",
        amount: "10.01",
        refundedAt: "2026-04-01T00:03:00.000Z",
      }),
    ).toThrow("Refunded amount cannot exceed the captured payment amount.");
    expect(() =>
      decidePayment(partialState, {
        type: "RecordPaymentRefund",
        processorStatus: "succeeded",
        processorRefundReference: "re_backwards",
        amount: "3.00",
        refundedAt: "2026-04-01T00:04:00.000Z",
      }),
    ).toThrow("Refunded amount cannot move backwards.");
  });

  it("allows disputes after refunds but forbids captures after terminal provider states", () => {
    const capturedState = capturedPaymentState();
    const partialState = decidePayment(capturedState, {
      type: "RecordPaymentRefund",
      processorStatus: "succeeded",
      processorRefundReference: "re_1",
      amount: "4.00",
      refundedAt: "2026-04-01T00:03:00.000Z",
    }).reduce(evolvePayment, capturedState);
    const refundedState = decidePayment(partialState, {
      type: "RecordPaymentRefund",
      processorStatus: "succeeded",
      processorRefundReference: "re_2",
      amount: "10.00",
      refundedAt: "2026-04-01T00:04:00.000Z",
    }).reduce(evolvePayment, partialState);

    const disputedPartialState = decidePayment(partialState, {
      type: "RecordPaymentDispute",
      processorStatus: "needs_response",
      disputeStatus: "charge.dispute.created",
      disputeMessage: "needs_response",
      amount: "6.00",
      disputedAt: "2026-04-01T00:05:00.000Z",
    }).reduce(evolvePayment, partialState);

    expect(disputedPartialState.status).toBe("disputed");
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
