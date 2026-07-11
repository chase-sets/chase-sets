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

  it("maps shipment delivery to a transactional email with the support-safe order reference, never the raw ULID", () => {
    const message = mapShipmentDeliveredToTransactionalEmail({
      buyerEmail: "buyer@example.com",
      orderId: "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      trackingNumber: "track_1",
      correlationId: "req_2",
    });

    expect(message.title).toBe("Shipment delivered for order ORD-E6K7M8N9");
    expect(message.templateData).toMatchObject({ orderReference: "ORD-E6K7M8N9", trackingNumber: "track_1" });
  });
});
