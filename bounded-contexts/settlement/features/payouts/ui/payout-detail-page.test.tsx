// @vitest-environment jsdom

import { NumericValue } from "@chase-sets/design-system";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementPayoutRow } from "../read-model/queries";
import { SettlementPayoutDetailPage, SettlementPayoutDetailRecoveryPage } from "./payout-detail-page";

function payout(overrides: Partial<SettlementPayoutRow> = {}): SettlementPayoutRow {
  return {
    payout_id: "payout_test",
    account_id: "acc_test",
    amount: "125.00",
    requested_amount: "125.00",
    fee_amount: "1.00",
    net_amount: "124.00",
    currency_code: "usd",
    destination_reference: null,
    note: null,
    display_reference: "PYO-TEST1234",
    status: "failed",
    provider_transfer_reference: "tr_test",
    provider_payout_reference: "po_test",
    provider_status: "failed",
    provider_failure_code: "account_closed",
    provider_failure_message: "Bank account is closed.",
    requested_at: "2026-06-01T15:00:00.000Z",
    updated_at: "2026-06-01T15:05:00.000Z",
    sent_at: "2026-06-01T15:01:00.000Z",
    completed_at: null,
    failed_at: "2026-06-01T15:05:00.000Z",
    failure_reason: "Payout account details need review.",
    last_provider_event_at: "2026-06-01T15:05:00.000Z",
    last_reconciled_at: null,
    retry_count: 0,
    next_retry_at: null,
    retry_reason: null,
    ...overrides,
  };
}

describe("payout detail recovery paths", () => {
  it("renders failed payout recovery actions without exposing provider failure details to regular accounts", () => {
    const html = renderToStaticMarkup(
      <SettlementPayoutDetailPage backHref="/account/desk/money" payout={payout()} showSupportDetails={false} />,
    );

    expect(html).toContain("Payout PYO-TEST1234");
    expect(html).toContain("Payout account needs review");
    expect(html).toContain("Review payout details");
    expect(html).toContain("Contact support");
    expect(html).toContain("Requested amount");
    expect(html).toContain("Payout fee");
    expect(html).toContain("Net payout");
    expect(html).toContain("Net payout: $124.00");
    expect(html).toContain("$125.00");
    expect(html).toContain("$1.00");
    expect(html).toContain("$124.00");
    expect(html).toContain('href="/account/desk/settings?mode=manage"');
    expect(html).not.toContain("account_closed");
    expect(html).not.toContain("Bank account is closed.");
    expect(html).not.toContain("tr_test");
    expect(html).not.toContain("po_test");
    expect(html).not.toContain("Express Dashboard");
  });

  it("renders fresh-write payout preparation as a local recovery state", () => {
    const html = renderToStaticMarkup(<SettlementPayoutDetailRecoveryPage />);

    expect(html).toContain("Preparing payout");
    expect(html).toContain("preparing your payout details");
    expect(html).toContain('href="/account/desk/money"');
  });

  it("keeps support-only payout audit details as an outlined entity", () => {
    const html = renderToStaticMarkup(
      <SettlementPayoutDetailPage backHref="/account/desk/money" payout={payout()} showSupportDetails />,
    );

    expect(html).toContain(
      'data-testid="payout-support-details-entity" class="rounded-tokenLg border border-muted overflow-hidden bg-surface p-4"',
    );
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

describe("SettlementPayoutDetailPage mono market-data role carriers", () => {
  it("derives the role class from the design system", () => {
    expect(numericValueClassName).not.toBe("");
  });

  it("roles the requested, fee, and net breakdown values and leaves the header sentence alone", () => {
    const rendered = parse(
      renderToStaticMarkup(
        <SettlementPayoutDetailPage backHref="/account/desk/money" payout={payout()} showSupportDetails={false} />,
      ),
    );
    const carriers = numericValues(rendered);

    expect(textsOf(carriers)).toEqual(["$1.00", "$124.00", "$125.00"]);
    for (const carrier of carriers) {
      expect(carrier.tagName).toBe("SPAN");
      expect(carrier.parentElement?.tagName).toBe("SPAN");
      expect(carrier.textContent).toMatch(moneyPattern);
    }
    const header = [...rendered.querySelectorAll("*")].find(
      (element) => element.textContent === "Net payout: $124.00" && element.children.length === 0,
    );
    expect(header).toBeDefined();
  });
});
