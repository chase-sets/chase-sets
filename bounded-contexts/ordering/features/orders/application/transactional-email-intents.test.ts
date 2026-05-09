import { describe, expect, it } from "vitest";
import { mapOrderConfirmedToTransactionalEmail } from "./transactional-email-intents";

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
});
