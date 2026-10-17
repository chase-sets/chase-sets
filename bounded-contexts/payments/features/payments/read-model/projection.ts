import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildPaymentProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "payments.payment-created": async (event) => {
      const data = event.data as {
        paymentId: string;
        buyerAccountId: string;
        orderIds: string[];
        orderRefundCaps?: unknown;
        amount: string;
        balanceCreditAmount: string;
        processorAmount: string;
        marketplaceSalesFeeAmount: string;
        marketplaceCheckoutFeeAmount: string;
        marketplaceCheckoutFeePolicyVersion?: string | null;
        marketplaceCheckoutFeeQuoteFingerprint?: string | null;
        paymentMethodCategory?: string | null;
        savedCheckoutInstrumentId?: string | null;
        sellerNetAmount: string;
        sellerPayoutAmount?: string;
        sellerPayouts?: unknown;
        currencyCode: string;
        processorName: string;
        processorPaymentKind?: string | null;
        processorPaymentReference: string;
        processorClientSecret: string | null;
        processorRedirectUrl?: string | null;
        processorStatus: string;
        threeDSecureRequest?: string | null;
        threeDSecureReasonCodes?: unknown;
        sourceContext: string | null;
        sourceReferenceId: string | null;
        createdAt: string;
      };

      await db.query(
        `WITH source_conflict AS (
         SELECT payment_id
         FROM payments_payment_pages
         WHERE $26::text IS NOT NULL
           AND $27::text IS NOT NULL
           AND source_context = $26
           AND source_reference_id = $27
           AND payment_id <> $1
         ORDER BY created_at ASC, payment_id ASC
         LIMIT 1
       ),
       upserted_payment AS (
         INSERT INTO payments_payment_pages (
           payment_id,
           buyer_account_id,
           order_ids,
           order_refund_caps,
           amount,
           balance_credit_amount,
           processor_amount,
           marketplace_sales_fee_amount,
           marketplace_checkout_fee_amount,
           marketplace_checkout_fee_policy_version,
           marketplace_checkout_fee_quote_fingerprint,
           payment_method_category,
           saved_checkout_instrument_id,
           seller_net_amount,
           seller_payout_amount,
           seller_payouts,
           currency_code,
           processor_name,
           processor_payment_kind,
           processor_payment_reference,
           processor_client_secret,
           processor_redirect_url,
           processor_status,
           three_d_secure_request,
           three_d_secure_reason_codes,
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
           refunded_at,
           refunded_amount,
           order_refunded_amounts,
           disputed_at,
           last_stream_version
         )
         SELECT
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, 'pending-confirmation', NULL, NULL, $28, $28, NULL, NULL, NULL, NULL, 0, '[]'::jsonb, NULL, $29
         WHERE NOT EXISTS (SELECT 1 FROM source_conflict)
         ON CONFLICT (payment_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             order_ids = EXCLUDED.order_ids,
             order_refund_caps = EXCLUDED.order_refund_caps,
             amount = EXCLUDED.amount,
             balance_credit_amount = EXCLUDED.balance_credit_amount,
             processor_amount = EXCLUDED.processor_amount,
             marketplace_sales_fee_amount = EXCLUDED.marketplace_sales_fee_amount,
             marketplace_checkout_fee_amount = EXCLUDED.marketplace_checkout_fee_amount,
             marketplace_checkout_fee_policy_version = EXCLUDED.marketplace_checkout_fee_policy_version,
             marketplace_checkout_fee_quote_fingerprint = EXCLUDED.marketplace_checkout_fee_quote_fingerprint,
             payment_method_category = EXCLUDED.payment_method_category,
             saved_checkout_instrument_id = EXCLUDED.saved_checkout_instrument_id,
             seller_net_amount = EXCLUDED.seller_net_amount,
             seller_payout_amount = EXCLUDED.seller_payout_amount,
             seller_payouts = EXCLUDED.seller_payouts,
             currency_code = EXCLUDED.currency_code,
             processor_name = EXCLUDED.processor_name,
             processor_payment_kind = EXCLUDED.processor_payment_kind,
             processor_payment_reference = EXCLUDED.processor_payment_reference,
             processor_client_secret = EXCLUDED.processor_client_secret,
             processor_redirect_url = EXCLUDED.processor_redirect_url,
             processor_status = EXCLUDED.processor_status,
             three_d_secure_request = EXCLUDED.three_d_secure_request,
             three_d_secure_reason_codes = EXCLUDED.three_d_secure_reason_codes,
             source_context = EXCLUDED.source_context,
             source_reference_id = EXCLUDED.source_reference_id,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE payments_payment_pages.last_stream_version < EXCLUDED.last_stream_version
         RETURNING payment_id
       ),
       deleted_payment_orders AS (
         DELETE FROM payments_payment_orders
         WHERE payment_id IN (SELECT payment_id FROM upserted_payment)
         RETURNING payment_id
       )
       INSERT INTO payments_payment_orders (payment_id, order_id)
       SELECT upserted_payment.payment_id, payment_order_ids.order_id
       FROM upserted_payment
       CROSS JOIN (SELECT COUNT(*) FROM deleted_payment_orders) AS deleted_order_count
       CROSS JOIN LATERAL jsonb_array_elements_text($3::jsonb) AS payment_order_ids(order_id)
       ON CONFLICT (payment_id, order_id) DO NOTHING`,
        [
          data.paymentId,
          data.buyerAccountId,
          JSON.stringify(data.orderIds),
          JSON.stringify(Array.isArray(data.orderRefundCaps) ? data.orderRefundCaps : []),
          data.amount,
          data.balanceCreditAmount,
          data.processorAmount,
          data.marketplaceSalesFeeAmount,
          data.marketplaceCheckoutFeeAmount,
          data.marketplaceCheckoutFeePolicyVersion ?? null,
          data.marketplaceCheckoutFeeQuoteFingerprint ?? null,
          data.paymentMethodCategory ?? null,
          data.savedCheckoutInstrumentId ?? null,
          data.sellerNetAmount,
          data.sellerPayoutAmount ?? data.sellerNetAmount,
          JSON.stringify(Array.isArray(data.sellerPayouts) ? data.sellerPayouts : []),
          data.currencyCode,
          data.processorName,
          data.processorPaymentKind ?? "payment-intent",
          data.processorPaymentReference,
          data.processorClientSecret,
          data.processorRedirectUrl ?? null,
          data.processorStatus,
          data.threeDSecureRequest ?? null,
          JSON.stringify(Array.isArray(data.threeDSecureReasonCodes) ? data.threeDSecureReasonCodes : []),
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
    ...defineProjectorHandlers<Pick<ChaseSetsEventPayloads, "payments.payment-refunded">>({
      "payments.payment-refunded": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE payments_payment_pages
         SET processor_status = $2,
             status = CASE WHEN amount = $4::numeric THEN 'refunded' ELSE 'partially-refunded' END,
             failure_code = NULL,
             failure_message = NULL,
             refunded_at = $3,
             refunded_amount = $4,
             order_refunded_amounts = $5,
             updated_at = $3,
             last_stream_version = $6
         WHERE payment_id = $1
           AND last_stream_version < $6`,
          [
            data.paymentId,
            data.processorStatus,
            data.refundedAt,
            data.refundedAmount,
            JSON.stringify(Array.isArray(data.refundedOrderAmounts) ? data.refundedOrderAmounts : []),
            event.streamVersion,
          ],
        );
      },
    }),
    "payments.payment-disputed": async (event) => {
      const data = event.data as {
        paymentId: string;
        processorStatus: string;
        disputeStatus: string | null;
        disputeMessage: string | null;
        disputedAt: string;
      };

      await db.query(
        `UPDATE payments_payment_pages
         SET processor_status = $2,
             status = 'disputed',
             failure_code = $3,
             failure_message = $4,
             disputed_at = $5,
             updated_at = $5,
             last_stream_version = $6
         WHERE payment_id = $1
           AND last_stream_version < $6`,
        [
          data.paymentId,
          data.processorStatus,
          data.disputeStatus,
          data.disputeMessage,
          data.disputedAt,
          event.streamVersion,
        ],
      );
    },
    "payments.payment-liability-shift-recorded": async (event) => {
      const data = event.data as {
        paymentId: string;
        status: string;
        authenticationResult: string | null;
        radarRiskLevel: string | null;
        recordedAt: string;
      };

      await db.query(
        `UPDATE payments_payment_pages
         SET liability_shift_status = $2,
             liability_shift_authentication_result = $3,
             liability_shift_radar_risk_level = $4,
             liability_shift_recorded_at = $5,
             updated_at = $5,
             last_stream_version = $6
         WHERE payment_id = $1
           AND last_stream_version < $6`,
        [
          data.paymentId,
          data.status,
          data.authenticationResult,
          data.radarRiskLevel,
          data.recordedAt,
          event.streamVersion,
        ],
      );
    },
  };
}
