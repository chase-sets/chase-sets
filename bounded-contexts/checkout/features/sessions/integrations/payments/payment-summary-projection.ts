import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type PaymentCreatedPayload = Readonly<{
  paymentId: string;
  buyerAccountId: string;
  orderIds: readonly string[];
  amount: string;
  currencyCode: string;
  createdAt: string;
}>;

type PaymentStatusPayload = Readonly<{
  paymentId: string;
  capturedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  refundedAt?: string;
  disputedAt?: string;
}>;

function timestampForStatus(data: PaymentStatusPayload) {
  return data.capturedAt ?? data.failedAt ?? data.cancelledAt ?? data.refundedAt ?? data.disputedAt ?? null;
}

async function updatePaymentStatus(
  db: PgQueryable,
  event: Readonly<{ streamVersion: number; data: unknown }>,
  status: string,
) {
  const data = event.data as PaymentStatusPayload;
  const updatedAt = timestampForStatus(data);
  if (!updatedAt) {
    return;
  }

  await db.query(
    `UPDATE checkout_payment_summary_pages
        SET status = $2,
            updated_at = $3,
            last_stream_version = $4
      WHERE payment_id = $1
        AND last_stream_version < $4`,
    [data.paymentId, status, updatedAt, event.streamVersion],
  );
}

export function buildCheckoutPaymentSummaryProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "payments.payment-created": async (event) => {
      const data = event.data as PaymentCreatedPayload;

      await db.query(
        `INSERT INTO checkout_payment_summary_pages (
           payment_id,
           buyer_account_id,
           order_ids,
           amount,
           currency_code,
           status,
           created_at,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, 'pending-confirmation', $6, $6, $7)
         ON CONFLICT (payment_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             order_ids = EXCLUDED.order_ids,
             amount = EXCLUDED.amount,
             currency_code = EXCLUDED.currency_code,
             status = EXCLUDED.status,
             created_at = EXCLUDED.created_at,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE checkout_payment_summary_pages.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.paymentId,
          data.buyerAccountId,
          JSON.stringify(data.orderIds),
          data.amount,
          data.currencyCode,
          data.createdAt,
          event.streamVersion,
        ],
      );
    },
    "payments.payment-captured": (event) => updatePaymentStatus(db, event, "captured"),
    "payments.payment-failed": (event) => updatePaymentStatus(db, event, "failed"),
    "payments.payment-cancelled": (event) => updatePaymentStatus(db, event, "cancelled"),
    "payments.payment-refunded": (event) => updatePaymentStatus(db, event, "refunded"),
    "payments.payment-disputed": (event) => updatePaymentStatus(db, event, "disputed"),
  };
}
