// @vitest-environment jsdom

import { NumericValue } from "@chase-sets/design-system";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementWalletAdjustment } from "../../../client";
import { WalletAdjustmentReceiptCard } from "./wallet-adjustment-receipt";

function adjustment(overrides: Partial<SettlementWalletAdjustment> = {}): SettlementWalletAdjustment {
  return {
    adjustment_id: "wad_1",
    status: "posted",
    target_account_id: "acc_target",
    display_reference: "WAD-A1B2C3D4",
    direction: "credit",
    amount: "25.00",
    currency_code: "usd",
    reason_code: "goodwill-cash-credit",
    explanation: "Order shipped late",
    evidence_references: ["ord_1234"],
    reversal_of_adjustment_id: null,
    reversed_by_adjustment_id: null,
    requested_by: "usr_requester",
    requested_at: "2026-07-13T00:00:00.000Z",
    self_benefiting: false,
    approved_by: "usr_approver",
    approved_at: "2026-07-13T00:05:00.000Z",
    elevation_required: false,
    elevation_reasons: [],
    elevation_approved_by: null,
    creates_or_increases_negative_balance: false,
    reversal_after_funds_settled: false,
    high_value_credit_threshold_amount: null,
    high_value_debit_threshold_amount: null,
    recent_auth_max_age_minutes: null,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    posted_ledger_entry_id: "led_1",
    posted_at: "2026-07-13T00:06:00.000Z",
    available_balance_before: "100.00",
    available_balance_after: "125.00",
    reversed_at: null,
    updated_at: "2026-07-13T00:06:00.000Z",
    ...overrides,
  };
}

describe("WalletAdjustmentReceiptCard", () => {
  it("renders the posted receipt as an outlined entity without internal fields", () => {
    const html = renderToStaticMarkup(
      <WalletAdjustmentReceiptCard adjustment={adjustment()} targetAccountLabel="Account acc_target" />,
    );

    expect(html).toContain("Account acc_target");
    expect(html).toContain("Order shipped late");
    expect(html).toContain("ord_1234");
    expect(html).toContain(
      'data-testid="wallet-adjustment-receipt-entity" class="rounded-tokenLg border border-muted overflow-hidden bg-surface p-4"',
    );
    expect(html).not.toContain("led_1");
    expect(html).not.toContain("idempotency");
    expect(html).not.toContain("{");
  });

  it("renders a rejected receipt with the rejection reason", () => {
    const html = renderToStaticMarkup(
      <WalletAdjustmentReceiptCard
        adjustment={adjustment({
          status: "rejected",
          rejected_by: "usr_approver",
          rejected_at: "2026-07-13T00:05:00.000Z",
          rejection_reason: "Duplicate request",
          posted_at: null,
          posted_ledger_entry_id: null,
          available_balance_before: null,
          available_balance_after: null,
        })}
        targetAccountLabel="Account acc_target"
      />,
    );

    expect(html).toContain("Duplicate request");
  });

  it("renders a reversed receipt", () => {
    const html = renderToStaticMarkup(
      <WalletAdjustmentReceiptCard
        adjustment={adjustment({ status: "reversed", reversed_at: "2026-07-14T00:00:00.000Z" })}
        targetAccountLabel="Account acc_target"
      />,
    );

    expect(html).toContain("Reversed");
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

describe("WalletAdjustmentReceiptCard mono market-data role carriers", () => {
  it("derives the role class from the design system", () => {
    expect(numericValueClassName).not.toBe("");
  });

  it("roles the amount only, leaving the before/after balance sentence unroled", () => {
    const rendered = parse(
      renderToStaticMarkup(
        <WalletAdjustmentReceiptCard adjustment={adjustment()} targetAccountLabel="Account acc_target" />,
      ),
    );
    const carriers = numericValues(rendered);

    expect(textsOf(carriers)).toEqual(["$25.00"]);
    expect(carriers[0]?.tagName).toBe("SPAN");
    expect(carriers[0]?.parentElement?.tagName).toBe("DD");
    expect(carriers[0]?.textContent).toMatch(moneyPattern);
    expect(rendered.textContent).toContain("$100.00");
    expect(rendered.textContent).toContain("$125.00");
  });
});
