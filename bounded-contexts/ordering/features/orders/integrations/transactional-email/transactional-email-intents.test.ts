import { describe, expect, it } from "vitest";
import { mapOrderConfirmedToTransactionalEmail } from "./transactional-email-intents";

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

  it("retired cancellation mapper is absent", async () => {
    const intents = await import("./transactional-email-intents");
    expect(intents).not.toHaveProperty("mapOrderPaymentDeadlineCancelledToTransactionalEmail");
    expect(Object.keys(intents)).toEqual(["mapOrderConfirmedToTransactionalEmail"]);
  });
});
