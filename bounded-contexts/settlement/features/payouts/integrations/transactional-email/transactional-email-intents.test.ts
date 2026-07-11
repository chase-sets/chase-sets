import { describe, expect, it } from "vitest";
import { mapPayoutCompletedToTransactionalEmail } from "./transactional-email-intents";

const payoutId = "pyo_01JZ6DKP7S7Z4AZ5N5E6K7M8N9";

describe("settlement transactional email intents", () => {
  it("maps payout completion to transactional email", () => {
    const message = mapPayoutCompletedToTransactionalEmail({
      sellerEmail: "seller@example.com",
      payoutId,
      amount: "42.00",
      correlationId: "req_3",
    });
    expect(message.messageType).toBe("settlement.payout.completed");
    expect(message.title).toBe("Payout PYO-E6K7M8N9 completed");
    expect(message.templateData).toMatchObject({ payoutReference: "PYO-E6K7M8N9", amount: "42.00" });
  });

  it("falls back to the raw payout id for fixed, human-readable seed payout ids", () => {
    const message = mapPayoutCompletedToTransactionalEmail({
      sellerEmail: "seller@example.com",
      payoutId: "pyo_seed_completed",
      amount: "42.00",
      correlationId: "req_3",
    });
    expect(message.title).toBe("Payout pyo_seed_completed completed");
  });
});
