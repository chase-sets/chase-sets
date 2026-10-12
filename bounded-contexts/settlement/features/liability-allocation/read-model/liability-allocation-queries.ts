import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Operator/metrics read queries for the liability-allocation slice. The repair queue
 * surfaces every quarantined refund (fail-closed states awaiting operator action).
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
