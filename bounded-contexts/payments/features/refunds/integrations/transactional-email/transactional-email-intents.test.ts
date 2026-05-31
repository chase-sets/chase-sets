import { describe, expect, it } from "vitest";
import {
  mapRefundFailedToTransactionalEmail,
  mapRefundIssuedToTransactionalEmail,
} from "./transactional-email-intents";

describe("refund transactional email intents", () => {
  it("maps issued and failed refunds to buyer transactional emails", () => {
    const issued = mapRefundIssuedToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      refundId: "rfd_123",
      paymentId: "pay_123",
      orderIds: ["ord_123"],
      amount: "12.00",
      currencyCode: "USD",
      correlationId: "trace_1",
    });
    const failed = mapRefundFailedToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      refundId: "rfd_123",
      paymentId: "pay_123",
      orderIds: ["ord_123"],
      amount: "12.00",
      currencyCode: "USD",
      correlationId: "trace_1",
    });

    expect(issued).toMatchObject({
      messageType: "payments.refund-issued",
      criticality: "commerce",
      templateId: "refund_issued",
    });
    expect(failed).toMatchObject({
      messageType: "payments.refund-failed",
      templateId: "refund_failed",
    });
  });
});
