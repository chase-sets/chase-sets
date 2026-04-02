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
  requested_at: string;
  updated_at: string;
  issued_at: string | null;
  failed_at: string | null;
}>;

type RefundPageRow = Omit<RefundDetailRow, "order_ids"> & Readonly<{
  order_ids: unknown;
}>;

function mapRefundRow(row: RefundPageRow): RefundDetailRow {
  return {
    ...row,
    amount: String(row.amount),
    order_ids: Array.isArray(row.order_ids)
      ? row.order_ids.filter((value): value is string => typeof value === "string")
      : [],
  };
}

export async function getRefund(
  db: PgQueryable,
  refundId: string,
): Promise<RefundDetailRow | null> {
  const result = await db.query<RefundPageRow>(
    `SELECT
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
       requested_at,
       updated_at,
       issued_at,
       failed_at
     FROM payments_refund_pages
     WHERE refund_id = $1`,
    [refundId],
  );

  const row = result.rows[0];
  return row ? mapRefundRow(row) : null;
}
