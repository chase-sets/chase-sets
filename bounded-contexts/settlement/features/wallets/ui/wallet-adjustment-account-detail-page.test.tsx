// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementWalletAdjustmentAccountDetail } from "../../../client";
import { SettlementWalletAdjustmentAccountDetailPage } from "./wallet-adjustment-account-detail-page";

function adjustment(
  overrides: Partial<SettlementWalletAdjustmentAccountDetail> = {},
): SettlementWalletAdjustmentAccountDetail {
  return {
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
    ...overrides,
  };
}

describe("SettlementWalletAdjustmentAccountDetailPage", () => {
  it("renders a posted credit without any internal identifier or raw JSON", () => {
    const html = renderToStaticMarkup(<SettlementWalletAdjustmentAccountDetailPage adjustment={adjustment()} />);

    expect(html).toContain("WAD-E6K7M8N9");
    expect(html).toContain("Goodwill credit");
    expect(html).toContain("$50.00");
    expect(html).toContain("Contact support");
    expect(html).toContain("cash-equivalent");
    expect(html).not.toContain("wad_");
    expect(html).not.toContain("led_");
    expect(html).not.toContain("[missing:");
  });

  it("shows the correcting-entry link and reversal note when the adjustment has been reversed", () => {
    const html = renderToStaticMarkup(
      <SettlementWalletAdjustmentAccountDetailPage
        adjustment={adjustment({
          status: "reversed",
          reversed_at: "2026-07-12T00:00:00.000Z",
          reversed_by_display_reference: "WAD-Z5N5E6K7",
        })}
      />,
    );

    expect(html).toContain("WAD-Z5N5E6K7");
    expect(html).toContain("/account/wallet/adjustments/WAD-Z5N5E6K7");
    expect(html).not.toContain("[missing:");
  });

  it("shows the original-entry link when this adjustment is itself a correcting entry", () => {
    const html = renderToStaticMarkup(
      <SettlementWalletAdjustmentAccountDetailPage
        adjustment={adjustment({
          display_reference: "WAD-Z5N5E6K7",
          direction: "debit",
          reversal_of_display_reference: "WAD-E6K7M8N9",
        })}
      />,
    );

    expect(html).toContain("/account/wallet/adjustments/WAD-E6K7M8N9");
    expect(html).not.toContain("[missing:");
  });
});
