import { describe, expect, it, vi } from "vitest";
import { projectFulfillmentEventToTransactionalEmail } from "./transactional-email-projector";

describe("fulfillment transactional email projector", () => {
  it("sends when shipment.delivered events include a buyer email snapshot", async () => {
    const gateway = { sendTransactionalEmail: vi.fn(async () => ({ providerName: "amazon-ses", providerMessageId: "msg_3", acceptedAt: new Date().toISOString(), attemptCount: 1 })) };
    await projectFulfillmentEventToTransactionalEmail(gateway as never, {
      id: "evt_3",
      type: "fulfillment.shipment.delivered",
      trace: { traceId: "req_3" },
      data: {
        shipmentId: "shp_1",
        orderId: "ord_1",
        trackingIdentifier: "trk_1",
        shippingDestinationSnapshot: { email: "buyer@example.com" },
      },
    } as never);
    expect(gateway.sendTransactionalEmail).toHaveBeenCalledOnce();
  });
});
