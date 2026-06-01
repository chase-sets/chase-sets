import { describe, expect, it } from "vitest";
import { decidePayoutReadiness, evolvePayoutReadiness, initialPayoutReadinessState } from "./domain";

describe("payout readiness", () => {
  it("normalizes readiness requirements and provider references", () => {
    const [event] = decidePayoutReadiness(initialPayoutReadinessState, {
      type: "RecordPayoutReadiness",
      accountId: "acc_1" as never,
      status: "restricted",
      missingRequirements: ["tax-id", " bank-account ", "tax-id", ""],
      providerReference: " stripe-acct ",
      payoutAccountDashboard: "express",
      lossesCollector: "application",
      feesCollector: "bad-value",
      requirementsCollector: "stripe",
      recordedAt: "2026-04-30T00:00:00.000Z",
    });

    expect(evolvePayoutReadiness(initialPayoutReadinessState, event!)).toMatchObject({
      accountId: "acc_1",
      status: "restricted",
      missingRequirements: ["bank-account", "tax-id"],
      providerReference: "stripe-acct",
      payoutAccountDashboard: "express",
      lossesCollector: "application",
      feesCollector: "unknown",
      requirementsCollector: "stripe",
      updatedAt: "2026-04-30T00:00:00.000Z",
    });
  });
});
