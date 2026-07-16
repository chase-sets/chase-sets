import { describe, expect, it } from "vitest";
import type { SettlementPayoutRow } from "../../payouts/read-model/queries";
import { estimatedPayoutArrivalAt, selectNextPayout } from "./dashboard-model";

function payout(overrides: Partial<SettlementPayoutRow> = {}): SettlementPayoutRow {
  return {
    payout_id: "pay-1",
    account_id: "acct-1",
    amount: "80.00",
    currency_code: "usd",
    destination_reference: null,
    note: null,
    display_reference: "PYO-PAY1",
    status: "in-transit",
    provider_transfer_reference: null,
    provider_payout_reference: "provider-payout",
    provider_status: null,
    provider_failure_code: null,
    provider_failure_message: null,
    requested_at: "2026-07-16T12:00:00.000Z",
    updated_at: "2026-07-16T12:00:00.000Z",
    sent_at: "2026-07-17T12:00:00.000Z",
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    last_provider_event_at: null,
    last_reconciled_at: null,
    retry_count: 0,
    next_retry_at: null,
    retry_reason: null,
    ...overrides,
  };
}

describe("money dashboard model", () => {
  it("estimates arrival three business days after submission", () => {
    expect(estimatedPayoutArrivalAt(payout())).toBe("2026-07-22T12:00:00.000Z");
  });

  it("selects the active payout with the earliest estimated arrival", () => {
    const next = selectNextPayout([
      payout({ payout_id: "later", amount: "90.00", sent_at: "2026-07-20T12:00:00.000Z" }),
      payout({ payout_id: "next", amount: "40.00", sent_at: "2026-07-16T12:00:00.000Z" }),
      payout({ payout_id: "paid", status: "completed", completed_at: "2026-07-15T12:00:00.000Z" }),
    ]);

    expect(next).toEqual({
      payoutId: "next",
      amount: "40.00",
      currencyCode: "usd",
      estimatedArrivalAt: "2026-07-21T12:00:00.000Z",
    });
  });
});
