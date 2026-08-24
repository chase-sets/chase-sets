// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettlementMoneyHealthPage } from "./money-health-page";

describe("SettlementMoneyHealthPage", () => {
  it("renders a populated platform balance forecast as flat page furniture", () => {
    const html = renderToStaticMarkup(
      <SettlementMoneyHealthPage
        payouts={[]}
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
  });
});
