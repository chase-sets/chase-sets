// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementPayoutRow } from "../read-model/queries";
import { SettlementPayoutDetailPage, SettlementPayoutDetailRecoveryPage } from "./payout-detail-page";

function payout(overrides: Partial<SettlementPayoutRow> = {}): SettlementPayoutRow {
  return {
    payout_id: "payout_test",
    account_id: "acc_test",
    amount: "125.00",
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
      <SettlementPayoutDetailPage backHref="/account/payouts" payout={payout()} showSupportDetails={false} />,
    );

    expect(html).toContain("Payout PYO-TEST1234");
    expect(html).toContain("Payout account needs review");
    expect(html).toContain("Review payout details");
    expect(html).toContain("Contact support");
    expect(html).toContain('href="/account/payouts/setup?mode=manage"');
    expect(html).not.toContain("account_closed");
    expect(html).not.toContain("Bank account is closed.");
    expect(html).not.toContain("Express Dashboard");
  });

  it("renders fresh-write payout preparation as a local recovery state", () => {
    const html = renderToStaticMarkup(<SettlementPayoutDetailRecoveryPage />);

    expect(html).toContain("Preparing payout");
    expect(html).toContain("preparing your payout details");
    expect(html).toContain('href="/account/payouts"');
  });
});
