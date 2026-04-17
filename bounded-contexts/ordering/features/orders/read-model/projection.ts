import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildOrderingOrderProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
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
        shippingChargeAmount: string;
        totalAmount: string;
        commercialTermsSnapshot: {
          marketplaceFeeAmount: string;
          paymentFeeAmount: string;
          sellerNetAmount: string;
          termsScheduleId: string | null;
          termsAgreementId: string | null;
          termsResolvedAt: string;
        };
        lines: Array<{
          lineId: string;
          listingId: string;
          inventoryRecordId: string;
          catalogItemId: string;
          catalogVersionKey: string;
          itemTitle: string;
          itemSubtitle: string | null;
          versionSelection: unknown;
          versionSummary: string | null;
          unitPriceAmount: string;
          quantity: number;
          lineTotalAmount: string;
        }>;
        reservationRequests: Array<{
          reservationRequestId: string;
          inventoryRecordId: string;
          sellerAccountId: string;
          quantity: number;
        }>;
      };

      await db.query(
        `INSERT INTO ordering_order_pages (
           order_id,
           source_type,
           source_reference_id,
           buyer_account_id,
           seller_account_id,
           shipping_option,
           item_subtotal_amount,
           shipping_base_amount,
           shipping_discount_amount,
           shipping_charge_amount,
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
           cancellation_reason,
           ready_for_fulfillment_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pending-reservation', $18, $18, NULL, NULL, NULL
         )
         ON CONFLICT (order_id) DO UPDATE
         SET source_type = EXCLUDED.source_type,
             source_reference_id = EXCLUDED.source_reference_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             shipping_option = EXCLUDED.shipping_option,
             item_subtotal_amount = EXCLUDED.item_subtotal_amount,
             shipping_base_amount = EXCLUDED.shipping_base_amount,
             shipping_discount_amount = EXCLUDED.shipping_discount_amount,
             shipping_charge_amount = EXCLUDED.shipping_charge_amount,
             total_amount = EXCLUDED.total_amount,
             marketplace_fee_amount = EXCLUDED.marketplace_fee_amount,
             payment_fee_amount = EXCLUDED.payment_fee_amount,
             seller_net_amount = EXCLUDED.seller_net_amount,
             terms_schedule_id = EXCLUDED.terms_schedule_id,
             terms_agreement_id = EXCLUDED.terms_agreement_id,
             terms_resolved_at = EXCLUDED.terms_resolved_at,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at,
             cancellation_reason = EXCLUDED.cancellation_reason,
             ready_for_fulfillment_at = EXCLUDED.ready_for_fulfillment_at`,
        [
          data.orderId,
          data.sourceType,
          data.sourceReferenceId,
          data.buyerAccountId,
          data.sellerAccountId,
          data.shippingOption,
          data.itemSubtotalAmount,
          data.shippingBaseAmount,
          data.shippingDiscountAmount,
          data.shippingChargeAmount,
          data.totalAmount,
          data.commercialTermsSnapshot.marketplaceFeeAmount,
          data.commercialTermsSnapshot.paymentFeeAmount,
          data.commercialTermsSnapshot.sellerNetAmount,
          data.commercialTermsSnapshot.termsScheduleId,
          data.commercialTermsSnapshot.termsAgreementId,
          data.commercialTermsSnapshot.termsResolvedAt,
          event.timing.recordedAt,
        ],
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
             inventory_record_id,
             catalog_item_id,
             catalog_version_key,
             item_title,
             item_subtitle,
             version_selection,
             version_summary,
             unit_price_amount,
             quantity,
             line_total_amount
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
           )
           ON CONFLICT (order_id, line_id) DO UPDATE
           SET line_index = EXCLUDED.line_index,
               listing_id = EXCLUDED.listing_id,
               inventory_record_id = EXCLUDED.inventory_record_id,
               catalog_item_id = EXCLUDED.catalog_item_id,
               catalog_version_key = EXCLUDED.catalog_version_key,
               item_title = EXCLUDED.item_title,
               item_subtitle = EXCLUDED.item_subtitle,
               version_selection = EXCLUDED.version_selection,
               version_summary = EXCLUDED.version_summary,
               unit_price_amount = EXCLUDED.unit_price_amount,
               quantity = EXCLUDED.quantity,
               line_total_amount = EXCLUDED.line_total_amount`,
          [
            data.orderId,
            line.lineId,
            index,
            line.listingId,
            line.inventoryRecordId,
            line.catalogItemId,
            line.catalogVersionKey,
            line.itemTitle,
            line.itemSubtitle,
            JSON.stringify(Array.isArray(line.versionSelection) ? line.versionSelection : []),
            line.versionSummary,
            line.unitPriceAmount,
            line.quantity,
            line.lineTotalAmount,
          ],
        );
      }

    },
    "ordering.order.reservation-confirmed": async (event) => {
      const data = event.data as {
        orderId: string;
        reservationRequestId: string;
        inventoryRecordId: string;
        sellerAccountId: string;
        quantity: number;
        holdId: string;
      }

      await db.query(
        `INSERT INTO ordering_order_hold_pages (
           hold_id,
           order_id,
           seller_account_id,
           inventory_record_id,
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
             inventory_record_id = EXCLUDED.inventory_record_id,
             quantity = EXCLUDED.quantity,
             status = EXCLUDED.status,
             created_at = EXCLUDED.created_at,
             released_at = EXCLUDED.released_at`,
        [
          data.holdId,
          data.orderId,
          data.sellerAccountId,
          data.inventoryRecordId,
          data.quantity,
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
        `UPDATE ordering_order_pages
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
