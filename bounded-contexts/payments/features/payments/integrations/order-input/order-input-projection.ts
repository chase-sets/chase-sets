import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildPaymentsOrderInputProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as {
        orderId: string;
        buyerAccountId: string;
        totalAmount: string;
        commercialTermsSnapshot: {
          marketplaceFeeAmount: string;
          sellerNetAmount: string;
          termsScheduleId: string | null;
          termsAgreementId: string | null;
          termsResolvedAt: string;
        };
      };

      await db.query(
        `INSERT INTO payments_order_inputs (
           order_id,
           buyer_account_id,
           total_amount,
           marketplace_fee_amount,
           payment_fee_amount,
           seller_net_amount,
           terms_schedule_id,
           terms_agreement_id,
           terms_resolved_at,
           status,
           created_at,
           updated_at,
           cancelled_at,
           ready_for_fulfillment_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending-reservation', $10, $10, NULL, NULL)
         ON CONFLICT (order_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             total_amount = EXCLUDED.total_amount,
             marketplace_fee_amount = EXCLUDED.marketplace_fee_amount,
             payment_fee_amount = EXCLUDED.payment_fee_amount,
             seller_net_amount = EXCLUDED.seller_net_amount,
             terms_schedule_id = EXCLUDED.terms_schedule_id,
             terms_agreement_id = EXCLUDED.terms_agreement_id,
             terms_resolved_at = EXCLUDED.terms_resolved_at,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at,
             cancelled_at = EXCLUDED.cancelled_at,
             ready_for_fulfillment_at = EXCLUDED.ready_for_fulfillment_at`,
        [
          data.orderId,
          data.buyerAccountId,
          data.totalAmount,
          data.commercialTermsSnapshot.marketplaceFeeAmount,
          "0.00",
          data.commercialTermsSnapshot.sellerNetAmount,
          data.commercialTermsSnapshot.termsScheduleId,
          data.commercialTermsSnapshot.termsAgreementId,
          data.commercialTermsSnapshot.termsResolvedAt,
          event.timing.recordedAt,
        ],
      );
    },
    "ordering.order.pending-payment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        pendingPaymentAt: string;
      };

      await db.query(
        `UPDATE payments_order_inputs
         SET status = 'pending-payment',
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.pendingPaymentAt],
      );
    },
    "ordering.order.cancelled": async (event) => {
      const data = event.data as {
        orderId: string;
        cancelledAt: string;
      };

      await db.query(
        `UPDATE payments_order_inputs
         SET status = 'cancelled',
             cancelled_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.cancelledAt],
      );
    },
    "ordering.order.ready-for-fulfillment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        readyForFulfillmentAt: string;
      };

      await db.query(
        `UPDATE payments_order_inputs
         SET status = 'ready-for-fulfillment',
             ready_for_fulfillment_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.readyForFulfillmentAt],
      );
    },
  };
}
