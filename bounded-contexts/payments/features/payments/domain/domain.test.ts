import { describe, expect, it } from "vitest";
import {
  decidePayment,
  evolvePayment,
  initialPaymentState,
} from "./domain";

const commercialAmounts = {
  marketplaceFeeAmount: "2.00",
  paymentFeeAmount: "1.00",
  sellerNetAmount: "39.50",
} as const;

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
      marketplaceFeeAmount: "1.00",
      paymentFeeAmount: "0.50",
      sellerNetAmount: "8.50",
      currencyCode: "usd",
      processorName: "stripe",
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

  it("rejects invalid payment creation", () => {
    expect(() =>
      decidePayment(initialPaymentState, {
        type: "CreatePayment",
        paymentId: "pay_1" as never,
        buyerAccountId: "acc_buyer" as never,
        orderIds: [],
        amount: "0.00",
        marketplaceFeeAmount: "0.00",
        paymentFeeAmount: "0.00",
        sellerNetAmount: "0.00",
        currencyCode: "usd",
        processorName: "stripe",
        processorPaymentReference: "pi_123",
        processorClientSecret: null,
        processorStatus: "requires_payment_method",
        createdAt: "2026-04-01T00:00:00.000Z",
      }),
    ).toThrow("Payments must include at least one order.");
  });
});
