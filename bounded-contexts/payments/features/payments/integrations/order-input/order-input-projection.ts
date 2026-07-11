import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildPaymentsOrderInputProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as {
        orderId: string;
        sourceType: string;
        sourceReferenceId: string | null;
        buyerAccountId: string;
        sellerAccountId: string;
        shippingDestinationSnapshot?: { email?: string | null } | null;
        salesTaxAmount?: string;
        totalAmount: string;
        shippingAllowanceAmount?: string;
        shippingOverageAmount?: string;
        commercialTermsSnapshot: {
          marketplaceSalesFeeAmount: string;
          sellerNetAmount: string;
          sellerItemNetAmount?: string;
          shippingAllowanceAmount?: string;
          sellerShippingPayoutAmount?: string;
          sellerPayoutAmount?: string;
          shippingAllowancePercentageBps?: number;
          termsScheduleId: string | null;
          termsAgreementId: string | null;
          termsResolvedAt: string;
        };
        authenticityPlanSnapshot?: { feeAmount: string } | null;
      };

      await db.query(
        `INSERT INTO payments_order_inputs (
           order_id,
           source_type,
           source_reference_id,
           buyer_account_id,
           buyer_email,
           seller_account_id,
           sales_tax_amount,
           total_amount,
           marketplace_sales_fee_amount,
           authenticity_fee_amount,
           marketplace_checkout_fee_amount,
           seller_net_amount,
           seller_item_net_amount,
            shipping_allowance_amount,
            shipping_overage_amount,
            seller_shipping_payout_amount,
            seller_payout_amount,
           shipping_allowance_percentage_bps,
           terms_schedule_id,
           terms_agreement_id,
            terms_resolved_at,
            status,
            pending_payment_at,
            payment_deadline_at,
            payment_deadline_policy,
            created_at,
           updated_at,
           cancelled_at,
           ready_for_fulfillment_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'pending-reservation', NULL, NULL, NULL, $22, $22, NULL, NULL)
         ON CONFLICT (order_id) DO UPDATE
         SET source_type = EXCLUDED.source_type,
             source_reference_id = EXCLUDED.source_reference_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             buyer_email = EXCLUDED.buyer_email,
             seller_account_id = EXCLUDED.seller_account_id,
             sales_tax_amount = EXCLUDED.sales_tax_amount,
             total_amount = EXCLUDED.total_amount,
             marketplace_sales_fee_amount = EXCLUDED.marketplace_sales_fee_amount,
             authenticity_fee_amount = EXCLUDED.authenticity_fee_amount,
             marketplace_checkout_fee_amount = EXCLUDED.marketplace_checkout_fee_amount,
             seller_net_amount = EXCLUDED.seller_net_amount,
             seller_item_net_amount = EXCLUDED.seller_item_net_amount,
              shipping_allowance_amount = EXCLUDED.shipping_allowance_amount,
              shipping_overage_amount = EXCLUDED.shipping_overage_amount,
              seller_shipping_payout_amount = EXCLUDED.seller_shipping_payout_amount,
              seller_payout_amount = EXCLUDED.seller_payout_amount,
             shipping_allowance_percentage_bps = EXCLUDED.shipping_allowance_percentage_bps,
             terms_schedule_id = EXCLUDED.terms_schedule_id,
             terms_agreement_id = EXCLUDED.terms_agreement_id,
              terms_resolved_at = EXCLUDED.terms_resolved_at,
              status = EXCLUDED.status,
              pending_payment_at = EXCLUDED.pending_payment_at,
              payment_deadline_at = EXCLUDED.payment_deadline_at,
              payment_deadline_policy = EXCLUDED.payment_deadline_policy,
              updated_at = EXCLUDED.updated_at,
             cancelled_at = EXCLUDED.cancelled_at,
             ready_for_fulfillment_at = EXCLUDED.ready_for_fulfillment_at`,
        [
          data.orderId,
          data.sourceType,
          data.sourceReferenceId,
          data.buyerAccountId,
          data.shippingDestinationSnapshot?.email?.trim() || null,
          data.sellerAccountId,
          data.salesTaxAmount ?? "0.00",
          data.totalAmount,
          data.commercialTermsSnapshot.marketplaceSalesFeeAmount,
          data.authenticityPlanSnapshot?.feeAmount ?? "0.00",
          // Marketplace Checkout Fee is payment-level; order inputs stay explicit at zero.
          "0.00",
          data.commercialTermsSnapshot.sellerNetAmount,
          data.commercialTermsSnapshot.sellerItemNetAmount ?? data.commercialTermsSnapshot.sellerNetAmount,
          data.commercialTermsSnapshot.shippingAllowanceAmount ?? data.shippingAllowanceAmount ?? "0.00",
          data.shippingOverageAmount ?? "0.00",
          data.commercialTermsSnapshot.sellerShippingPayoutAmount ??
            data.commercialTermsSnapshot.shippingAllowanceAmount ??
            data.shippingAllowanceAmount ??
            "0.00",
          data.commercialTermsSnapshot.sellerPayoutAmount ??
            (
              Number.parseFloat(data.commercialTermsSnapshot.sellerNetAmount) +
              Number.parseFloat(
                data.commercialTermsSnapshot.sellerShippingPayoutAmount ??
                  data.commercialTermsSnapshot.shippingAllowanceAmount ??
                  data.shippingAllowanceAmount ??
                  "0.00",
              )
            ).toFixed(2),
          data.commercialTermsSnapshot.shippingAllowancePercentageBps ?? 500,
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
        paymentDeadlineAt: string;
        paymentDeadlinePolicy: string;
      };

      await db.query(
        `UPDATE payments_order_inputs
          SET status = 'pending-payment',
              pending_payment_at = $2,
              payment_deadline_at = $3,
              payment_deadline_policy = $4,
              updated_at = $2
          WHERE order_id = $1`,
        [data.orderId, data.pendingPaymentAt, data.paymentDeadlineAt, data.paymentDeadlinePolicy],
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
