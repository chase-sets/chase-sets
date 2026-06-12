import { describe, expect, it, vi } from "vitest";
import { projectAuthSessionEventToTransactionalEmail } from "./transactional-email-projector";

describe("auth transactional email projector", () => {
  it("enqueues email from auth.magic-link.requested transport events without storing the secret on the event", async () => {
    const outbox = {
      enqueueNotification: vi.fn(async (_input: { message: { templateData: unknown } }) => undefined),
    };
    const deliveryTokens = {
      getMagicLinkDeliveryToken: vi.fn(async () => "https://chasesets.com/magic"),
      clearMagicLinkDeliveryToken: vi.fn(async () => undefined),
    };

    await projectAuthSessionEventToTransactionalEmail(outbox, deliveryTokens, {
      id: "evt_1",
      type: "auth.magic-link.requested",
      globalPosition: "1",
      trace: { traceId: "req_1" },
      timing: {
        occurredAt: "2026-04-02T00:00:00.000Z",
        recordedAt: "2026-04-02T00:00:01.000Z",
      },
      data: {
        tokenId: "cmd_1",
        userId: null,
        email: "buyer@example.com",
        expiresAt: "2026-04-02T00:10:00.000Z",
      },
    } as never);

    expect(outbox.enqueueNotification).toHaveBeenCalledOnce();
    expect(deliveryTokens.clearMagicLinkDeliveryToken).toHaveBeenCalledWith("cmd_1");
    expect(outbox.enqueueNotification.mock.calls[0]?.[0].message.templateData).toEqual({
      magicLink: "https://chasesets.com/magic",
    });
  });
});
