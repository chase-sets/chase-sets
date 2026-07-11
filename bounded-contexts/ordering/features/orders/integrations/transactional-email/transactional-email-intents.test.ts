import { describe, expect, it } from "vitest";
import {
  mapOrderConfirmedToTransactionalEmail,
  mapOrderPaymentDeadlineCancelledToTransactionalEmail,
} from "./transactional-email-intents";

const orderId = "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9";

describe("ordering transactional email intents", () => {
  it("maps order confirmation to transactional email", () => {
    const message = mapOrderConfirmedToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      orderId,
      orderTotal: "18.50",
      correlationId: "req_1",
    });
    expect(message.messageType).toBe("ordering.order.created");
    expect(message.title).toBe("Order ORD-E6K7M8N9 confirmed");
    expect(message.templateData).toMatchObject({ orderReference: "ORD-E6K7M8N9", orderTotal: "18.50" });
  });

  it("maps payment-deadline cancellation to a reorder transactional email", () => {
    const message = mapOrderPaymentDeadlineCancelledToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      orderId,
      correlationId: "req_1",
    });

    expect(message).toMatchObject({
      messageType: "ordering.order.cancelled.payment-deadline",
      templateId: "order_payment_deadline_cancelled",
      title: "Order ORD-E6K7M8N9 cancelled after payment deadline",
      idempotencyKey: `ordering:payment_deadline_cancelled:${orderId}`,
      templateData: {
        orderReference: "ORD-E6K7M8N9",
        reorderHref: `/marketplace?reorderFrom=${orderId}`,
      },
    });
  });
});
