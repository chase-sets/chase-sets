// @vitest-environment jsdom

import { NumericValue } from "@chase-sets/design-system";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementWalletRow } from "../../wallets/read-model/queries";
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

/**
 * The role class is derived from a bare design-system render, never written
 * here, so this suite cannot drift from the primitive it observes.
 */
const numericValueClassName = renderToStaticMarkup(<NumericValue>0</NumericValue>).match(/class="([^"]*)"/)?.[1] ?? "";
const moneyPattern = /^-?\$[\d,]+\.\d{2}$/;

function parse(html: string): HTMLDivElement {
  const rendered = document.createElement("div");
  rendered.innerHTML = html;
  return rendered;
}

function numericValues(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll("span")].filter((span) => span.className === numericValueClassName);
}

function textsOf(elements: readonly HTMLElement[]): string[] {
  return elements.map((element) => element.textContent ?? "").sort();
}

const negativeWallet: SettlementWalletRow = {
  account_id: "acc_negative",
  currency_code: "usd",
  available_balance_amount: "-42.00",
  pending_balance_amount: "0.00",
  total_credited_amount: "100.00",
  total_debited_amount: "142.00",
  negative_balance_status: "collections",
  negative_balance_started_at: "2026-09-01T00:00:00.000Z",
  collections_escalated_at: "2026-09-08T00:00:00.000Z",
  opened_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-09-08T00:00:00.000Z",
};

function renderHealthPage(negativeBalanceAccounts: readonly SettlementWalletRow[]): HTMLDivElement {
  return parse(
    renderToStaticMarkup(
      <SettlementMoneyHealthPage
        payouts={[payoutWithFee]}
        negativeBalanceAccounts={negativeBalanceAccounts}
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
    ),
  );
}

describe("SettlementMoneyHealthPage mono market-data role carriers", () => {
  it("derives the role class from the design system", () => {
    expect(numericValueClassName).not.toBe("");
  });

  it("roles the forecast demand values and every payout amount column, leaving interpolated copy alone", () => {
    const rendered = renderHealthPage([]);
    const carriers = numericValues(rendered);

    // Two forecast lines plus three payout columns rendered twice (desktop cell
    // and mobile card).
    expect(textsOf(carriers)).toEqual([
      "$0.29",
      "$0.29",
      "$1,050.00",
      "$12.21",
      "$12.21",
      "$12.50",
      "$12.50",
      "$200.00",
    ]);
    for (const carrier of carriers) {
      expect(carrier.tagName).toBe("SPAN");
      expect(carrier.textContent).toMatch(moneyPattern);
    }
    const demand = carriers.find((carrier) => carrier.textContent === "$200.00");
    expect(demand?.parentElement?.textContent).toBe("Pending payout demand: $200.00");
    const forecast = carriers.find((carrier) => carrier.textContent === "$1,050.00");
    expect(forecast?.parentElement?.textContent).toBe("Forecast after pending demand: $1,050.00");
    expect(rendered.textContent).toContain("$1,250.00 available");
    expect(carriers.some((carrier) => carrier.textContent?.includes("$1,250.00"))).toBe(false);
  });

  it("roles a negative available balance in the negative-balance accounts table", () => {
    const rendered = renderHealthPage([negativeWallet]);
    const carriers = numericValues(rendered).filter((carrier) => carrier.textContent === "-$42.00");

    expect(carriers.map((carrier) => carrier.parentElement?.tagName).sort()).toEqual(["DD", "TD"]);
    expect(numericValues(rendered)).toHaveLength(10);
  });
});
