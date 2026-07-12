import { describe, expect, it, vi } from "vitest";
import { buildPayoutReadinessProjectionHandlers } from "./projection";

function readinessEvent(streamVersion: number, overrides: Record<string, unknown> = {}) {
  return {
    streamVersion,
    data: {
      accountId: "acc_seller",
      status: "ready",
      missingRequirements: [],
      advisoryRequirements: ["individual.verification.document"],
      disabledReason: null,
      requirementsDeadline: "2026-08-01T00:00:00.000Z",
      providerReference: "acct_test",
      contactEmail: null,
      onboardingStatus: "complete",
      transferCapabilityStatus: "active",
      payoutCapabilityStatus: "active",
      payoutDestinationStatus: "ready",
      payoutDestinationFingerprint: null,
      payoutDestinationChangedAt: null,
      payoutAccountDashboard: "none",
      lossesCollector: "application",
      feesCollector: "application",
      requirementsCollector: "application",
      recordedAt: "2026-07-12T12:00:00.000Z",
      ...overrides,
    },
  } as never;
}

describe("payout readiness projection", () => {
  it("projects transitions between advisory-only readiness and blocking requirements", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handler = buildPayoutReadinessProjectionHandlers(db as never)["settlement.payout-readiness.recorded"]!;

    await handler(readinessEvent(1));
    await handler(
      readinessEvent(2, {
        status: "restricted",
        missingRequirements: ["external_account"],
        advisoryRequirements: [],
        disabledReason: "requirements.past_due",
        requirementsDeadline: "2026-07-15T00:00:00.000Z",
      }),
    );

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("advisory_requirements = EXCLUDED.advisory_requirements"),
      expect.arrayContaining(["ready", "[]", '["individual.verification.document"]', "2026-08-01T00:00:00.000Z"]),
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.arrayContaining([
        "restricted",
        '["external_account"]',
        "requirements.past_due",
        "2026-07-15T00:00:00.000Z",
      ]),
    );
  });
});
