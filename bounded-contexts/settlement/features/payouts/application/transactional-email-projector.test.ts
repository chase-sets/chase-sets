import { describe, expect, it, vi } from "vitest";
import { projectSettlementPayoutEventToTransactionalEmail } from "./transactional-email-projector";

describe("settlement transactional email projector", () => {
  it("sends when payout.completed events include a notification email", async () => {
    const gateway = { sendTransactionalEmail: vi.fn(async () => ({ providerName: "amazon-ses", providerMessageId: "msg_4", acceptedAt: new Date().toISOString(), attemptCount: 1 })) };
    await projectSettlementPayoutEventToTransactionalEmail(gateway as never, {
      id: "evt_4",
      type: "settlement.payout.completed",
      trace: { traceId: "req_4" },
      data: {
        notificationEmail: "seller@example.com",
        payoutId: "po_1",
        amount: "42.00",
      },
    } as never);
    expect(gateway.sendTransactionalEmail).toHaveBeenCalledOnce();
  });
});
