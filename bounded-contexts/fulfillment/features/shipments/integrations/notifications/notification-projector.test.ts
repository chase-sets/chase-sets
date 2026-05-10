import { describe, expect, it, vi } from "vitest";
import { projectFulfillmentEventToNotification } from "./notification-projector";

describe("fulfillment notification projector", () => {
  it("enqueues email and web notification deliveries for shipment.delivered events", async () => {
    const outbox = { enqueueNotification: vi.fn(async () => undefined) };

    await projectFulfillmentEventToNotification(outbox, {
      id: "evt_3",
      type: "fulfillment.shipment.delivered",
      globalPosition: "3",
      trace: { traceId: "req_3" },
      timing: {
        occurredAt: "2026-05-09T00:00:00.000Z",
        recordedAt: "2026-05-09T00:00:01.000Z",
      },
      data: {
        shipmentId: "shp_1",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        trackingIdentifier: "trk_1",
        shippingDestinationSnapshot: { email: "buyer@example.com" },
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    const input = outbox.enqueueNotification.mock.calls[0]?.[0];
    expect(input.message.channels.map((channel: { channel: string }) => channel.channel))
      .toEqual(["email", "web"]);
  });
});
