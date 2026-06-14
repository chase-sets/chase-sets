import { describe, expect, it } from "vitest";
import { mapPaymentCapturedToTransactionalEmail } from "./transactional-email-intents";

describe("payments transactional email intents", () => {
  it("maps captured payments to buyer transactional emails", () => {
    const captured = mapPaymentCapturedToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      paymentId: "pay_123",
      orderIds: ["ord_123"],
      amount: "20.00",
      currencyCode: "USD",
      correlationId: "trace_1",
    });

    expect(captured).toMatchObject({
      messageType: "payments.payment-captured",
      criticality: "commerce",
      templateId: "payment_captured",
      idempotencyKey: "payments:payment_captured:pay_123",
    });
  });
});
