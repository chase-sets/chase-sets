import { describe, expect, it, vi } from "vitest";
import { projectAuthSessionEventToTransactionalEmail } from "./transactional-email-projector";

describe("auth transactional email projector", () => {
  it("triggers email send from auth.magic-link.requested transport events", async () => {
    const gateway = { sendTransactionalEmail: vi.fn(async () => ({ providerName: "amazon-ses", providerMessageId: "msg_1", acceptedAt: new Date().toISOString(), attemptCount: 1 })) };

    await projectAuthSessionEventToTransactionalEmail(gateway as never, {
      id: "evt_1",
      type: "auth.magic-link.requested",
      trace: { traceId: "req_1" },
      data: {
        tokenId: "cmd_1",
        userId: null,
        email: "buyer@example.com",
        magicLink: "https://chasesets.com/magic",
        expiresAt: "2026-04-02T00:10:00.000Z",
      },
    } as never);

    expect(gateway.sendTransactionalEmail).toHaveBeenCalledOnce();
  });
});
