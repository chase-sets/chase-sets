import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildMarketplaceListingProjectionHandlers(
  db: PgQueryable,
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
        `INSERT INTO marketplace_listing_pages (
          listing_id,
          account_id,
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
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'draft', $14, $14
        )
        ON CONFLICT (listing_id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
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
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const { priceAmount } = event.data as { priceAmount: string };

      await db.query(
        `UPDATE marketplace_listing_pages
         SET price_amount = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [listingId, priceAmount, event.timing.recordedAt],
      );
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const { quantityCap } = event.data as { quantityCap: number };

      await db.query(
        `UPDATE marketplace_listing_pages
         SET quantity_cap = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [listingId, quantityCap, event.timing.recordedAt],
      );
    },
    "marketplace.listing.published": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");

      await db.query(
        `UPDATE marketplace_listing_pages
         SET status = 'active',
             updated_at = $2
         WHERE listing_id = $1`,
        [listingId, event.timing.recordedAt],
      );
    },
    "marketplace.listing.paused": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");

      await db.query(
        `UPDATE marketplace_listing_pages
         SET status = 'paused',
             updated_at = $2
         WHERE listing_id = $1`,
        [listingId, event.timing.recordedAt],
      );
    },
    "marketplace.listing.withdrawn": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");

      await db.query(
        `UPDATE marketplace_listing_pages
         SET status = 'withdrawn',
             updated_at = $2
         WHERE listing_id = $1`,
        [listingId, event.timing.recordedAt],
      );
    },
  };
}
