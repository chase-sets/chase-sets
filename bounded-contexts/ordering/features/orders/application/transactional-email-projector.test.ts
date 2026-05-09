import { describe, expect, it, vi } from "vitest";
import { projectOrderingEventToTransactionalEmail } from "./transactional-email-projector";

describe("ordering transactional email projector", () => {
  it("sends only when order.created events include a buyer email snapshot", async () => {
    const gateway = { sendTransactionalEmail: vi.fn(async () => ({ providerName: "amazon-ses", providerMessageId: "msg_2", acceptedAt: new Date().toISOString(), attemptCount: 1 })) };
    await projectOrderingEventToTransactionalEmail(gateway as never, {
      id: "evt_2",
      type: "ordering.order.created",
      trace: { traceId: "req_2" },
      data: {
        orderId: "ord_1",
        totalAmount: "10.00",
        shippingDestinationSnapshot: { email: "buyer@example.com" },
      },
    } as never);
    expect(gateway.sendTransactionalEmail).toHaveBeenCalledOnce();
  });
});
