import { describe, expect, it } from "vitest";
import { mapPaymentCapturedToTransactionalEmail } from "./transactional-email-intents";

describe("payments transactional email intents", () => {
  it("borrows the order's display reference when the payment maps to a single order", () => {
    const captured = mapPaymentCapturedToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      paymentId: "pay_123",
      orderIds: ["ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9"],
      amount: "20.00",
      currencyCode: "USD",
      correlationId: "trace_1",
    });

    expect(captured).toMatchObject({
      messageType: "payments.payment-captured",
      criticality: "commerce",
      templateId: "payment_captured",
      title: "Payment received for ORD-E6K7M8N9",
      idempotencyKey: "payments:payment_captured:pay_123",
      templateData: { paymentReference: "ORD-E6K7M8N9" },
    });
  });

  it("falls back to the raw payment id when the payment spans several orders", () => {
    const captured = mapPaymentCapturedToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      paymentId: "pay_123",
      orderIds: ["ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9", "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      amount: "20.00",
      currencyCode: "USD",
      correlationId: "trace_1",
    });

    expect(captured).toMatchObject({
      title: "Payment received for pay_123",
      templateData: { paymentReference: "pay_123" },
    });
  });
});
