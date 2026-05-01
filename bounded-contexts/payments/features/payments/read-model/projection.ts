import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildPaymentProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "payments.payment-created": async (event) => {
      const data = event.data as {
        paymentId: string;
        buyerAccountId: string;
        orderIds: string[];
        amount: string;
        balanceCreditAmount: string;
        processorAmount: string;
        marketplaceFeeAmount: string;
        paymentFeeAmount: string;
        sellerNetAmount: string;
        currencyCode: string;
        processorName: string;
        processorPaymentKind?: string | null;
        processorPaymentReference: string;
        processorClientSecret: string | null;
        processorStatus: string;
        sourceContext: string | null;
        sourceReferenceId: string | null;
        createdAt: string;
      };

      await db.query(
        `INSERT INTO payments_payment_pages (
           payment_id,
           buyer_account_id,
           order_ids,
           amount,
           balance_credit_amount,
           processor_amount,
           marketplace_fee_amount,
           payment_fee_amount,
           seller_net_amount,
           currency_code,
           processor_name,
           processor_payment_kind,
           processor_payment_reference,
           processor_client_secret,
           processor_status,
           source_context,
           source_reference_id,
           status,
           failure_code,
           failure_message,
           created_at,
           updated_at,
           captured_at,
           failed_at,
           cancelled_at,
           last_stream_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pending-confirmation', NULL, NULL, $18, $18, NULL, NULL, NULL, $19
         )
         ON CONFLICT (payment_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             order_ids = EXCLUDED.order_ids,
             amount = EXCLUDED.amount,
             balance_credit_amount = EXCLUDED.balance_credit_amount,
             processor_amount = EXCLUDED.processor_amount,
             marketplace_fee_amount = EXCLUDED.marketplace_fee_amount,
             payment_fee_amount = EXCLUDED.payment_fee_amount,
             seller_net_amount = EXCLUDED.seller_net_amount,
             currency_code = EXCLUDED.currency_code,
             processor_name = EXCLUDED.processor_name,
             processor_payment_kind = EXCLUDED.processor_payment_kind,
             processor_payment_reference = EXCLUDED.processor_payment_reference,
             processor_client_secret = EXCLUDED.processor_client_secret,
             processor_status = EXCLUDED.processor_status,
             source_context = EXCLUDED.source_context,
             source_reference_id = EXCLUDED.source_reference_id,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE payments_payment_pages.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.paymentId,
          data.buyerAccountId,
          JSON.stringify(data.orderIds),
          data.amount,
          data.balanceCreditAmount,
          data.processorAmount,
          data.marketplaceFeeAmount,
          data.paymentFeeAmount,
          data.sellerNetAmount,
          data.currencyCode,
          data.processorName,
          data.processorPaymentKind ?? "payment-intent",
          data.processorPaymentReference,
          data.processorClientSecret,
          data.processorStatus,
          data.sourceContext,
          data.sourceReferenceId,
          data.createdAt,
          event.streamVersion,
        ],
      );
    },
    "payments.payment-authorized": async (event) => {
      const data = event.data as {
        paymentId: string;
        processorStatus: string;
        authorizedAt: string;
      };

      await db.query(
        `UPDATE payments_payment_pages
         SET processor_status = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE payment_id = $1
           AND last_stream_version < $4`,
        [data.paymentId, data.processorStatus, data.authorizedAt, event.streamVersion],
      );
    },
    "payments.payment-captured": async (event) => {
      const data = event.data as {
        paymentId: string;
        processorStatus: string;
        capturedAt: string;
      };

      await db.query(
        `UPDATE payments_payment_pages
         SET processor_status = $2,
             status = 'captured',
             failure_code = NULL,
             failure_message = NULL,
             captured_at = $3,
             updated_at = $3,
             last_stream_version = $4
         WHERE payment_id = $1
           AND last_stream_version < $4`,
        [data.paymentId, data.processorStatus, data.capturedAt, event.streamVersion],
      );
    },
    "payments.payment-failed": async (event) => {
      const data = event.data as {
        paymentId: string;
        processorStatus: string;
        failureCode: string | null;
        failureMessage: string | null;
        failedAt: string;
      };

      await db.query(
        `UPDATE payments_payment_pages
         SET processor_status = $2,
             status = 'failed',
             failure_code = $3,
             failure_message = $4,
             failed_at = $5,
             updated_at = $5,
             last_stream_version = $6
         WHERE payment_id = $1
           AND last_stream_version < $6`,
        [
          data.paymentId,
          data.processorStatus,
          data.failureCode,
          data.failureMessage,
          data.failedAt,
          event.streamVersion,
        ],
      );
    },
    "payments.payment-cancelled": async (event) => {
      const data = event.data as {
        paymentId: string;
        cancelledAt: string;
      };

      await db.query(
        `UPDATE payments_payment_pages
         SET status = 'cancelled',
             cancelled_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE payment_id = $1
           AND last_stream_version < $3`,
        [data.paymentId, data.cancelledAt, event.streamVersion],
      );
    },
  };
}
