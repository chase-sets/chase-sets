import { describe, expect, it } from "vitest";
import type { SettlementPayoutReadinessRow } from "../read-model/queries";
import {
  buildPayoutSetupProgress,
  derivePayoutSetupAttention,
  derivePayoutSetupDecision,
  withPayoutSetupDecision,
} from "./setup-progress";
import { payoutReadinessFixture, payoutSetupMatrix } from "../tests/setup-decision.test-data";

function readiness(overrides: Partial<SettlementPayoutReadinessRow> = {}): SettlementPayoutReadinessRow {
  return {
    account_id: "acc_seller",
    status: "pending",
    missing_requirements: [],
    advisory_requirements: [],
    disabled_reason: null,
    requirements_deadline: null,
    provider_reference: "acct_test",
    contact_email: null,
    onboarding_status: "pending",
    transfer_capability_status: "pending",
    payout_capability_status: "pending",
    payout_destination_status: "pending",
    payout_destination_fingerprint: null,
    payout_destination_changed_at: null,
    payout_account_dashboard: "none",
    losses_collector: "application",
    fees_collector: "application",
    requirements_collector: "application",
    updated_at: "2026-06-01T17:00:00.000Z",
    ...overrides,
  };
}

describe("payout setup progress", () => {
  it("keeps blocked display state separate from strict 30-day staleness", () => {
    const base = readiness({ status: "ready", provider_reference: "acct_test" });
    expect(derivePayoutSetupAttention(base, "2026-07-01T15:00:00.000Z")).toEqual({
      setup_blocked: false,
      setup_stale: false,
      setup_stale_after_days: 30,
    });
    expect(
      derivePayoutSetupAttention({ ...base, updated_at: "2026-06-01T15:00:00.000Z" }, "2026-07-01T15:00:00.001Z"),
    ).toMatchObject({ setup_stale: true });
    expect(derivePayoutSetupAttention({ ...base, updated_at: null })).toMatchObject({
      setup_stale: false,
    });
    expect(derivePayoutSetupAttention({ ...base, provider_reference: null })).toMatchObject({
      setup_blocked: true,
    });
  });

  it.each(payoutSetupMatrix)("matrix-row-tests: $name", ({ projection, expected }) => {
    expect(derivePayoutSetupDecision(projection)).toEqual(expected);
    expect(buildPayoutSetupProgress(projection)).toMatchObject(expected);
    expect(withPayoutSetupDecision(projection)).toEqual({ ...projection, ...expected });
    expect(derivePayoutSetupDecision(projection)).toEqual(expected);
  });

  it("unknown-input-negative-tests: missing provider facts never enable management", () => {
    for (const provider_reference of [null, ""]) {
      expect(derivePayoutSetupDecision(payoutReadinessFixture({ provider_reference }))).toMatchObject({
        provider_management_available: false,
        support_recommended: false,
      });
    }
    expect(derivePayoutSetupDecision(payoutReadinessFixture({ missing_requirements: ["", " "] }))).toMatchObject({
      next_step: "none",
      support_recommended: false,
    });
  });

  it("groups embedded setup requirements into support-safe account-facing buckets", () => {
    const progress = buildPayoutSetupProgress(
      readiness({
        missing_requirements: [
          "external_account",
          "individual.verification.document",
          "company.tax_id",
          "tos_acceptance.date",
          "external_account",
          "future_requirement.review",
        ],
      }),
    );

    expect(progress.missing_requirement_groups).toEqual([
      {
        id: "payout-account",
        label: "Payout account",
        count: 1,
        detail: "Add or confirm the payout account before requesting payouts.",
      },
      {
        id: "identity-and-business",
        label: "Identity and business details",
        count: 2,
        detail: "Review the account, identity, or business details requested during setup.",
      },
      {
        id: "account-agreement",
        label: "Account agreement",
        count: 1,
        detail: "Review and accept the required account terms.",
      },
      {
        id: "verification-review",
        label: "Verification review",
        count: 1,
        detail: "Review the remaining verification details requested during setup.",
      },
    ]);
    expect(JSON.stringify(progress.missing_requirement_groups)).not.toContain("external_account");
    expect(JSON.stringify(progress.missing_requirement_groups)).not.toContain("individual.verification.document");
  });

  it("routes provider posture blockers to platform review", () => {
    const progress = buildPayoutSetupProgress(
      readiness({ missing_requirements: ["provider_dashboard_posture", "provider_fee_payer_posture"] }),
    );

    expect(progress.missing_requirement_groups).toEqual([
      {
        id: "platform-review",
        label: "Platform review",
        count: 2,
        detail: "Contact support while Chase Sets reviews the payout provider configuration.",
      },
    ]);
  });
});
