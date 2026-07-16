import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { coerceLocalizedTextMap, resolveLocalizedTextMap, type LocalizedTextMap } from "@chase-sets/localization";
import { createPricingCatalogItemSlug } from "../../../../support/runtime-support/slugs";

type CatalogItemDisplayIdentityResolvedEventData = Readonly<{
  catalogItemId: string;
  languageCode?: string;
  title: string;
  subtitle?: string | null;
}>;

export function buildPricingCatalogInputProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.created": async (event) => {
      const data = event.data as {
        itemId: string;
        languageCode?: string;
        title: string | LocalizedTextMap;
        subtitle?: string | LocalizedTextMap | null;
      };
      const titleText = resolveLocalizedTextMap(coerceLocalizedTextMap(data.title));
      const subtitleText =
        data.subtitle === null || data.subtitle === undefined
          ? null
          : resolveLocalizedTextMap(coerceLocalizedTextMap(data.subtitle)) || null;
      const slug = createPricingCatalogItemSlug([titleText, subtitleText], data.itemId);

      await db.query(
        `INSERT INTO pricing_catalog_item_inputs (
           catalog_item_id,
           language_code,
           title,
           subtitle,
           status,
           slug,
           updated_at
         ) VALUES ($1, $2, $3, $4, 'draft', $5, $6)
         ON CONFLICT (catalog_item_id) DO UPDATE
         SET language_code = EXCLUDED.language_code,
             title = EXCLUDED.title,
             subtitle = EXCLUDED.subtitle,
             slug = EXCLUDED.slug,
             updated_at = EXCLUDED.updated_at`,
        [data.itemId, data.languageCode ?? "en", titleText, subtitleText, slug, event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.display-identity-resolved": async (event) => {
      const data = event.data as CatalogItemDisplayIdentityResolvedEventData;
      const subtitleText = data.subtitle?.trim() || null;
      const slug = createPricingCatalogItemSlug([data.title, subtitleText], data.catalogItemId);

      await db.query(
        `UPDATE pricing_catalog_item_inputs
         SET language_code = $2,
             title = $3,
             subtitle = $4,
             slug = $5,
             updated_at = $6
         WHERE catalog_item_id = $1`,
        [data.catalogItemId, data.languageCode ?? "en", data.title, subtitleText, slug, event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.published": async (event) => {
      await db.query(
        `UPDATE pricing_catalog_item_inputs
         SET status = 'active',
             updated_at = $2
         WHERE catalog_item_id = $1`,
        [extractIdFromStreamId(event.streamId, "catalog.item-"), event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.retired": async (event) => {
      await db.query(
        `UPDATE pricing_catalog_item_inputs
         SET status = 'archived',
             updated_at = $2
         WHERE catalog_item_id = $1`,
        [extractIdFromStreamId(event.streamId, "catalog.item-"), event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.archived": async (event) => {
      await db.query(
        `UPDATE pricing_catalog_item_inputs
         SET status = 'archived',
             updated_at = $2
         WHERE catalog_item_id = $1`,
        [extractIdFromStreamId(event.streamId, "catalog.item-"), event.timing.recordedAt],
      );
    },
    // Category membership is Pricing's only cross-context signal for repricing-policy catalog-filter
    // scope resolution: RepricingPolicy's `catalog-filter` scope matches on these ids -- Catalog's
    // category hierarchy covers both "game" and finer-grained category filtering, so no separate
    // "game" field is projected. Categories are a set, so upsert/remove by array membership.
    "catalog.catalog-item.category-assigned": async (event) => {
      const data = event.data as { categoryId: string };
      await db.query(
        `UPDATE pricing_catalog_item_inputs
         SET category_ids = ARRAY(SELECT DISTINCT unnest(category_ids || ARRAY[$2::text])),
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [extractIdFromStreamId(event.streamId, "catalog.item-"), data.categoryId, event.timing.recordedAt],
      );
    },
    "catalog.catalog-item.category-removed": async (event) => {
      const data = event.data as { categoryId: string };
      await db.query(
        `UPDATE pricing_catalog_item_inputs
         SET category_ids = array_remove(category_ids, $2::text),
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [extractIdFromStreamId(event.streamId, "catalog.item-"), data.categoryId, event.timing.recordedAt],
      );
    },
  };
}

async function markPricingInventoryHoldTerminal(
  db: PgQueryable,
  params: Readonly<{
    holdId: string;
    status: "released" | "expired";
    releasedAt: string;
    recordedAt: string;
    streamVersion: number;
  }>,
): Promise<void> {
  await db.query(
    `UPDATE pricing_inventory_hold_inputs
     SET status = $2,
         released_at = $3,
         updated_at = $4,
         last_stream_version = $5
     WHERE hold_id = $1
       AND last_stream_version < $5`,
    [params.holdId, params.status, params.releasedAt, params.recordedAt, params.streamVersion],
  );
}

export function buildPricingInventoryInputProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "inventory.item.created": async (event) => {
      const data = event.data as {
        itemId: string;
        accountId: string;
        catalogItemId: string;
        productId: string;
        totalQuantity: number;
        acquisitionCostAmount?: string | null;
      };

      await db.query(
        `INSERT INTO pricing_inventory_item_inputs (
           item_id,
           seller_account_id,
           catalog_catalog_item_id,
           product_id,
           total_quantity,
           acquisition_cost_amount,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (item_id) DO UPDATE
         SET seller_account_id = EXCLUDED.seller_account_id,
             catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             total_quantity = EXCLUDED.total_quantity,
             acquisition_cost_amount = EXCLUDED.acquisition_cost_amount,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE pricing_inventory_item_inputs.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.itemId,
          data.accountId,
          data.catalogItemId,
          data.productId,
          data.totalQuantity,
          data.acquisitionCostAmount ?? null,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "inventory.item.adjusted": async (event) => {
      const data = event.data as {
        itemId: string;
        quantityDelta: number;
      };

      await db.query(
        `UPDATE pricing_inventory_item_inputs
         SET total_quantity = GREATEST(total_quantity + $2, 0),
             updated_at = $3,
             last_stream_version = $4
         WHERE item_id = $1
           AND last_stream_version < $4`,
        [data.itemId, data.quantityDelta, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.placed": async (event) => {
      const data = event.data as {
        holdId: string;
        accountId: string;
        itemId: string;
        quantity: number;
      };

      await db.query(
        `INSERT INTO pricing_inventory_hold_inputs (
           hold_id,
           item_id,
           seller_account_id,
           quantity,
           status,
           released_at,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, 'active', NULL, $5, $6)
         ON CONFLICT (hold_id) DO UPDATE
         SET item_id = EXCLUDED.item_id,
             seller_account_id = EXCLUDED.seller_account_id,
             quantity = EXCLUDED.quantity,
             status = EXCLUDED.status,
             released_at = EXCLUDED.released_at,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE pricing_inventory_hold_inputs.last_stream_version < EXCLUDED.last_stream_version`,
        [data.holdId, data.itemId, data.accountId, data.quantity, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.converted": async (event) => {
      const data = event.data as {
        holdId: string;
      };

      await db.query(
        `UPDATE pricing_inventory_hold_inputs
         SET updated_at = $2,
             last_stream_version = $3
         WHERE hold_id = $1
           AND last_stream_version < $3`,
        [data.holdId, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.extended": async (event) => {
      const data = event.data as {
        holdId: string;
      };

      await db.query(
        `UPDATE pricing_inventory_hold_inputs
         SET updated_at = $2,
             last_stream_version = $3
         WHERE hold_id = $1
           AND last_stream_version < $3`,
        [data.holdId, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.released": async (event) => {
      const data = event.data as {
        holdId: string;
        releasedAt: string;
      };

      await markPricingInventoryHoldTerminal(db, {
        holdId: data.holdId,
        status: "released",
        releasedAt: data.releasedAt,
        recordedAt: event.timing.recordedAt,
        streamVersion: event.streamVersion,
      });
    },
    "inventory.hold.expired": async (event) => {
      const data = event.data as {
        holdId: string;
        expiredAt: string;
      };

      await markPricingInventoryHoldTerminal(db, {
        holdId: data.holdId,
        status: "expired",
        releasedAt: data.expiredAt,
        recordedAt: event.timing.recordedAt,
        streamVersion: event.streamVersion,
      });
    },
  };
}

export function buildPricingMarketplaceInputProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "marketplace.listing.created": async (event) => {
      const data = event.data as {
        listingId: string;
        accountId: string;
        inventoryItemId?: string;
        catalogItemId: string;
        productId: string;
        priceAmount: string;
        quantityCap: number;
      };

      await db.query(
        `INSERT INTO pricing_market_listing_inputs (
           listing_id,
           seller_account_id,
           inventory_item_id,
           catalog_catalog_item_id,
           product_id,
           price_amount,
           quantity_cap,
           status,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9)
         ON CONFLICT (listing_id) DO UPDATE
         SET seller_account_id = EXCLUDED.seller_account_id,
             inventory_item_id = EXCLUDED.inventory_item_id,
             catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             price_amount = EXCLUDED.price_amount,
             quantity_cap = EXCLUDED.quantity_cap,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE pricing_market_listing_inputs.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.listingId,
          data.accountId,
          data.inventoryItemId ?? null,
          data.catalogItemId,
          data.productId,
          data.priceAmount,
          data.quantityCap,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "marketplace.listing.price-updated": async (event) => {
      const data = event.data as { priceAmount: string };

      await db.query(
        `UPDATE pricing_market_listing_inputs
         SET price_amount = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE listing_id = $1
           AND last_stream_version < $4`,
        [
          extractIdFromStreamId(event.streamId, "marketplace.listing-"),
          data.priceAmount,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const data = event.data as { quantityCap: number };

      await db.query(
        `UPDATE pricing_market_listing_inputs
         SET quantity_cap = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE listing_id = $1
           AND last_stream_version < $4`,
        [
          extractIdFromStreamId(event.streamId, "marketplace.listing-"),
          data.quantityCap,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "marketplace.listing.published": async (event) => {
      await db.query(
        `UPDATE pricing_market_listing_inputs
         SET status = 'active',
             updated_at = $2,
             last_stream_version = $3
         WHERE listing_id = $1
           AND last_stream_version < $3`,
        [extractIdFromStreamId(event.streamId, "marketplace.listing-"), event.timing.recordedAt, event.streamVersion],
      );
    },
    "marketplace.listing.paused": async (event) => {
      await db.query(
        `UPDATE pricing_market_listing_inputs
         SET status = 'paused',
             updated_at = $2,
             last_stream_version = $3
         WHERE listing_id = $1
           AND last_stream_version < $3`,
        [extractIdFromStreamId(event.streamId, "marketplace.listing-"), event.timing.recordedAt, event.streamVersion],
      );
    },
    "marketplace.listing.withdrawn": async (event) => {
      await db.query(
        `UPDATE pricing_market_listing_inputs
         SET status = 'withdrawn',
             updated_at = $2,
             last_stream_version = $3
         WHERE listing_id = $1
           AND last_stream_version < $3`,
        [extractIdFromStreamId(event.streamId, "marketplace.listing-"), event.timing.recordedAt, event.streamVersion],
      );
    },
    "marketplace.offer.submitted": async (event) => {
      const data = event.data as {
        offerId: string;
        buyerAccountId: string;
        catalogItemId: string;
        productId: string;
        priceAmount: string;
        quantityRequested: number;
      };

      await db.query(
        `INSERT INTO pricing_buyer_offer_inputs (
           offer_id,
           buyer_account_id,
           seller_account_id,
           catalog_catalog_item_id,
           product_id,
           price_amount,
           quantity_requested,
           status,
           accepted_at,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, NULL, $3, $4, $5, $6, 'submitted', NULL, $7, $8)
         ON CONFLICT (offer_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             price_amount = EXCLUDED.price_amount,
             quantity_requested = EXCLUDED.quantity_requested,
             status = EXCLUDED.status,
             accepted_at = EXCLUDED.accepted_at,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE pricing_buyer_offer_inputs.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.offerId,
          data.buyerAccountId,
          data.catalogItemId,
          data.productId,
          data.priceAmount,
          data.quantityRequested,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "marketplace.offer.accepted": async (event) => {
      const data = event.data as {
        offerId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        catalogItemId: string;
        productId: string;
        priceAmount: string;
        quantityRequested: number;
        acceptedAt: string;
      };

      await db.query(
        `INSERT INTO pricing_buyer_offer_inputs (
           offer_id,
           buyer_account_id,
           seller_account_id,
           catalog_catalog_item_id,
           product_id,
           price_amount,
           quantity_requested,
           status,
           accepted_at,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'accepted', $8, $8, $9)
         ON CONFLICT (offer_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             price_amount = EXCLUDED.price_amount,
             quantity_requested = EXCLUDED.quantity_requested,
             status = EXCLUDED.status,
             accepted_at = EXCLUDED.accepted_at,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE pricing_buyer_offer_inputs.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.offerId,
          data.buyerAccountId,
          data.sellerAccountId,
          data.catalogItemId,
          data.productId,
          data.priceAmount,
          data.quantityRequested,
          data.acceptedAt,
          event.streamVersion,
        ],
      );
    },
  };
}

export function buildPricingOrderingInputProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as {
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        lines: Array<{
          lineId: string;
          catalogItemId: string;
          productId: string;
          unitPriceAmount: string;
          quantity: number;
        }>;
      };

      await db.query(`DELETE FROM pricing_order_signal_lines WHERE order_id = $1`, [data.orderId]);

      for (const line of data.lines) {
        await db.query(
          `INSERT INTO pricing_order_signal_lines (
             order_id,
             line_id,
             buyer_account_id,
             seller_account_id,
             catalog_catalog_item_id,
             product_id,
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
               catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
               product_id = EXCLUDED.product_id,
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
            line.productId,
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

export function buildPricingFulfillmentInputProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.created": async (event) => {
      const data = event.data as {
        shipmentId: string;
        orderId: string;
        lines: Array<{
          lineId: string;
          catalogItemId: string;
          productId: string;
          quantity: number;
        }>;
        createdAt: string;
      };

      await db.query(`DELETE FROM pricing_fulfillment_signal_lines WHERE shipment_id = $1`, [data.shipmentId]);

      for (const line of data.lines) {
        await db.query(
          `INSERT INTO pricing_fulfillment_signal_lines (
             shipment_id,
             line_id,
             order_id,
             catalog_catalog_item_id,
             product_id,
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
               catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
               product_id = EXCLUDED.product_id,
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
            line.productId,
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
