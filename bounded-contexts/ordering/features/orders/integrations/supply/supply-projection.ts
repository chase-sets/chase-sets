import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type AcceptedOfferParams = Readonly<{
  offerId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  catalogItemId: string;
  catalogVersionKey: string;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: readonly { dimensionId: string; choiceId: string }[];
  versionSummary: string | null;
  priceAmount: string;
  quantityRequested: number;
  context: EventStoreContext;
}>;

export function buildOrderingMarketplaceSupplyProjectionHandlers(
  db: PgQueryable,
  options: Readonly<{
    onOfferAccepted?: (params: AcceptedOfferParams) => Promise<void>;
  }> = {},
): ProjectorHandlerMap {
  return {
    "marketplace.listing.created": async (event) => {
      const data = event.data as {
        listingId: string;
        accountId: string;
        inventoryRecordId: string;
        catalogItemId: string;
        catalogVersionKey: string;
        itemTitle: string | null;
        itemSubtitle: string | null;
        versionSelection: unknown;
        versionSummary: string | null;
        storageLocationName: string | null;
        shipFromCode: string | null;
        priceAmount: string;
        quantityCap: number;
      };

      await db.query(
        `INSERT INTO ordering_market_listing_inputs (
           listing_id,
           seller_account_id,
           inventory_record_id,
           catalog_item_id,
           catalog_version_key,
           item_title,
           item_subtitle,
           version_selection,
           version_summary,
           storage_location_name,
           ship_from_code,
           price_amount,
           quantity_cap,
           status,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', $14
         )
         ON CONFLICT (listing_id) DO UPDATE
         SET seller_account_id = EXCLUDED.seller_account_id,
             inventory_record_id = EXCLUDED.inventory_record_id,
             catalog_item_id = EXCLUDED.catalog_item_id,
             catalog_version_key = EXCLUDED.catalog_version_key,
             item_title = EXCLUDED.item_title,
             item_subtitle = EXCLUDED.item_subtitle,
             version_selection = EXCLUDED.version_selection,
             version_summary = EXCLUDED.version_summary,
             storage_location_name = EXCLUDED.storage_location_name,
             ship_from_code = EXCLUDED.ship_from_code,
             price_amount = EXCLUDED.price_amount,
             quantity_cap = EXCLUDED.quantity_cap,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at`,
        [
          data.listingId,
          data.accountId,
          data.inventoryRecordId,
          data.catalogItemId,
          data.catalogVersionKey,
          data.itemTitle,
          data.itemSubtitle,
          JSON.stringify(Array.isArray(data.versionSelection) ? data.versionSelection : []),
          data.versionSummary,
          data.storageLocationName,
          data.shipFromCode,
          data.priceAmount,
          data.quantityCap,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.price-updated": async (event) => {
      const data = event.data as { priceAmount: string };

      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET price_amount = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          data.priceAmount,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const data = event.data as { quantityCap: number };

      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET quantity_cap = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          data.quantityCap,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.published": async (event) => {
      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET status = 'active',
             updated_at = $2
         WHERE listing_id = $1`,
        [event.streamId.replace("marketplace.listing-", ""), event.timing.recordedAt],
      );
    },
    "marketplace.listing.paused": async (event) => {
      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET status = 'paused',
             updated_at = $2
         WHERE listing_id = $1`,
        [event.streamId.replace("marketplace.listing-", ""), event.timing.recordedAt],
      );
    },
    "marketplace.listing.withdrawn": async (event) => {
      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET status = 'withdrawn',
             updated_at = $2
         WHERE listing_id = $1`,
        [event.streamId.replace("marketplace.listing-", ""), event.timing.recordedAt],
      );
    },
    "marketplace.offer.accepted": async (event) => {
      const data = event.data as unknown as Omit<AcceptedOfferParams, "context"> & Readonly<{
        acceptedAt: string;
      }>;

      await db.query(
        `INSERT INTO ordering_offer_acceptance_inputs (
           offer_id,
           buyer_account_id,
           seller_account_id,
           catalog_item_id,
           catalog_version_key,
           item_title,
           item_subtitle,
           version_selection,
           version_summary,
           price_amount,
           quantity_requested,
           accepted_at,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12
         )
         ON CONFLICT (offer_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             catalog_item_id = EXCLUDED.catalog_item_id,
             catalog_version_key = EXCLUDED.catalog_version_key,
             item_title = EXCLUDED.item_title,
             item_subtitle = EXCLUDED.item_subtitle,
             version_selection = EXCLUDED.version_selection,
             version_summary = EXCLUDED.version_summary,
             price_amount = EXCLUDED.price_amount,
             quantity_requested = EXCLUDED.quantity_requested,
             accepted_at = EXCLUDED.accepted_at,
             updated_at = EXCLUDED.updated_at`,
        [
          data.offerId,
          data.buyerAccountId,
          data.sellerAccountId,
          data.catalogItemId,
          data.catalogVersionKey,
          data.itemTitle,
          data.itemSubtitle,
          JSON.stringify(Array.isArray(data.versionSelection) ? data.versionSelection : []),
          data.versionSummary,
          data.priceAmount,
          data.quantityRequested,
          data.acceptedAt,
        ],
      );

      await options.onOfferAccepted?.({
        ...data,
        context: {
          tenantId: event.tenantId,
          audit: event.audit,
          trace: event.trace,
        } as EventStoreContext,
      });
    },
  };
}

export function buildOrderingInventorySupplyProjectionHandlers(
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
        `INSERT INTO ordering_inventory_record_inputs (
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
         WHERE ordering_inventory_record_inputs.last_stream_version < EXCLUDED.last_stream_version`,
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
        `UPDATE ordering_inventory_record_inputs
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
        `INSERT INTO ordering_inventory_hold_inputs (
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
         WHERE ordering_inventory_hold_inputs.last_stream_version < EXCLUDED.last_stream_version`,
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
        `UPDATE ordering_inventory_hold_inputs
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
