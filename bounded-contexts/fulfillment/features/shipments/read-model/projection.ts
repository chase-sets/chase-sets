import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildFulfillmentShipmentProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.created": async (event) => {
      const data = event.data as {
        shipmentId: string;
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        shippingOption: string;
        lines: Array<{
          lineId: string;
          orderLineId: string;
          catalogItemId: string;
          productId: string;
          itemTitle: string;
          itemSubtitle: string | null;
          productSummary: string | null;
          quantity: number;
        }>;
        createdAt: string;
      };

      await db.query(
        `INSERT INTO fulfillment_shipment_pages (
           shipment_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           shipping_option,
           shipping_method,
           carrier_name,
           label_reference,
           tracking_identifier,
           status,
           package_status,
           package_count,
           current_exception_type,
           current_exception_notes,
           created_at,
           updated_at,
           package_prepared_at,
           label_attached_at,
           dispatched_at,
           delivered_at,
           returned_at,
           exception_raised_at
         ) VALUES (
           $1, $2, $3, $4, $5, NULL, NULL, NULL, NULL, 'awaiting-package', 'awaiting-package', NULL, NULL, NULL, $6, $6, NULL, NULL, NULL, NULL, NULL, NULL
         )
         ON CONFLICT (shipment_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             shipping_option = EXCLUDED.shipping_option,
             updated_at = EXCLUDED.updated_at`,
        [
          data.shipmentId,
          data.orderId,
          data.buyerAccountId,
          data.sellerAccountId,
          data.shippingOption,
          data.createdAt,
        ],
      );

      await db.query(
        `DELETE FROM fulfillment_shipment_line_pages WHERE shipment_id = $1`,
        [data.shipmentId],
      );

      for (const [index, line] of data.lines.entries()) {
        await db.query(
          `INSERT INTO fulfillment_shipment_line_pages (
             shipment_id,
             line_id,
             line_index,
             order_line_id,
             catalog_catalog_item_id,
             product_id,
             item_title,
             item_subtitle,
             product_summary,
             quantity
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
           )`,
          [
            data.shipmentId,
            line.lineId,
            index,
            line.orderLineId,
            line.catalogItemId,
            line.productId,
            line.itemTitle,
            line.itemSubtitle,
            line.productSummary,
            line.quantity,
          ],
        );
      }
    },
    "fulfillment.shipment.package-prepared": async (event) => {
      const data = event.data as {
        shipmentId: string;
        packageCount: number;
        preparedAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET status = 'awaiting-label',
             package_status = 'packed',
             package_count = $2,
             package_prepared_at = $3,
             updated_at = $3
         WHERE shipment_id = $1`,
        [data.shipmentId, data.packageCount, data.preparedAt],
      );
    },
    "fulfillment.shipment.label-attached": async (event) => {
      const data = event.data as {
        shipmentId: string;
        shippingMethod: string;
        carrierName: string;
        labelReference: string;
        trackingIdentifier: string;
        attachedAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET status = 'label-attached',
             shipping_method = $2,
             carrier_name = $3,
             label_reference = $4,
             tracking_identifier = $5,
             label_attached_at = $6,
             updated_at = $6
         WHERE shipment_id = $1`,
        [
          data.shipmentId,
          data.shippingMethod,
          data.carrierName,
          data.labelReference,
          data.trackingIdentifier,
          data.attachedAt,
        ],
      );
    },
    "fulfillment.shipment.dispatched": async (event) => {
      const data = event.data as {
        shipmentId: string;
        dispatchedAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET status = 'dispatched',
             dispatched_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.dispatchedAt],
      );
    },
    "fulfillment.shipment.delivered": async (event) => {
      const data = event.data as {
        shipmentId: string;
        deliveredAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET status = 'delivered',
             delivered_at = $2,
             current_exception_type = NULL,
             current_exception_notes = NULL,
             exception_raised_at = NULL,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.deliveredAt],
      );
    },
    "fulfillment.shipment.returned": async (event) => {
      const data = event.data as {
        shipmentId: string;
        returnedAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET status = 'returned',
             returned_at = $2,
             current_exception_type = NULL,
             current_exception_notes = NULL,
             exception_raised_at = NULL,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.returnedAt],
      );
    },
    "fulfillment.shipment.exception-raised": async (event) => {
      const data = event.data as {
        shipmentId: string;
        exceptionType: string;
        notes: string | null;
        raisedAt: string;
      };

      await db.query(
        `UPDATE fulfillment_shipment_pages
         SET status = 'exception',
             current_exception_type = $2,
             current_exception_notes = $3,
             exception_raised_at = $4,
             updated_at = $4
         WHERE shipment_id = $1`,
        [data.shipmentId, data.exceptionType, data.notes, data.raisedAt],
      );

      await db.query(
        `INSERT INTO fulfillment_shipment_exception_pages (
           shipment_id,
           raised_at,
           exception_type,
           notes
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (shipment_id, raised_at) DO UPDATE
         SET exception_type = EXCLUDED.exception_type,
             notes = EXCLUDED.notes`,
        [data.shipmentId, data.raisedAt, data.exceptionType, data.notes],
      );
    },
  };
}
