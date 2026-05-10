import { describe, expect, it, vi } from "vitest";
import { projectOrderingEventToTransactionalEmail } from "./transactional-email-projector";

describe("ordering transactional email projector", () => {
  it("enqueues only when order.created events include a buyer email snapshot", async () => {
    const outbox = { enqueueTransactionalEmail: vi.fn(async () => undefined) };
    await projectOrderingEventToTransactionalEmail(outbox, {
      id: "evt_2",
      type: "ordering.order.created",
      globalPosition: "2",
      trace: { traceId: "req_2" },
      timing: {
        occurredAt: "2026-04-02T00:00:00.000Z",
        recordedAt: "2026-04-02T00:00:01.000Z",
      },
      data: {
        orderId: "ord_1",
        totalAmount: "10.00",
        shippingDestinationSnapshot: { email: "buyer@example.com" },
      },
    } as never);
    expect(outbox.enqueueTransactionalEmail).toHaveBeenCalledOnce();
    expect(outbox.enqueueTransactionalEmail.mock.calls[0]?.[0].source)
      .toMatchObject({ sourceEventId: "evt_2", sourceGlobalPosition: "2" });
  });
});
