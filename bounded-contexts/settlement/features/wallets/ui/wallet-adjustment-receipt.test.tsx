// @vitest-environment jsdom

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
  it("renders the posted receipt without raw JSON, ledger-entry id, or idempotency field", () => {
    const html = renderToStaticMarkup(
      <WalletAdjustmentReceiptCard adjustment={adjustment()} targetAccountLabel="Account acc_target" />,
    );

    expect(html).toContain("Account acc_target");
    expect(html).toContain("Order shipped late");
    expect(html).toContain("ord_1234");
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
