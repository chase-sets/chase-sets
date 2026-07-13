import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import { withOrderDisplayReference } from "./display-reference";

export function buildOrderingOrderProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as {
        orderId: string;
        sourceType: string;
        sourceReferenceId: string | null;
        buyerAccountId: string;
        sellerAccountId: string;
        shippingOption: string;
        itemSubtotalAmount: string;
        shippingBaseAmount: string;
        shippingDiscountAmount: string;
        shippingAllowanceAmount?: string;
        shippingOverageAmount?: string;
        protectionAmount?: string;
        protectionAllowanceAmount?: string;
        protectionOverageAmount?: string;
        shippingChargeAmount: string;
        shippingPlanSnapshot?: unknown;
        totalAmount: string;
        salesTaxAmount: string;
        taxSnapshot: {
          taxableAmount: string;
          salesTaxAmount: string;
          jurisdictionCountry: string;
          jurisdictionState: string | null;
          rateBps: number;
          providerName: string;
          providerQuoteReference: string | null;
          quotedAt: string;
        };
        commercialTermsSnapshot: {
          marketplaceSalesFeeAmount: string;
          sellerNetAmount: string;
          sellerItemNetAmount?: string;
          shippingAllowanceAmount?: string;
          protectionAmount?: string;
          protectionAllowanceAmount?: string;
          protectionOverageAmount?: string;
          sellerPayoutAmount?: string;
          shippingAllowancePercentageBps?: number;
          termsScheduleId: string | null;
          termsAgreementId: string | null;
          termsResolvedAt: string;
        };
        shippingDestinationSnapshot: unknown;
        shippingOriginSnapshot: unknown;
        lines: Array<{
          lineId: string;
          listingId: string;
          inventoryItemId: string;
          catalogItemId: string;
          productId: string;
          itemTitle: string;
          itemSubtitle: string | null;
          selectedOptions: unknown;
          productSummary: string | null;
          unitPriceAmount: string;
          quantity: number;
          lineTotalAmount: string;
          marketplaceSalesFeePercentageBps?: number;
          marketplaceSalesFeeFixedAmount?: string;
          marketplaceSalesFeeCapAmount?: string | null;
          marketplaceSalesFeeUnitAmount: string;
          marketplaceSalesFeeTotalAmount: string;
          sellerNetUnitAmount: string;
          sellerNetTotalAmount: string;
        }>;
        reservationRequests: Array<{
          reservationRequestId: string;
          inventoryItemId: string;
          sellerAccountId: string;
          quantity: number;
        }>;
      };

      await withOrderDisplayReference(data.orderId as OrderId, (displayReference) =>
        db.query(
          `INSERT INTO ordering_order_pages (
           order_id,
           display_reference,
           source_type,
           source_reference_id,
           buyer_account_id,
           seller_account_id,
           shipping_option,
           item_subtotal_amount,
           shipping_base_amount,
           shipping_discount_amount,
           shipping_allowance_amount,
           shipping_overage_amount,
           protection_amount,
           protection_allowance_amount,
           protection_overage_amount,
           shipping_charge_amount,
           sales_tax_amount,
           taxable_amount,
           tax_jurisdiction_country,
           tax_jurisdiction_state,
           tax_rate_bps,
           tax_provider_name,
           tax_provider_quote_reference,
           tax_quoted_at,
           total_amount,
           marketplace_sales_fee_amount,
           seller_net_amount,
           seller_item_net_amount,
           seller_payout_amount,
           shipping_allowance_percentage_bps,
           terms_schedule_id,
           terms_agreement_id,
           terms_resolved_at,
           shipping_destination_snapshot,
           shipping_origin_snapshot,
           shipping_plan_snapshot,
           status,
           created_at,
           updated_at,
           cancelled_at,
           cancellation_reason,
           ready_for_fulfillment_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, 'pending-reservation', $37, $37, NULL, NULL, NULL
         )
         ON CONFLICT (order_id) DO UPDATE
         SET display_reference = EXCLUDED.display_reference,
             source_type = EXCLUDED.source_type,
             source_reference_id = EXCLUDED.source_reference_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             shipping_option = EXCLUDED.shipping_option,
             item_subtotal_amount = EXCLUDED.item_subtotal_amount,
             shipping_base_amount = EXCLUDED.shipping_base_amount,
             shipping_discount_amount = EXCLUDED.shipping_discount_amount,
             shipping_allowance_amount = EXCLUDED.shipping_allowance_amount,
             shipping_overage_amount = EXCLUDED.shipping_overage_amount,
             protection_amount = EXCLUDED.protection_amount,
             protection_allowance_amount = EXCLUDED.protection_allowance_amount,
             protection_overage_amount = EXCLUDED.protection_overage_amount,
             shipping_charge_amount = EXCLUDED.shipping_charge_amount,
             sales_tax_amount = EXCLUDED.sales_tax_amount,
             taxable_amount = EXCLUDED.taxable_amount,
             tax_jurisdiction_country = EXCLUDED.tax_jurisdiction_country,
             tax_jurisdiction_state = EXCLUDED.tax_jurisdiction_state,
             tax_rate_bps = EXCLUDED.tax_rate_bps,
             tax_provider_name = EXCLUDED.tax_provider_name,
             tax_provider_quote_reference = EXCLUDED.tax_provider_quote_reference,
             tax_quoted_at = EXCLUDED.tax_quoted_at,
             total_amount = EXCLUDED.total_amount,
             marketplace_sales_fee_amount = EXCLUDED.marketplace_sales_fee_amount,
             seller_net_amount = EXCLUDED.seller_net_amount,
             seller_item_net_amount = EXCLUDED.seller_item_net_amount,
             seller_payout_amount = EXCLUDED.seller_payout_amount,
             shipping_allowance_percentage_bps = EXCLUDED.shipping_allowance_percentage_bps,
             terms_schedule_id = EXCLUDED.terms_schedule_id,
             terms_agreement_id = EXCLUDED.terms_agreement_id,
             terms_resolved_at = EXCLUDED.terms_resolved_at,
             shipping_destination_snapshot = EXCLUDED.shipping_destination_snapshot,
             shipping_origin_snapshot = EXCLUDED.shipping_origin_snapshot,
             shipping_plan_snapshot = EXCLUDED.shipping_plan_snapshot,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at,
             cancellation_reason = EXCLUDED.cancellation_reason,
             ready_for_fulfillment_at = EXCLUDED.ready_for_fulfillment_at`,
          [
            data.orderId,
            displayReference,
            data.sourceType,
            data.sourceReferenceId,
            data.buyerAccountId,
            data.sellerAccountId,
            data.shippingOption,
            data.itemSubtotalAmount,
            data.shippingBaseAmount,
            data.shippingDiscountAmount,
            data.shippingAllowanceAmount ?? data.shippingChargeAmount,
            data.shippingOverageAmount ?? "0.00",
            data.protectionAmount ?? data.commercialTermsSnapshot.protectionAmount ?? "0.00",
            data.protectionAllowanceAmount ?? data.commercialTermsSnapshot.protectionAllowanceAmount ?? "0.00",
            data.protectionOverageAmount ?? data.commercialTermsSnapshot.protectionOverageAmount ?? "0.00",
            data.shippingChargeAmount,
            data.salesTaxAmount,
            data.taxSnapshot.taxableAmount,
            data.taxSnapshot.jurisdictionCountry,
            data.taxSnapshot.jurisdictionState,
            data.taxSnapshot.rateBps,
            data.taxSnapshot.providerName,
            data.taxSnapshot.providerQuoteReference,
            data.taxSnapshot.quotedAt,
            data.totalAmount,
            data.commercialTermsSnapshot.marketplaceSalesFeeAmount,
            data.commercialTermsSnapshot.sellerNetAmount,
            data.commercialTermsSnapshot.sellerItemNetAmount ?? data.commercialTermsSnapshot.sellerNetAmount,
            data.commercialTermsSnapshot.sellerPayoutAmount ??
              (
                Number.parseFloat(data.commercialTermsSnapshot.sellerNetAmount) +
                Number.parseFloat(
                  data.commercialTermsSnapshot.shippingAllowanceAmount ?? data.shippingAllowanceAmount ?? "0.00",
                )
              ).toFixed(2),
            data.commercialTermsSnapshot.shippingAllowancePercentageBps ?? 500,
            data.commercialTermsSnapshot.termsScheduleId,
            data.commercialTermsSnapshot.termsAgreementId,
            data.commercialTermsSnapshot.termsResolvedAt,
            JSON.stringify(data.shippingDestinationSnapshot),
            JSON.stringify(data.shippingOriginSnapshot),
            JSON.stringify(data.shippingPlanSnapshot ?? {}),
            event.timing.recordedAt,
          ],
        ),
      );

      await db.query(`DELETE FROM ordering_order_line_pages WHERE order_id = $1`, [data.orderId]);
      await db.query(`DELETE FROM ordering_order_hold_pages WHERE order_id = $1`, [data.orderId]);

      for (const [index, line] of data.lines.entries()) {
        await db.query(
          `INSERT INTO ordering_order_line_pages (
             order_id,
             line_id,
             line_index,
             listing_id,
             inventory_item_id,
             catalog_catalog_item_id,
             product_id,
             item_title,
             item_subtitle,
             selected_options,
             product_summary,
             unit_price_amount,
             quantity,
             line_total_amount,
             marketplace_sales_fee_percentage_bps,
             marketplace_sales_fee_fixed_amount,
             marketplace_sales_fee_cap_amount,
             marketplace_sales_fee_unit_amount,
             marketplace_sales_fee_total_amount,
             seller_net_unit_amount,
             seller_net_total_amount
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
           )
           ON CONFLICT (order_id, line_id) DO UPDATE
           SET line_index = EXCLUDED.line_index,
               listing_id = EXCLUDED.listing_id,
               inventory_item_id = EXCLUDED.inventory_item_id,
               catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
               product_id = EXCLUDED.product_id,
               item_title = EXCLUDED.item_title,
               item_subtitle = EXCLUDED.item_subtitle,
               selected_options = EXCLUDED.selected_options,
               product_summary = EXCLUDED.product_summary,
               unit_price_amount = EXCLUDED.unit_price_amount,
               quantity = EXCLUDED.quantity,
               line_total_amount = EXCLUDED.line_total_amount,
               marketplace_sales_fee_percentage_bps = EXCLUDED.marketplace_sales_fee_percentage_bps,
               marketplace_sales_fee_fixed_amount = EXCLUDED.marketplace_sales_fee_fixed_amount,
               marketplace_sales_fee_cap_amount = EXCLUDED.marketplace_sales_fee_cap_amount,
               marketplace_sales_fee_unit_amount = EXCLUDED.marketplace_sales_fee_unit_amount,
               marketplace_sales_fee_total_amount = EXCLUDED.marketplace_sales_fee_total_amount,
               seller_net_unit_amount = EXCLUDED.seller_net_unit_amount,
               seller_net_total_amount = EXCLUDED.seller_net_total_amount`,
          [
            data.orderId,
            line.lineId,
            index,
            line.listingId,
            line.inventoryItemId,
            line.catalogItemId,
            line.productId,
            line.itemTitle,
            line.itemSubtitle,
            JSON.stringify(Array.isArray(line.selectedOptions) ? line.selectedOptions : []),
            line.productSummary,
            line.unitPriceAmount,
            line.quantity,
            line.lineTotalAmount,
            line.marketplaceSalesFeePercentageBps ?? 0,
            line.marketplaceSalesFeeFixedAmount ?? line.marketplaceSalesFeeUnitAmount,
            line.marketplaceSalesFeeCapAmount ?? null,
            line.marketplaceSalesFeeUnitAmount,
            line.marketplaceSalesFeeTotalAmount,
            line.sellerNetUnitAmount,
            line.sellerNetTotalAmount,
          ],
        );
      }
    },
    "ordering.order.reservation-confirmed": async (event) => {
      const data = event.data as {
        orderId: string;
        reservationRequestId: string;
        inventoryItemId: string;
        sellerAccountId: string;
        quantity: number;
        holdId: string;
      };

      await db.query(
        `INSERT INTO ordering_order_hold_pages (
           hold_id,
           order_id,
           seller_account_id,
           inventory_item_id,
           quantity,
           status,
           created_at,
           released_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'active', $6, NULL
         )
         ON CONFLICT (hold_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             seller_account_id = EXCLUDED.seller_account_id,
             inventory_item_id = EXCLUDED.inventory_item_id,
             quantity = EXCLUDED.quantity,
             status = EXCLUDED.status,
             created_at = EXCLUDED.created_at,
             released_at = EXCLUDED.released_at`,
        [data.holdId, data.orderId, data.sellerAccountId, data.inventoryItemId, data.quantity, event.timing.recordedAt],
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
        `UPDATE ordering_order_pages
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
        reason: string;
      };

      await db.query(
        `UPDATE ordering_order_pages
         SET status = 'cancelled',
             cancelled_at = $2,
             cancellation_reason = $3,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.cancelledAt, data.reason],
      );
    },
    "ordering.order.reservation-released": async (event) => {
      const data = event.data as {
        holdId: string;
        releasedAt: string;
      };

      await db.query(
        `UPDATE ordering_order_hold_pages
         SET status = 'released',
             released_at = $2
         WHERE hold_id = $1`,
        [data.holdId, data.releasedAt],
      );
    },
    "ordering.order.ready-for-fulfillment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        readyForFulfillmentAt: string;
      };

      await db.query(
        `UPDATE ordering_order_pages
         SET status = 'ready-for-fulfillment',
             ready_for_fulfillment_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.readyForFulfillmentAt],
      );
    },
  };
}
