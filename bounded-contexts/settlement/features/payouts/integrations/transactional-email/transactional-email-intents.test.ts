import { describe, expect, it } from "vitest";
import { mapPayoutCompletedToTransactionalEmail } from "./transactional-email-intents";

describe("settlement transactional email intents", () => {
  it("maps payout completion to transactional email", () => {
    const message = mapPayoutCompletedToTransactionalEmail({
      sellerEmail: "seller@example.com",
      payoutId: "payout_123",
      amount: "42.00",
      correlationId: "req_3",
    });
    expect(message.messageType).toBe("settlement.payout.completed");
  });
});
