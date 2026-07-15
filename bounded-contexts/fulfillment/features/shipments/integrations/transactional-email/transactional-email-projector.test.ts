import { describe, expect, it, vi } from "vitest";
import { buildFulfillmentTransactionalEmailProjectionHandlers } from "./transactional-email-projector";

async function projectFulfillmentEventToTransactionalEmail(
  outbox: Parameters<typeof buildFulfillmentTransactionalEmailProjectionHandlers>[0],
  event: never,
) {
  const handlers = buildFulfillmentTransactionalEmailProjectionHandlers(outbox);
  await handlers[(event as { type: string }).type]?.(event);
}

describe("fulfillment transactional email projector", () => {
  it("enqueues when shipment.delivered events include a buyer email snapshot", async () => {
    const outbox = { enqueueNotification: vi.fn(async () => undefined) };
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
    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
  });
});
