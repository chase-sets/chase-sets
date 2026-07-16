import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createTransientProjectionError } from "@chase-sets/event-core/projector";

/**
 * How many times a refund effect is re-attempted before it is parked for an
 * operator. Bounds automatic retries so a permanently-failing refund cannot
 * block its subscription forever, while still surviving a transient processor
 * outage that recovers within the window.
 */
export const MAX_REFUND_EFFECT_ATTEMPTS = 24;

type RefundEffectTable = "payments_order_cancellation_refund_effects" | "payments_support_refund_effects";
type RefundEffectKeyColumn = "order_id" | "support_request_id";

/**
 * Records a failed refund attempt on an effect row and decides whether to keep
 * retrying. Increments the attempt counter; while under the bound the row stays
 * `failed` (re-claimable on redelivery) and a transient projection error is
 * thrown so the runner redelivers the event and re-attempts the same, idempotent
 * refund id. Once the bound is reached the row is parked in `manual-review` for
 * an operator and the handler returns without throwing so the projection keeps
 * making progress instead of blocking behind a permanently-failing refund.
 */
export async function recordRefundEffectFailure(
  db: PgQueryable,
  params: Readonly<{
    table: RefundEffectTable;
    keyColumn: RefundEffectKeyColumn;
    keyValue: string;
    failureMessage: string;
    now: string;
  }>,
): Promise<void> {
  const result = await db.query<{ status: string }>(
    `UPDATE ${params.table}
     SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= $2 THEN 'manual-review' ELSE 'failed' END,
         failure_message = $3,
         updated_at = $4
     WHERE ${params.keyColumn} = $1
       AND status = 'processing'
     RETURNING status`,
    [params.keyValue, MAX_REFUND_EFFECT_ATTEMPTS, params.failureMessage, params.now],
  );
  const row = result.rows[0];
  if (!row) {
    // The row was already advanced by another delivery; nothing left to retry.
    return;
  }
  if (row.status !== "manual-review") {
    throw createTransientProjectionError(
      `Refund effect ${params.keyValue} failed at the payment processor and will be retried: ${params.failureMessage}`,
    );
  }
}
