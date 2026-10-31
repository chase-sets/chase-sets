import { describe, expect, it } from "vitest";
import { buildPayoutOperationsResponse, derivePayoutOperationsRow } from "./payout-operations";
import type { SettlementPayoutRow } from "./queries";

const evaluatedAt = "2026-06-01T15:00:00.000Z";

function payout(overrides: Partial<SettlementPayoutRow> = {}): SettlementPayoutRow {
  return {
    payout_id: "pyo_test",
    account_id: "acc_test",
    amount: "10.00",
    requested_amount: "10.00",
    fee_amount: "0.00",
    net_amount: "10.00",
    currency_code: "usd",
    destination_reference: null,
    note: null,
    display_reference: "PYO-TEST",
    status: "in-transit",
    provider_transfer_reference: "tr_test",
    provider_payout_reference: "po_test",
    provider_status: "pending",
    provider_failure_code: null,
    provider_failure_message: null,
    requested_at: "2026-06-01T14:00:00.000Z",
    updated_at: "2026-06-01T14:00:00.000Z",
    sent_at: "2026-06-01T14:00:00.000Z",
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    last_provider_event_at: null,
    last_reconciled_at: "2026-06-01T14:00:00.000Z",
    retry_count: 0,
    next_retry_at: null,
    retry_reason: null,
    ...overrides,
  };
}

describe("payout operations read", () => {
  it("uses the documented state precedence and independent severity", () => {
    expect(
      derivePayoutOperationsRow(
        payout({ status: "failed", next_retry_at: evaluatedAt, provider_payout_reference: null }),
        evaluatedAt,
      ),
    ).toMatchObject({ operations_state: "retry-queued", operations_severity: "critical" });
    expect(derivePayoutOperationsRow(payout({ provider_payout_reference: null }), evaluatedAt)).toMatchObject({
      operations_state: "needs-provider-reference",
      operations_severity: "warning",
    });
    expect(derivePayoutOperationsRow(payout({ status: "in-transit" }), evaluatedAt)).toMatchObject({
      operations_state: "ready-to-reconcile",
      operations_severity: "normal",
    });
  });

  it.each([
    ["exactly 30 minutes", "2026-06-01T14:30:00.000Z", false],
    ["30 minutes plus 1 ms", "2026-06-01T14:29:59.999Z", true],
  ])("marks reconciliation stale only after the strict boundary: %s", (_name, lastReconciledAt, stale) => {
    const response = buildPayoutOperationsResponse([payout({ last_reconciled_at: lastReconciledAt })], evaluatedAt);
    expect(response.attention.stale_reconciliation).toBe(stale ? 1 : 0);
  });

  it("counts returned items and preserves the cap-negative contract", () => {
    const response = buildPayoutOperationsResponse(
      [
        payout({ status: "failed", provider_payout_reference: null, next_retry_at: evaluatedAt }),
        payout({ payout_id: "pyo_requested", status: "requested", last_reconciled_at: null }),
      ],
      evaluatedAt,
    );
    expect(response.attention).toEqual({
      failed: 1,
      missing_provider_reference: 1,
      retry_queued: 1,
      stale_reconciliation: 1,
      stale_reconciliation_after_minutes: 30,
      stale_requested_after_minutes: 15,
      basis: "returned-items",
    });
    expect(response.items).toHaveLength(2);
  });
});
