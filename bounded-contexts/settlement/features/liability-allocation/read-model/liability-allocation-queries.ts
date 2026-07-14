import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Operator/metrics read queries for the liability-allocation slice. The repair queue
 * surfaces every quarantined refund (fail-closed states awaiting operator action); the
 * metrics reconcile provider refund totals to the seller-funded plus platform-funded
 * postings Settlement recorded, so a drift between what the provider refunded and what
 * Settlement allocated is countable rather than silent.
 */

export type RefundLiabilityRepairRow = Readonly<{
  refund_id: string;
  payment_id: string | null;
  remedy_id: string;
  coverage_id: string | null;
  currency_code: string;
  seller_funded_amount: string;
  platform_funded_amount: string;
  funding_kind: string;
  completed_refund_amount: string | null;
  quarantine_reason: string | null;
  quarantine_detail: string | null;
  updated_at: string;
}>;

export async function listRefundLiabilityRepairQueue(
  db: PgQueryable,
  params: Readonly<{ limit?: number; offset?: number }> = {},
): Promise<RefundLiabilityRepairRow[]> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  const result = await db.query<RefundLiabilityRepairRow>(
    `SELECT refund_id, payment_id, remedy_id, coverage_id, currency_code,
            seller_funded_amount::text AS seller_funded_amount,
            platform_funded_amount::text AS platform_funded_amount,
            funding_kind,
            completed_refund_amount::text AS completed_refund_amount,
            quarantine_reason, quarantine_detail, updated_at
     FROM settlement_refund_liability_allocations
     WHERE reconciliation_status = 'quarantined'
     ORDER BY updated_at DESC, refund_id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

export type RefundLiabilityMetrics = Readonly<{
  authorized: number;
  reconciled: number;
  quarantined: number;
  /** Total completed refund amount across reconciled rows (should equal seller + platform postings). */
  reconciledRefundTotal: string;
  sellerPostedTotal: string;
  platformSettledTotal: string;
  /** reconciledRefundTotal − (sellerPostedTotal + platformSettledTotal); non-zero means drift. */
  reconciliationDrift: string;
}>;

export async function getRefundLiabilityMetrics(db: PgQueryable): Promise<RefundLiabilityMetrics> {
  const result = await db.query<{
    authorized: string;
    reconciled: string;
    quarantined: string;
    reconciled_refund_total: string;
    seller_posted_total: string;
    platform_settled_total: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE reconciliation_status = 'authorized')::text AS authorized,
       COUNT(*) FILTER (WHERE reconciliation_status = 'reconciled')::text AS reconciled,
       COUNT(*) FILTER (WHERE reconciliation_status = 'quarantined')::text AS quarantined,
       COALESCE(SUM(completed_refund_amount) FILTER (WHERE reconciliation_status = 'reconciled'), 0)::text AS reconciled_refund_total,
       COALESCE(SUM(seller_posted_amount) FILTER (WHERE reconciliation_status = 'reconciled'), 0)::text AS seller_posted_total,
       COALESCE(SUM(platform_settled_amount) FILTER (WHERE reconciliation_status = 'reconciled'), 0)::text AS platform_settled_total
     FROM settlement_refund_liability_allocations`,
  );
  const row = result.rows[0] ?? {
    authorized: "0",
    reconciled: "0",
    quarantined: "0",
    reconciled_refund_total: "0.00",
    seller_posted_total: "0.00",
    platform_settled_total: "0.00",
  };
  const reconciledRefundCents = Math.round(Number(row.reconciled_refund_total) * 100);
  const postedCents =
    Math.round(Number(row.seller_posted_total) * 100) + Math.round(Number(row.platform_settled_total) * 100);
  return {
    authorized: Number(row.authorized),
    reconciled: Number(row.reconciled),
    quarantined: Number(row.quarantined),
    reconciledRefundTotal: row.reconciled_refund_total,
    sellerPostedTotal: row.seller_posted_total,
    platformSettledTotal: row.platform_settled_total,
    reconciliationDrift: ((reconciledRefundCents - postedCents) / 100).toFixed(2),
  };
}
