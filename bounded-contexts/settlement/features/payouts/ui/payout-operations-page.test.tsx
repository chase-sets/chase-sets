// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import { SettlementPayoutOperationsPage } from "./payout-operations-page";

function readiness(overrides: Partial<SettlementPayoutReadinessRow> = {}): SettlementPayoutReadinessRow {
  return {
    account_id: "acc_test",
    status: "pending",
    missing_requirements: ["external_account"],
    advisory_requirements: [],
    disabled_reason: null,
    requirements_deadline: null,
    provider_reference: "acct_test",
    contact_email: null,
    onboarding_status: "pending",
    transfer_capability_status: "active",
    payout_capability_status: "pending",
    payout_destination_status: "missing",
    payout_destination_fingerprint: null,
    payout_destination_changed_at: null,
    payout_account_dashboard: "none",
    losses_collector: "application",
    fees_collector: "application",
    requirements_collector: "application",
    updated_at: "2026-06-01T15:00:00.000Z",
    ...overrides,
  };
}

describe("payout operations page setup signals", () => {
  it("renders queued reconciliation job snapshots as in-progress correction state", () => {
    const html = renderToStaticMarkup(
      <SettlementPayoutOperationsPage
        payouts={[]}
        payoutReadiness={readiness()}
        runResult={{
          jobId: "job_reconcile",
          status: "queued",
          progress: {
            phase: "queued",
            completed: 0,
            total: 3,
            message: "Payout reconciliation queued.",
          },
          result: null,
        }}
        lastCheckedAt="2026-06-15T20:00:00.000Z"
      />,
    );

    expect(html).toContain("queued");
    expect(html).toContain("Payout reconciliation queued.");
    expect(html).toContain("Checked");
    expect(html).toContain("reconciled");
  });

  it("renders support-safe payout setup health for operators", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T15:00:00.000Z"));

    const html = renderToStaticMarkup(
      <SettlementPayoutOperationsPage
        payouts={[]}
        payoutReadiness={readiness({
          status: "ready",
          missing_requirements: ["external_account", "individual.verification.document"],
          payout_destination_status: "ready",
        })}
      />,
    );

    expect(html).toContain("Payout setup blocked");
    expect(html).toContain("Open setup requirements");
    expect(html).toContain("Stale payout setup status");
    expect(html).toContain("Setup status");
    expect(html).toContain("Payout destination");
    expect(html).toContain("Setup last updated");
    expect(html).not.toContain("external_account");
    expect(html).not.toContain("individual.verification.document");

    vi.useRealTimers();
  });
});
