// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import type { SettlementWalletRow } from "../../wallets/read-model/queries";
import { payoutUnavailableReasonLabel } from "../domain/reason-codes";
import { SettlementPayoutRequestPanel } from "./payout-request-panel";

const wallet: SettlementWalletRow = {
  account_id: "acct-1",
  currency_code: "usd",
  available_balance_amount: "0.00",
  pending_balance_amount: "0.00",
  total_credited_amount: "0.00",
  total_debited_amount: "0.00",
  negative_balance_status: "in-good-standing",
  negative_balance_started_at: null,
  collections_escalated_at: null,
  opened_at: null,
  updated_at: null,
};

const readiness: SettlementPayoutReadinessRow = {
  account_id: "acct-1",
  status: "ready",
  missing_requirements: [],
  advisory_requirements: [],
  disabled_reason: null,
  requirements_deadline: null,
  provider_reference: null,
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
  updated_at: "2026-10-12T12:00:00.000Z",
};

const quickAmounts = {
  currency_code: "usd",
  minimum_amount: "7.25",
  maximum_amount: "250.00",
  full_available_amount: "0.00",
} as const;

describe("SettlementPayoutRequestPanel", () => {
  it.each([
    { amount: "0.00", payable: false },
    { amount: "-5.00", payable: false },
    { amount: "abc", payable: false },
    { amount: "0.01", payable: true },
  ])("gates payout availability on exact signed balance comparison: $amount", ({ amount, payable }) => {
    const html = renderToStaticMarkup(
      <SettlementPayoutRequestPanel
        wallet={{ ...wallet, available_balance_amount: amount }}
        payoutReadiness={readiness}
        canRequestPayouts
        quickAmounts={quickAmounts}
      />,
    );
    const rendered = document.createElement("div");
    rendered.innerHTML = html;
    const reason = payoutUnavailableReasonLabel("no-available-wallet-balance");
    expect(rendered.textContent?.includes(reason)).toBe(!payable);
    const actions = [...rendered.querySelectorAll<HTMLButtonElement>('button[type="submit"]')];
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((button) => button.disabled)).toBe(!payable);
    expect(rendered.querySelector<HTMLInputElement>('input[name="amount"]')?.disabled).toBe(!payable);
  });

  it("uses API quick amounts for bounds and labels and disables an empty full-available shortcut", () => {
    const html = renderToStaticMarkup(
      <SettlementPayoutRequestPanel
        wallet={{ ...wallet, available_balance_amount: "125.00" }}
        payoutReadiness={readiness}
        canRequestPayouts
        quickAmounts={quickAmounts}
      />,
    );
    const rendered = document.createElement("div");
    rendered.innerHTML = html;

    const amount = rendered.querySelector<HTMLInputElement>('input[name="amount"]');
    expect(amount?.min).toBe("7.25");
    expect(amount?.max).toBe("250");
    expect(rendered.textContent).toContain("Minimum · $7.25");
    expect(rendered.textContent).toContain("Full available · $0.00");
    expect(rendered.querySelector<HTMLButtonElement>('button[value="minimum"]')?.disabled).toBe(false);
    expect(rendered.querySelector<HTMLButtonElement>('button[value="available"]')?.disabled).toBe(true);
  });
});
