// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementPayoutRow } from "../read-model/queries";
import { SettlementMoneyHealthPage } from "./money-health-page";

const payoutWithFee: SettlementPayoutRow = {
  payout_id: "pyo_money_health_fee",
  account_id: "acc_seller",
  amount: "12.50",
  requested_amount: "12.50",
  fee_amount: "0.29",
  net_amount: "12.21",
  currency_code: "usd",
  destination_reference: null,
  note: null,
  display_reference: "PYO-MONEYHLTH",
  status: "in-transit",
  provider_transfer_reference: "tr_synthetic_money_health",
  provider_payout_reference: "po_synthetic_money_health",
  provider_status: "pending",
  provider_failure_code: null,
  provider_failure_message: null,
  requested_at: "2026-09-11T12:00:00.000Z",
  updated_at: "2026-09-11T12:01:00.000Z",
  sent_at: "2026-09-11T12:01:00.000Z",
  completed_at: null,
  failed_at: null,
  failure_reason: null,
  last_provider_event_at: null,
  last_reconciled_at: null,
  retry_count: 0,
  next_retry_at: null,
  retry_reason: null,
};

describe("SettlementMoneyHealthPage", () => {
  it("renders a populated platform balance forecast as flat page furniture", () => {
    const html = renderToStaticMarkup(
      <SettlementMoneyHealthPage
        payouts={[payoutWithFee]}
        negativeBalanceAccounts={[]}
        reconciliationRuns={[]}
        platformBalanceForecast={{
          currency_code: "usd",
          available_amount: "1250.00",
          pending_payout_demand_amount: "200.00",
          forecast_after_pending_demand_amount: "1050.00",
        }}
        providerHealth={{
          provider_name: "Stripe",
          adapter_mode: "stripe",
          webhook_signature_required: true,
          webhook_failure_classes: [],
          platform_balance_supported: true,
          connected_account_payouts_supported: true,
        }}
      />,
    );

    const rendered = document.createElement("div");
    rendered.innerHTML = html;
    const forecast = rendered.querySelector('[data-testid="platform-balance-forecast-furniture"]');
    expect(forecast?.textContent).toContain("$1,250.00");
    expect(forecast?.textContent).toContain("$200.00");
    expect(forecast?.textContent).toContain("$1,050.00");
    expect(forecast?.querySelector(".ds-glass")).toBeNull();
    expect(html).toContain("Requested");
    expect(html).toContain("$12.50");
    expect(html).toContain("Payout fee");
    expect(html).toContain("$0.29");
    expect(html).toContain("Net payout");
    expect(html).toContain("$12.21");
  });
});
