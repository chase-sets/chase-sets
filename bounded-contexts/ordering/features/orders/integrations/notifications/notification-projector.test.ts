import { describe, expect, it, vi } from "vitest";
import { projectOrderingEventToNotification } from "./notification-projector";

describe("ordering notification projector", () => {
  it("enqueues email and web notification deliveries for order.created events", async () => {
    const outbox = { enqueueNotification: vi.fn(async () => undefined) };

    await projectOrderingEventToNotification(outbox, {
      id: "evt_2",
      type: "ordering.order.created",
      globalPosition: "2",
      trace: { traceId: "req_2" },
      timing: {
        occurredAt: "2026-05-09T00:00:00.000Z",
        recordedAt: "2026-05-09T00:00:01.000Z",
      },
      data: {
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        totalAmount: "10.00",
        shippingDestinationSnapshot: { email: "buyer@example.com" },
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    const input = outbox.enqueueNotification.mock.calls[0]?.[0];
    expect(input.source).toMatchObject({
      sourceEventId: "evt_2",
      sourceGlobalPosition: "2",
    });
    expect(input.message.channels.map((channel: { channel: string }) => channel.channel))
      .toEqual(["email", "web"]);
  });
});
