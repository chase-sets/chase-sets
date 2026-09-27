// @vitest-environment jsdom

import { NumericValue } from "@chase-sets/design-system";
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
  it("renders a posted credit as an outlined entity without internal identifiers", () => {
    const html = renderToStaticMarkup(<SettlementWalletAdjustmentAccountDetailPage adjustment={adjustment()} />);

    expect(html).toContain("WAD-E6K7M8N9");
    expect(html).toContain("Goodwill credit");
    expect(html).toContain("$50.00");
    expect(html).toContain("Contact support");
    expect(html).toContain("cash-equivalent");
    expect(html).toContain(
      'data-testid="wallet-adjustment-detail-entity" class="rounded-tokenLg border border-muted overflow-hidden bg-surface p-4"',
    );
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

describe("SettlementWalletAdjustmentAccountDetailPage mono market-data role carriers", () => {
  it("derives the role class from the design system", () => {
    expect(numericValueClassName).not.toBe("");
  });

  it("roles the amount and the resulting balance of a posted adjustment", () => {
    const rendered = parse(
      renderToStaticMarkup(<SettlementWalletAdjustmentAccountDetailPage adjustment={adjustment()} />),
    );
    const carriers = numericValues(rendered);

    expect(textsOf(carriers)).toEqual(["$40.00", "$50.00"]);
    for (const carrier of carriers) {
      expect(carrier.tagName).toBe("SPAN");
      expect(carrier.parentElement?.tagName).toBe("DD");
      expect(carrier.textContent).toMatch(moneyPattern);
    }
  });

  it("roles only the amount while the adjustment is still requested and has no resulting balance", () => {
    const rendered = parse(
      renderToStaticMarkup(
        <SettlementWalletAdjustmentAccountDetailPage
          adjustment={adjustment({ status: "requested", posted_at: null, available_balance_after: null })}
        />,
      ),
    );

    expect(textsOf(numericValues(rendered))).toEqual(["$40.00"]);
    expect(rendered.textContent).not.toContain("$50.00");
  });
});
