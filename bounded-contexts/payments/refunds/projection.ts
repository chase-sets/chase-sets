import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildRefundProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "payments.refund-requested": async (event) => {
      const data = event.data as {
        refundId: string;
        paymentId: string;
        orderIds: string[];
        amount: string;
        currencyCode: string;
        reason: string;
        processorName: string;
        requestedAt: string;
      };

      await db.query(
        `INSERT INTO payments_refund_pages (
           refund_id,
           payment_id,
           order_ids,
           amount,
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
           failed_at,
           last_stream_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, NULL, 'requested', 'requested', NULL, NULL, $8, $8, NULL, NULL, $9
         )
         ON CONFLICT (refund_id) DO UPDATE
         SET payment_id = EXCLUDED.payment_id,
             order_ids = EXCLUDED.order_ids,
             amount = EXCLUDED.amount,
             currency_code = EXCLUDED.currency_code,
             reason = EXCLUDED.reason,
             processor_name = EXCLUDED.processor_name,
             processor_status = EXCLUDED.processor_status,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE payments_refund_pages.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.refundId,
          data.paymentId,
          JSON.stringify(data.orderIds),
          data.amount,
          data.currencyCode,
          data.reason,
          data.processorName,
          data.requestedAt,
          event.streamVersion,
        ],
      );
    },
    "payments.refund-issued": async (event) => {
      const data = event.data as {
        refundId: string;
        processorRefundReference: string;
        processorStatus: string;
        issuedAt: string;
      };

      await db.query(
        `UPDATE payments_refund_pages
         SET processor_refund_reference = $2,
             processor_status = $3,
             status = 'issued',
             failure_code = NULL,
             failure_message = NULL,
             issued_at = $4,
             updated_at = $4,
             last_stream_version = $5
         WHERE refund_id = $1
           AND last_stream_version < $5`,
        [
          data.refundId,
          data.processorRefundReference,
          data.processorStatus,
          data.issuedAt,
          event.streamVersion,
        ],
      );
    },
    "payments.refund-failed": async (event) => {
      const data = event.data as {
        refundId: string;
        processorStatus: string;
        failureCode: string | null;
        failureMessage: string | null;
        failedAt: string;
      };

      await db.query(
        `UPDATE payments_refund_pages
         SET processor_status = $2,
             status = 'failed',
             failure_code = $3,
             failure_message = $4,
             failed_at = $5,
             updated_at = $5,
             last_stream_version = $6
         WHERE refund_id = $1
           AND last_stream_version < $6`,
        [
          data.refundId,
          data.processorStatus,
          data.failureCode,
          data.failureMessage,
          data.failedAt,
          event.streamVersion,
        ],
      );
    },
  };
}
