import type { SettlementPayoutRow } from "./queries";

export const STALE_RECONCILIATION_AFTER_MINUTES = 30;
export const STALE_RECONCILIATION_AFTER_MS = STALE_RECONCILIATION_AFTER_MINUTES * 60 * 1_000;

export type PayoutOperationsState = "retry-queued" | "needs-provider-reference" | "ready-to-reconcile" | "review";

export type PayoutOperationsSeverity = "critical" | "warning" | "normal";

export type PayoutOperationsAttention = Readonly<{
  failed: number;
  missing_provider_reference: number;
  retry_queued: number;
  stale_reconciliation: number;
  stale_reconciliation_after_minutes: typeof STALE_RECONCILIATION_AFTER_MINUTES;
  stale_requested_after_minutes: 15;
  basis: "returned-items";
}>;

export type PayoutOperationsRow = SettlementPayoutRow &
  Readonly<{
    operations_state: PayoutOperationsState;
    operations_severity: PayoutOperationsSeverity;
  }>;

function isStaleReconciliation(row: SettlementPayoutRow, now: number) {
  if (!row.last_reconciled_at) {
    return row.status !== "requested";
  }

  const reconciledAt = Date.parse(row.last_reconciled_at);
  return Number.isFinite(reconciledAt) && now - reconciledAt > STALE_RECONCILIATION_AFTER_MS;
}

export function derivePayoutOperationsRow(row: SettlementPayoutRow, evaluatedAt: string): PayoutOperationsRow {
  const now = Date.parse(evaluatedAt);
  const retryQueued = row.status === "failed" && Boolean(row.next_retry_at);
  const missingProviderReference = !row.provider_payout_reference;

  const operationsState: PayoutOperationsState = retryQueued
    ? "retry-queued"
    : missingProviderReference
      ? "needs-provider-reference"
      : row.status === "in-transit"
        ? "ready-to-reconcile"
        : "review";
  const operationsSeverity: PayoutOperationsSeverity =
    row.status === "failed" ? "critical" : missingProviderReference ? "warning" : "normal";

  return {
    ...row,
    operations_state: operationsState,
    operations_severity: operationsSeverity,
  };
}

export function buildPayoutOperationsResponse(
  rows: readonly SettlementPayoutRow[],
  evaluatedAt: string,
): Readonly<{
  items: readonly PayoutOperationsRow[];
  attention: PayoutOperationsAttention;
}> {
  const now = Date.parse(evaluatedAt);
  const items = rows.map((row) => derivePayoutOperationsRow(row, evaluatedAt));

  return {
    items,
    attention: {
      failed: rows.filter((row) => row.status === "failed").length,
      missing_provider_reference: rows.filter((row) => !row.provider_payout_reference).length,
      retry_queued: rows.filter((row) => Boolean(row.next_retry_at)).length,
      stale_reconciliation: rows.filter((row) => isStaleReconciliation(row, now)).length,
      stale_reconciliation_after_minutes: STALE_RECONCILIATION_AFTER_MINUTES,
      stale_requested_after_minutes: 15,
      basis: "returned-items",
    },
  };
}
