import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type RefundDetailRow = Readonly<{
  refund_id: string;
  payment_id: string;
  order_ids: readonly string[];
  amount: string;
  currency_code: string;
  reason: string;
  processor_name: string;
  processor_refund_reference: string | null;
  processor_status: string;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  remedy_id: string | null;
  coverage_id: string | null;
  liability_funding_kind: string | null;
  seller_funded_amount: string | null;
  platform_funded_amount: string | null;
  refund_trigger: string | null;
  reason_code: string | null;
  requested_at: string;
  updated_at: string;
  issued_at: string | null;
  failed_at: string | null;
}>;

type RefundPageRow = Omit<RefundDetailRow, "order_ids"> &
  Readonly<{
    order_ids: unknown;
  }>;

function mapRefundRow(row: RefundPageRow): RefundDetailRow {
  return {
    ...row,
    amount: String(row.amount),
    seller_funded_amount: row.seller_funded_amount === null ? null : String(row.seller_funded_amount),
    platform_funded_amount: row.platform_funded_amount === null ? null : String(row.platform_funded_amount),
    order_ids: Array.isArray(row.order_ids)
      ? row.order_ids.filter((value): value is string => typeof value === "string")
      : [],
  };
}

const refundColumns = `
       refund_id,
       payment_id,
       order_ids,
       amount::text AS amount,
       currency_code,
       reason,
       processor_name,
       processor_refund_reference,
       processor_status,
       status,
       failure_code,
       failure_message,
       remedy_id,
       coverage_id,
       liability_funding_kind,
       seller_funded_amount::text AS seller_funded_amount,
       platform_funded_amount::text AS platform_funded_amount,
       refund_trigger,
       reason_code,
       requested_at,
       updated_at,
       issued_at,
       failed_at`;

export async function getRefund(db: PgQueryable, refundId: string): Promise<RefundDetailRow | null> {
  const result = await db.query<RefundPageRow>(
    `SELECT${refundColumns}
     FROM payments_refund_pages
     WHERE refund_id = $1`,
    [refundId],
  );

  const row = result.rows[0];
  return row ? mapRefundRow(row) : null;
}

export async function listRefundsForOrder(db: PgQueryable, orderId: string): Promise<readonly RefundDetailRow[]> {
  const result = await db.query<RefundPageRow>(
    `SELECT${refundColumns}
     FROM payments_refund_pages
     WHERE order_ids ? $1
     ORDER BY requested_at ASC, refund_id ASC`,
    [orderId],
  );

  return result.rows.map(mapRefundRow);
}

/**
 * Operational query: refunds stuck between authorization and confirmation. A refund
 * that is still `requested` (provider submitted, no issued/failed confirmation) past
 * a staleness threshold has not converged and needs attention. Ordered oldest-first
 * so the longest-stuck refunds surface at the top; causation columns let an operator
 * see the owning remedy and allocation without joining another context.
 */
export async function getStuckRefunds(
  db: PgQueryable,
  params: Readonly<{ stuckBefore: string; limit?: number }>,
): Promise<readonly RefundDetailRow[]> {
  const result = await db.query<RefundPageRow>(
    `SELECT${refundColumns}
     FROM payments_refund_pages
     WHERE status NOT IN ('issued', 'failed')
       AND updated_at < $1
     ORDER BY updated_at ASC, refund_id ASC
     LIMIT $2`,
    [params.stuckBefore, params.limit ?? 100],
  );

  return result.rows.map(mapRefundRow);
}
