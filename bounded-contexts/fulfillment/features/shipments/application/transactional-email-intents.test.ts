import { describe, expect, it } from "vitest";
import { mapShipmentDeliveredToTransactionalEmail } from "./transactional-email-intents";

describe("fulfillment transactional email intents", () => {
  it("maps shipment delivery to transactional email", () => {
    const message = mapShipmentDeliveredToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      orderId: "ord_123",
      trackingNumber: "track_1",
      correlationId: "req_2",
    });
    expect(message.messageType).toBe("fulfillment.shipment.delivered");
  });
});
