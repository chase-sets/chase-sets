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
    expect(message.channels[0]).toMatchObject({
      channel: "email",
      to: [{ email: "buyer@example.com" }],
      subject: "Your Chase Sets sign-in link",
    });
    expect(message.templateData.magicLink).toBe("https://chasesets.com/magic/token");
  });
});
