// @vitest-environment jsdom

import { NumericValue } from "@chase-sets/design-system";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import type { SettlementPayoutRow } from "../../payouts/read-model/queries";
import type { SettlementLedgerEntryRow, SettlementWalletRow } from "../../wallets/read-model/queries";
import type { SettlementWalletAdjustmentAccountDetailRow } from "../../wallets/read-model/wallet-adjustment-queries";
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
    requested_amount: "80.00",
    fee_amount: "1.00",
    net_amount: "79.00",
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
            requested_amount: "45.00",
            fee_amount: "1.00",
            net_amount: "44.00",
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
    expect(html).toContain("$44.00");
    expect(html).toContain("Jul 20, 2026");
    expect(html).toContain("1 payout needs attention");
    expect(html).toContain("Review the recent payout failure before requesting more funds.");
    expect(html).toContain("Retry payout");
    expect(html).toContain('href="/payments-terms#payout-fee"');
    expect(html).toContain('href="/seller-agreement#fees-and-deductions"');
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

  it("shows requested amount, payout fee, and net payout before confirmation", () => {
    const html = renderToString(
      <SettlementMoneyDashboardPage
        wallet={wallet}
        entries={[]}
        payouts={[]}
        payoutReadiness={readiness}
        evaluatedAt="2026-07-15T12:00:00.000Z"
        canRequestPayouts
        canSetupPayouts
        canReconcilePayouts={false}
        actionState={{
          confirmation: {
            amount: "12.50",
            note: null,
            preview: {
              account_id: "acct-1",
              requested_amount: "12.50",
              fee_amount: "0.29",
              net_amount: "12.21",
              monthly_active_fee_amount: "0.00",
              is_first_payout_of_month: true,
              fee_policy_version: "fallback",
              fee_lines: [{ code: "payout-fee", label: "Payout fee", amount: "0.29" }],
              currency_code: "usd",
              available_balance_amount: "125.00",
              platform_available_amount: "1000.00",
              estimated_wallet_balance_after: "112.50",
              can_request: true,
              unavailable_reasons: [],
              unavailable_reason_details: [],
            },
          },
        }}
      />,
    );

    expect(html).toContain("Requested amount");
    expect(html).toContain("Payout fee");
    expect(html).toContain("Net payout");
    expect(html).toContain('href="/payments-terms#payout-fee"');
    expect(html).toContain('href="/seller-agreement#fees-and-deductions"');
    expect(html).toContain("$12.50");
    expect(html).toContain("$0.29");
    expect(html).toContain("$12.21");
  });

  it("caps the full-available shortcut label through the payout policy", () => {
    const html = renderToString(
      <SettlementMoneyDashboardPage
        wallet={{ ...wallet, available_balance_amount: "999999.00" }}
        entries={[]}
        payouts={[]}
        payoutReadiness={readiness}
        evaluatedAt="2026-07-15T12:00:00.000Z"
        canRequestPayouts
        canSetupPayouts
        canReconcilePayouts={false}
      />,
    );

    expect(html).toContain('name="availableAmount" value="999999.00"');
    expect(html).toContain("Full available · $10,000.00");
  });
});

/**
 * The role class is derived from a bare design-system render, never written
 * here, so this suite cannot drift from the primitive it observes.
 */
const numericValueClassName = renderToStaticMarkup(<NumericValue>0</NumericValue>).match(/class="([^"]*)"/)?.[1] ?? "";
const moneyPattern = /^-?\$[\d,]+\.\d{2}$/;

function numericValues(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll("span")].filter((span) => span.className === numericValueClassName);
}

function textsOf(elements: readonly HTMLElement[]): string[] {
  return elements.map((element) => element.textContent ?? "").sort();
}

const ledgerEntry: SettlementLedgerEntryRow = {
  ledger_entry_id: "led_dashboard_1",
  account_id: "acct-1",
  kind: "sale-proceeds",
  direction: "credit",
  amount: "5.25",
  currency_code: "usd",
  funds_status: "available",
  order_id: null,
  payment_id: null,
  payout_id: null,
  description: "Sale proceeds",
  posted_at: "2026-07-14T08:00:00.000Z",
  available_at: "2026-07-14T08:00:00.000Z",
  updated_at: "2026-07-14T08:00:00.000Z",
};

const selectedWalletAdjustment: SettlementWalletAdjustmentAccountDetailRow = {
  status: "posted",
  display_reference: "WAD-E6K7M8N9",
  direction: "credit",
  amount: "40.00",
  currency_code: "usd",
  reason_code: "goodwill-cash-credit",
  requested_at: "2026-07-10T00:00:00.000Z",
  posted_at: "2026-07-10T02:00:00.000Z",
  available_balance_before: "10.00",
  available_balance_after: "50.00",
  reversed_at: null,
  reversal_of_display_reference: null,
  reversed_by_display_reference: null,
};

describe("SettlementMoneyDashboardPage mono market-data role carriers", () => {
  afterEach(() => {
    cleanup();
  });

  it("derives the role class from the design system", () => {
    expect(numericValueClassName).not.toBe("");
  });

  it("roles every standalone money value on the page and the selected adjustment sheet, and nothing else", async () => {
    render(
      <SettlementMoneyDashboardPage
        wallet={wallet}
        entries={[ledgerEntry]}
        payouts={[
          payout({
            payout_id: "next",
            display_reference: "PYO-NEXT",
            status: "in-transit",
            failure_reason: null,
            failed_at: null,
            sent_at: "2026-07-15T12:00:00.000Z",
          }),
        ]}
        payoutReadiness={readiness}
        evaluatedAt="2026-07-15T12:00:00.000Z"
        selectedWalletAdjustment={selectedWalletAdjustment}
        canRequestPayouts
        canSetupPayouts
        canReconcilePayouts={false}
      />,
    );

    const sheet = await screen.findByRole("dialog", { name: /WAD-E6K7M8N9/ });
    const sheetCarriers = numericValues(sheet);
    const pageCarriers = numericValues(document.body).filter((carrier) => !sheet.contains(carrier));

    // Wallet available balance, next payout, the timeline net payout, and the
    // ledger amount (desktop cell plus mobile card).
    expect(textsOf(pageCarriers)).toEqual(["$125.00", "$5.25", "$5.25", "$79.00", "$79.00"]);
    const timelineNet = pageCarriers.find((carrier) => carrier.parentElement?.textContent === "Net payout: $79.00");
    expect(timelineNet?.textContent).toBe("$79.00");
    const ledgerCarriers = pageCarriers.filter((carrier) => carrier.textContent === "$5.25");
    expect(ledgerCarriers.map((carrier) => carrier.parentElement?.tagName).sort()).toEqual(["DD", "TD"]);

    // Adjustment amount and resulting balance inside the selected sheet.
    expect(textsOf(sheetCarriers)).toEqual(["$40.00", "$50.00"]);
    for (const carrier of sheetCarriers) {
      expect(carrier.parentElement?.tagName).toBe("DD");
    }

    // Interpolated copy keeps the amount inside the sentence, unroled.
    const pending = screen.getByText("$30.00 pending");
    expect(numericValues(pending)).toHaveLength(0);
    for (const carrier of [...pageCarriers, ...sheetCarriers]) {
      expect(carrier.textContent).toMatch(moneyPattern);
    }
  });

  it("roles the requested, fee, and net values inside the payout breakdown sheet once it opens", async () => {
    const user = userEvent.setup();
    render(
      <SettlementMoneyDashboardPage
        wallet={wallet}
        entries={[]}
        payouts={[payout()]}
        payoutReadiness={readiness}
        evaluatedAt="2026-07-15T12:00:00.000Z"
        canRequestPayouts
        canSetupPayouts
        canReconcilePayouts={false}
      />,
    );

    expect(screen.getByText("None scheduled")).toBeTruthy();
    expect(textsOf(numericValues(document.body))).toEqual(["$125.00", "$79.00"]);

    await user.click(screen.getByRole("button", { name: "View breakdown" }));
    const sheet = await screen.findByRole("dialog", { name: "PYO-PAY1 breakdown" });
    const breakdownCarriers = numericValues(sheet);

    expect(textsOf(breakdownCarriers)).toEqual(["$1.00", "$79.00", "$80.00"]);
    for (const carrier of breakdownCarriers) {
      expect(carrier.tagName).toBe("SPAN");
      expect(carrier.parentElement?.tagName).toBe("SPAN");
      expect(carrier.textContent).toMatch(moneyPattern);
    }
    expect(within(sheet).getByText("Requested amount")).toBeTruthy();
  });
});
