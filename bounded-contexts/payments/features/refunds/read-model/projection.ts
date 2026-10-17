import type {
  ChaseSetsEventPayloads,
  PaymentRefundCausationPayload,
} from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type RefundCausationColumns = Readonly<{
  remedyId: string | null;
  coverageId: string | null;
  fundingKind: string | null;
  sellerFundedAmount: string | null;
  platformFundedAmount: string | null;
  refundTrigger: string | null;
  reasonCode: string | null;
}>;

/** Flattens the optional causation payload into read-model columns; all null for a legacy seller-funded refund with no causation. */
function causationColumns(causation: PaymentRefundCausationPayload | null | undefined): RefundCausationColumns {
  return {
    remedyId: causation?.remedyId ?? null,
    coverageId: causation?.coverageId ?? null,
    fundingKind: causation?.allocation?.fundingKind ?? null,
    sellerFundedAmount: causation?.allocation?.sellerFundedAmount ?? null,
    platformFundedAmount: causation?.allocation?.platformFundedAmount ?? null,
    refundTrigger: causation?.refundTrigger ?? null,
    reasonCode: causation?.reasonCode ?? null,
  };
}

export function buildRefundProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return defineProjectorHandlers<
    Pick<ChaseSetsEventPayloads, "payments.refund-requested" | "payments.refund-issued" | "payments.refund-failed">
  >({
    "payments.refund-requested": async (event) => {
      const { data } = event;
      const causation = causationColumns(data.causation);

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
           remedy_id,
           coverage_id,
           liability_funding_kind,
           seller_funded_amount,
           platform_funded_amount,
           refund_trigger,
           reason_code,
           requested_at,
           updated_at,
           issued_at,
           failed_at,
           last_stream_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, NULL, 'requested', 'requested', NULL, NULL,
           $8, $9, $10, $11, $12, $13, $14, $15, $15, NULL, NULL, $16
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
             remedy_id = EXCLUDED.remedy_id,
             coverage_id = EXCLUDED.coverage_id,
             liability_funding_kind = EXCLUDED.liability_funding_kind,
             seller_funded_amount = EXCLUDED.seller_funded_amount,
             platform_funded_amount = EXCLUDED.platform_funded_amount,
             refund_trigger = EXCLUDED.refund_trigger,
             reason_code = EXCLUDED.reason_code,
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
          causation.remedyId,
          causation.coverageId,
          causation.fundingKind,
          causation.sellerFundedAmount,
          causation.platformFundedAmount,
          causation.refundTrigger,
          causation.reasonCode,
          data.requestedAt,
          event.streamVersion,
        ],
      );
    },
    "payments.refund-issued": async (event) => {
      const { data } = event;

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
        [data.refundId, data.processorRefundReference, data.processorStatus, data.issuedAt, event.streamVersion],
      );
    },
    "payments.refund-failed": async (event) => {
      const { data } = event;

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
  });
}
