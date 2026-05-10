import { describe, expect, it } from "vitest";
import { mapMagicLinkRequestedToTransactionalEmail } from "./transactional-email-intents";

describe("auth transactional email intents", () => {
  it("maps magic link requests to transactional email messages", () => {
    const message = mapMagicLinkRequestedToTransactionalEmail({
      email: "buyer@example.com",
      magicLink: "https://chasesets.com/magic/token",
      correlationId: "req_123",
      idempotencyKey: "auth:magic:buyer@example.com:req_123",
    });

    expect(message.messageType).toBe("auth.magic-link.requested");
    expect(message.to[0]?.email).toBe("buyer@example.com");
    expect(message.templateData.magicLink).toBe("https://chasesets.com/magic/token");
  });
});
