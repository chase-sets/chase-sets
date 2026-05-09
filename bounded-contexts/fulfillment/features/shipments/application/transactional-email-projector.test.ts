import { describe, expect, it, vi } from "vitest";
import { projectFulfillmentEventToTransactionalEmail } from "./transactional-email-projector";

describe("fulfillment transactional email projector", () => {
  it("enqueues when shipment.delivered events include a buyer email snapshot", async () => {
    const outbox = { enqueueTransactionalEmail: vi.fn(async () => undefined) };
    await projectFulfillmentEventToTransactionalEmail(outbox, {
      id: "evt_3",
      type: "fulfillment.shipment.delivered",
      globalPosition: "3",
      trace: { traceId: "req_3" },
      timing: {
        occurredAt: "2026-04-02T00:00:00.000Z",
        recordedAt: "2026-04-02T00:00:01.000Z",
      },
      data: {
        shipmentId: "shp_1",
        orderId: "ord_1",
        trackingIdentifier: "trk_1",
        shippingDestinationSnapshot: { email: "buyer@example.com" },
      },
    } as never);
    expect(outbox.enqueueTransactionalEmail).toHaveBeenCalledOnce();
  });
});
