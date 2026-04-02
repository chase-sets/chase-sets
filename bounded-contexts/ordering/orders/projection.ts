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
        inventoryReservations: Array<{
          holdId: string;
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
           status,
           created_at,
           updated_at,
           cancelled_at,
           ready_for_fulfillment_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending-payment', $12, $12, NULL, NULL
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
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at,
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
           )`,
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

      for (const reservation of data.inventoryReservations) {
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
            reservation.holdId,
            data.orderId,
            reservation.sellerAccountId,
            reservation.inventoryRecordId,
            reservation.quantity,
            event.timing.recordedAt,
          ],
        );
      }
    },
    "ordering.order.cancelled": async (event) => {
      const data = event.data as { orderId: string; cancelledAt: string };

      await db.query(
        `UPDATE ordering_order_pages
         SET status = 'cancelled',
             cancelled_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.cancelledAt],
      );

      await db.query(
        `UPDATE ordering_order_hold_pages
         SET status = 'released',
             released_at = $2
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
