import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import type { SettlementPayoutRow } from "../../payouts/read-model/queries";
import type { SettlementWalletRow } from "../../wallets/read-model/queries";
import { SettlementMoneyDashboardPage } from "./money-dashboard-page";

const wallet: SettlementWalletRow = {
  account_id: "acct-1",
  currency_code: "usd",
  available_balance_amount: "125.00",
  pending_balance_amount: "30.00",
  total_credited_amount: "300.00",
  total_debited_amount: "145.00",
  negative_balance_status: "in-good-standing",
  negative_balance_started_at: null,
  collections_escalated_at: null,
  opened_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-15T00:00:00.000Z",
};

const readiness: SettlementPayoutReadinessRow = {
  account_id: "acct-1",
  status: "ready",
  missing_requirements: [],
  advisory_requirements: [],
  disabled_reason: null,
  requirements_deadline: null,
  provider_reference: "acct_provider_internal",
  contact_email: null,
  onboarding_status: "complete",
  transfer_capability_status: "active",
  payout_capability_status: "active",
  payout_destination_status: "ready",
  payout_destination_fingerprint: null,
  payout_destination_changed_at: null,
  payout_account_dashboard: "none",
  losses_collector: "application",
  fees_collector: "application",
  requirements_collector: "application",
  updated_at: "2026-07-15T00:00:00.000Z",
};

function payout(overrides: Partial<SettlementPayoutRow> = {}): SettlementPayoutRow {
  return {
    payout_id: "pay-1",
    account_id: "acct-1",
    amount: "80.00",
    currency_code: "usd",
    destination_reference: null,
    note: null,
    display_reference: "PYO-PAY1",
    status: "failed",
    provider_transfer_reference: "provider-transfer-secret",
    provider_payout_reference: "provider-payout-secret",
    provider_status: "failed",
    provider_failure_code: "recent-payout-failure",
    provider_failure_message: "The payout destination needs attention.",
    requested_at: "2026-07-14T09:00:00.000Z",
    updated_at: "2026-07-14T10:00:00.000Z",
    sent_at: null,
    completed_at: null,
    failed_at: "2026-07-14T10:00:00.000Z",
    failure_reason: "recent-payout-failure",
    last_provider_event_at: null,
    last_reconciled_at: null,
    retry_count: 0,
    next_retry_at: null,
    retry_reason: null,
    ...overrides,
  };
}

describe("SettlementMoneyDashboardPage", () => {
  it("renders money actions and keeps the payout-request entity elevated", () => {
    const html = renderToString(
      <SettlementMoneyDashboardPage
        wallet={wallet}
        entries={[]}
        payouts={[
          payout(),
          payout({
            payout_id: "next",
            display_reference: "PYO-NEXT",
            amount: "45.00",
            status: "in-transit",
            provider_payout_reference: "provider-next-secret",
            failure_reason: null,
            failed_at: null,
            sent_at: "2026-07-15T12:00:00.000Z",
          }),
        ]}
        payoutReadiness={readiness}
        evaluatedAt="2026-07-15T12:00:00.000Z"
        canRequestPayouts
        canSetupPayouts
        canReconcilePayouts
      />,
    );

    expect(html).toContain("$125.00");
    expect(html).toContain("$45.00");
    expect(html).toContain("Jul 20, 2026");
    expect(html).toContain("1 payout needs attention");
    expect(html).toContain("Review the recent payout failure before requesting more funds.");
    expect(html).toContain("Retry payout");
    expect(html).toContain("Contact support");
    expect(html).toContain(
      'data-testid="payout-request-entity" class="ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden p-4"',
    );
    expect(html).not.toContain("provider-payout-secret");
    expect(html).not.toContain("provider-transfer-secret");
  });

  it("enters payout setup from the dashboard when setup is incomplete", () => {
    const html = renderToString(
      <SettlementMoneyDashboardPage
        wallet={wallet}
        entries={[]}
        payouts={[]}
        payoutReadiness={{ ...readiness, status: "not-started", provider_reference: null }}
        evaluatedAt="2026-07-15T12:00:00.000Z"
        canRequestPayouts
        canSetupPayouts
        canReconcilePayouts={false}
      />,
    );

    expect(html).toContain("Finish payout setup");
    expect(html).toContain("/account/desk/settings");
  });
});
