import { describe, expect, it } from "vitest";
import {
  mapOrderConfirmedToTransactionalEmail,
  mapOrderPaymentDeadlineCancelledToTransactionalEmail,
} from "./transactional-email-intents";

describe("ordering transactional email intents", () => {
  it("maps order confirmation to transactional email", () => {
    const message = mapOrderConfirmedToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      orderId: "ord_123",
      orderTotal: "18.50",
      correlationId: "req_1",
    });
    expect(message.messageType).toBe("ordering.order.created");
  });

  it("maps payment-deadline cancellation to a reorder transactional email", () => {
    const message = mapOrderPaymentDeadlineCancelledToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      orderId: "ord_123",
      correlationId: "req_1",
    });

    expect(message).toMatchObject({
      messageType: "ordering.order.cancelled.payment-deadline",
      templateId: "order_payment_deadline_cancelled",
      idempotencyKey: "ordering:payment_deadline_cancelled:ord_123",
      templateData: {
        orderId: "ord_123",
        reorderHref: "/marketplace?reorderFrom=ord_123",
      },
    });
  });
});
