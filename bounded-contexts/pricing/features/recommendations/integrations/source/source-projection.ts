import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

function extractIdFromStreamId(streamId: string, prefix: string): string {
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Stream ID "${streamId}" does not start with prefix "${prefix}".`);
  }

  return streamId.slice(prefix.length);
}

export function buildPricingCatalogInputProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.created": async (event) => {
      const data = event.data as {
        itemId: string;
        title: string;
        subtitle: string | null;
      };

      await db.query(
        `INSERT INTO pricing_catalog_item_inputs (
           item_id,
           title,
           subtitle,
           status,
           updated_at
         ) VALUES ($1, $2, $3, 'draft', $4)
         ON CONFLICT (item_id) DO UPDATE
         SET title = EXCLUDED.title,
             subtitle = EXCLUDED.subtitle,
             updated_at = EXCLUDED.updated_at`,
        [data.itemId, data.title, data.subtitle, event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      const data = event.data as { title: string; subtitle: string | null };
      const itemId = extractIdFromStreamId(event.streamId, "catalog.item-");

      await db.query(
        `UPDATE pricing_catalog_item_inputs
         SET title = $2,
             subtitle = $3,
             updated_at = $4
         WHERE item_id = $1`,
        [itemId, data.title, data.subtitle, event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.published": async (event) => {
      await db.query(
        `UPDATE pricing_catalog_item_inputs
         SET status = 'active',
             updated_at = $2
         WHERE item_id = $1`,
        [
          extractIdFromStreamId(event.streamId, "catalog.item-"),
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.catalog-item.retired": async (event) => {
      await db.query(
        `UPDATE pricing_catalog_item_inputs
         SET status = 'retired',
             updated_at = $2
         WHERE item_id = $1`,
        [
          extractIdFromStreamId(event.streamId, "catalog.item-"),
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.catalog-item.archived": async (event) => {
      await db.query(
        `UPDATE pricing_catalog_item_inputs
         SET status = 'archived',
             updated_at = $2
         WHERE item_id = $1`,
        [
          extractIdFromStreamId(event.streamId, "catalog.item-"),
          event.timing.recordedAt,
        ],
      );
    },
  };
}

export function buildPricingInventoryInputProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "inventory.record.created": async (event) => {
      const data = event.data as {
        recordId: string;
        accountId: string;
        catalogItemId: string;
        catalogVersionKey: string;
        totalQuantity: number;
      };

      await db.query(
        `INSERT INTO pricing_inventory_record_inputs (
           record_id,
           seller_account_id,
           catalog_item_id,
           catalog_version_key,
           total_quantity,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (record_id) DO UPDATE
         SET seller_account_id = EXCLUDED.seller_account_id,
             catalog_item_id = EXCLUDED.catalog_item_id,
             catalog_version_key = EXCLUDED.catalog_version_key,
             total_quantity = EXCLUDED.total_quantity,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE pricing_inventory_record_inputs.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.recordId,
          data.accountId,
          data.catalogItemId,
          data.catalogVersionKey,
          data.totalQuantity,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "inventory.record.adjusted": async (event) => {
      const data = event.data as {
        recordId: string;
        quantityDelta: number;
      };

      await db.query(
        `UPDATE pricing_inventory_record_inputs
         SET total_quantity = GREATEST(total_quantity + $2, 0),
             updated_at = $3,
             last_stream_version = $4
         WHERE record_id = $1
           AND last_stream_version < $4`,
        [data.recordId, data.quantityDelta, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.placed": async (event) => {
      const data = event.data as {
        holdId: string;
        accountId: string;
        recordId: string;
        quantity: number;
      };

      await db.query(
        `INSERT INTO pricing_inventory_hold_inputs (
           hold_id,
           record_id,
           seller_account_id,
           quantity,
           status,
           released_at,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, 'active', NULL, $5, $6)
         ON CONFLICT (hold_id) DO UPDATE
         SET record_id = EXCLUDED.record_id,
             seller_account_id = EXCLUDED.seller_account_id,
             quantity = EXCLUDED.quantity,
             status = EXCLUDED.status,
             released_at = EXCLUDED.released_at,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE pricing_inventory_hold_inputs.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.holdId,
          data.recordId,
          data.accountId,
          data.quantity,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "inventory.hold.released": async (event) => {
      const data = event.data as {
        holdId: string;
        releasedAt: string;
      };

      await db.query(
        `UPDATE pricing_inventory_hold_inputs
         SET status = 'released',
             released_at = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE hold_id = $1
           AND last_stream_version < $4`,
        [data.holdId, data.releasedAt, event.timing.recordedAt, event.streamVersion],
      );
    },
  };
}

export function buildPricingMarketplaceInputProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "marketplace.listing.created": async (event) => {
      const data = event.data as {
        listingId: string;
        accountId: string;
        catalogItemId: string;
        catalogVersionKey: string;
        priceAmount: string;
        quantityCap: number;
      };

      await db.query(
        `INSERT INTO pricing_market_listing_inputs (
           listing_id,
           seller_account_id,
           catalog_item_id,
           catalog_version_key,
           price_amount,
           quantity_cap,
           status,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7)
         ON CONFLICT (listing_id) DO UPDATE
         SET seller_account_id = EXCLUDED.seller_account_id,
             catalog_item_id = EXCLUDED.catalog_item_id,
             catalog_version_key = EXCLUDED.catalog_version_key,
             price_amount = EXCLUDED.price_amount,
             quantity_cap = EXCLUDED.quantity_cap,
             updated_at = EXCLUDED.updated_at`,
        [
          data.listingId,
          data.accountId,
          data.catalogItemId,
          data.catalogVersionKey,
          data.priceAmount,
          data.quantityCap,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.price-updated": async (event) => {
      const data = event.data as { priceAmount: string };

      await db.query(
        `UPDATE pricing_market_listing_inputs
         SET price_amount = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [
          extractIdFromStreamId(event.streamId, "marketplace.listing-"),
          data.priceAmount,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const data = event.data as { quantityCap: number };

      await db.query(
        `UPDATE pricing_market_listing_inputs
         SET quantity_cap = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [
          extractIdFromStreamId(event.streamId, "marketplace.listing-"),
          data.quantityCap,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.published": async (event) => {
      await db.query(
        `UPDATE pricing_market_listing_inputs
         SET status = 'active',
             updated_at = $2
         WHERE listing_id = $1`,
        [
          extractIdFromStreamId(event.streamId, "marketplace.listing-"),
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.paused": async (event) => {
      await db.query(
        `UPDATE pricing_market_listing_inputs
         SET status = 'paused',
             updated_at = $2
         WHERE listing_id = $1`,
        [
          extractIdFromStreamId(event.streamId, "marketplace.listing-"),
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.withdrawn": async (event) => {
      await db.query(
        `UPDATE pricing_market_listing_inputs
         SET status = 'withdrawn',
             updated_at = $2
         WHERE listing_id = $1`,
        [
          extractIdFromStreamId(event.streamId, "marketplace.listing-"),
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.offer.submitted": async (event) => {
      const data = event.data as {
        offerId: string;
        buyerAccountId: string;
        catalogItemId: string;
        catalogVersionKey: string;
        priceAmount: string;
        quantityRequested: number;
      };

      await db.query(
        `INSERT INTO pricing_market_offer_inputs (
           offer_id,
           buyer_account_id,
           seller_account_id,
           catalog_item_id,
           catalog_version_key,
           price_amount,
           quantity_requested,
           status,
           accepted_at,
           updated_at
         ) VALUES ($1, $2, NULL, $3, $4, $5, $6, 'submitted', NULL, $7)
         ON CONFLICT (offer_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             catalog_item_id = EXCLUDED.catalog_item_id,
             catalog_version_key = EXCLUDED.catalog_version_key,
             price_amount = EXCLUDED.price_amount,
             quantity_requested = EXCLUDED.quantity_requested,
             status = EXCLUDED.status,
             accepted_at = EXCLUDED.accepted_at,
             updated_at = EXCLUDED.updated_at`,
        [
          data.offerId,
          data.buyerAccountId,
          data.catalogItemId,
          data.catalogVersionKey,
          data.priceAmount,
          data.quantityRequested,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.offer.accepted": async (event) => {
      const data = event.data as {
        offerId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        catalogItemId: string;
        catalogVersionKey: string;
        priceAmount: string;
        quantityRequested: number;
        acceptedAt: string;
      };

      await db.query(
        `INSERT INTO pricing_market_offer_inputs (
           offer_id,
           buyer_account_id,
           seller_account_id,
           catalog_item_id,
           catalog_version_key,
           price_amount,
           quantity_requested,
           status,
           accepted_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'accepted', $8, $8)
         ON CONFLICT (offer_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             catalog_item_id = EXCLUDED.catalog_item_id,
             catalog_version_key = EXCLUDED.catalog_version_key,
             price_amount = EXCLUDED.price_amount,
             quantity_requested = EXCLUDED.quantity_requested,
             status = EXCLUDED.status,
             accepted_at = EXCLUDED.accepted_at,
             updated_at = EXCLUDED.updated_at`,
        [
          data.offerId,
          data.buyerAccountId,
          data.sellerAccountId,
          data.catalogItemId,
          data.catalogVersionKey,
          data.priceAmount,
          data.quantityRequested,
          data.acceptedAt,
        ],
      );
    },
  };
}

export function buildPricingOrderingInputProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as {
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        lines: Array<{
          lineId: string;
          catalogItemId: string;
          catalogVersionKey: string;
          unitPriceAmount: string;
          quantity: number;
        }>;
      };

      await db.query(`DELETE FROM pricing_order_signal_lines WHERE order_id = $1`, [
        data.orderId,
      ]);

      for (const line of data.lines) {
        await db.query(
          `INSERT INTO pricing_order_signal_lines (
             order_id,
             line_id,
             buyer_account_id,
             seller_account_id,
             catalog_item_id,
             catalog_version_key,
             unit_price_amount,
             quantity,
             status,
             ready_for_fulfillment_at,
             cancelled_at,
             updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, 'pending-payment', NULL, NULL, $9
           )
           ON CONFLICT (order_id, line_id) DO UPDATE
           SET buyer_account_id = EXCLUDED.buyer_account_id,
               seller_account_id = EXCLUDED.seller_account_id,
               catalog_item_id = EXCLUDED.catalog_item_id,
               catalog_version_key = EXCLUDED.catalog_version_key,
               unit_price_amount = EXCLUDED.unit_price_amount,
               quantity = EXCLUDED.quantity,
               status = EXCLUDED.status,
               ready_for_fulfillment_at = EXCLUDED.ready_for_fulfillment_at,
               cancelled_at = EXCLUDED.cancelled_at,
               updated_at = EXCLUDED.updated_at`,
          [
            data.orderId,
            line.lineId,
            data.buyerAccountId,
            data.sellerAccountId,
            line.catalogItemId,
            line.catalogVersionKey,
            line.unitPriceAmount,
            line.quantity,
            event.timing.recordedAt,
          ],
        );
      }
    },
    "ordering.order.cancelled": async (event) => {
      const data = event.data as {
        orderId: string;
        cancelledAt: string;
      };

      await db.query(
        `UPDATE pricing_order_signal_lines
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
        `UPDATE pricing_order_signal_lines
         SET status = 'ready-for-fulfillment',
             ready_for_fulfillment_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.readyForFulfillmentAt],
      );
    },
  };
}

export function buildPricingFulfillmentInputProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.created": async (event) => {
      const data = event.data as {
        shipmentId: string;
        orderId: string;
        lines: Array<{
          lineId: string;
          catalogItemId: string;
          catalogVersionKey: string;
          quantity: number;
        }>;
        createdAt: string;
      };

      await db.query(
        `DELETE FROM pricing_fulfillment_signal_lines WHERE shipment_id = $1`,
        [data.shipmentId],
      );

      for (const line of data.lines) {
        await db.query(
          `INSERT INTO pricing_fulfillment_signal_lines (
             shipment_id,
             line_id,
             order_id,
             catalog_item_id,
             catalog_version_key,
             quantity,
             status,
             delivered_at,
             returned_at,
             updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, 'awaiting-package', NULL, NULL, $7
           )
           ON CONFLICT (shipment_id, line_id) DO UPDATE
           SET order_id = EXCLUDED.order_id,
               catalog_item_id = EXCLUDED.catalog_item_id,
               catalog_version_key = EXCLUDED.catalog_version_key,
               quantity = EXCLUDED.quantity,
               status = EXCLUDED.status,
               delivered_at = EXCLUDED.delivered_at,
               returned_at = EXCLUDED.returned_at,
               updated_at = EXCLUDED.updated_at`,
          [
            data.shipmentId,
            line.lineId,
            data.orderId,
            line.catalogItemId,
            line.catalogVersionKey,
            line.quantity,
            data.createdAt,
          ],
        );
      }
    },
    "fulfillment.shipment.delivered": async (event) => {
      const data = event.data as {
        shipmentId: string;
        deliveredAt: string;
      };

      await db.query(
        `UPDATE pricing_fulfillment_signal_lines
         SET status = 'delivered',
             delivered_at = $2,
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
        `UPDATE pricing_fulfillment_signal_lines
         SET status = 'returned',
             returned_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.returnedAt],
      );
    },
  };
}
