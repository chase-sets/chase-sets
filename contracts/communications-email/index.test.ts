import { describe, expect, it } from "vitest";
import {
  createNoopTransactionalEmailOutbox,
  type TransactionalEmailMessage,
  type TransactionalEmailMessageType,
} from ".";

describe("communications-email contract", () => {
  it("supports typed transactional email payloads", () => {
    const messageType: TransactionalEmailMessageType = "auth.magic-link.requested";
    const message: TransactionalEmailMessage = {
      messageType,
      criticality: "security",
      to: [{ email: "buyer@example.com" }],
      subject: "Sign in link",
      templateId: "auth_magic_link",
      templateVersion: 1,
      locale: "en",
      templateData: { magicLink: "https://example.com/magic" },
      idempotencyKey: "auth:magic:usr_123",
      correlationId: "req_123",
      actor: {
        userId: null,
        accountId: null,
      },
    };

    expect(message.to[0].email).toBe("buyer@example.com");
  });

  it("supports a no-op transactional email outbox for unconfigured composition roots", async () => {
    const outbox = createNoopTransactionalEmailOutbox();

    await expect(
      outbox.claimPendingTransactionalEmails({
        limit: 10,
        claimOwnerId: "test",
        claimTtlMs: 1_000,
      }),
    ).resolves.toEqual([]);
  });
});
