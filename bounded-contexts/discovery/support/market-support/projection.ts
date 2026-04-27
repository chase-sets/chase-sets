import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const ACCOUNT_STREAM_PREFIX = "identity.account-";

function extractIdFromStreamId(streamId: string, prefix: string): string {
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Stream ID "${streamId}" does not start with prefix "${prefix}".`);
  }

  return streamId.slice(prefix.length);
}

export function buildDiscoveryMarketProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, displayName } = event.data as {
        accountId: string;
        displayName: string;
      };

      await db.query(
        `INSERT INTO discovery_market_accounts (
          account_id,
          seller_display_name,
          status,
          updated_at
        ) VALUES ($1, $2, 'active', $3)
        ON CONFLICT (account_id) DO UPDATE SET
          seller_display_name = EXCLUDED.seller_display_name,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at`,
        [accountId, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.profile-updated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      const { displayName } = event.data as { displayName: string };

      await db.query(
        `INSERT INTO discovery_market_accounts (
          account_id,
          seller_display_name,
          updated_at
        ) VALUES ($1, $2, $3)
        ON CONFLICT (account_id) DO UPDATE SET
          seller_display_name = EXCLUDED.seller_display_name,
          updated_at = EXCLUDED.updated_at`,
        [accountId, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.suspended": async (event) => {
      await db.query(
        `UPDATE discovery_market_accounts
         SET status = 'suspended',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX), event.timing.recordedAt],
      );
    },
    "identity.account.reactivated": async (event) => {
      await db.query(
        `UPDATE discovery_market_accounts
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX), event.timing.recordedAt],
      );
    },
    "identity.account.closed": async (event) => {
      await db.query(
        `UPDATE discovery_market_accounts
         SET status = 'closed',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX), event.timing.recordedAt],
      );
    },
    "marketplace.listing.created": async (event) => {
      const data = event.data as {
        listingId: string;
        accountId: string;
        inventoryRecordId: string;
        catalogItemId: string;
        productId: string;
        itemTitle: string | null;
        itemSubtitle: string | null;
        selectedOptions: unknown;
        productSummary: string | null;
        storageLocationName: string | null;
        shipFromCode: string | null;
        priceAmount: string;
        quantityCap: number;
      };

      await db.query(
        `INSERT INTO discovery_market_listings (
          listing_id,
          account_id,
          inventory_record_id,
          catalog_catalog_item_id,
          product_id,
          item_title,
          item_subtitle,
          selected_options,
          product_summary,
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
          catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
          product_id = EXCLUDED.product_id,
          item_title = EXCLUDED.item_title,
          item_subtitle = EXCLUDED.item_subtitle,
          selected_options = EXCLUDED.selected_options,
          product_summary = EXCLUDED.product_summary,
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
          data.productId,
          data.itemTitle,
          data.itemSubtitle,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.productSummary,
          data.storageLocationName,
          data.shipFromCode,
          data.priceAmount,
          data.quantityCap,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.price-updated": async (event) => {
      await db.query(
        `UPDATE discovery_market_listings
         SET price_amount = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          (event.data as { priceAmount: string }).priceAmount,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      await db.query(
        `UPDATE discovery_market_listings
         SET quantity_cap = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          (event.data as { quantityCap: number }).quantityCap,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.published": async (event) => {
      await db.query(
        `UPDATE discovery_market_listings
         SET status = 'active',
             updated_at = $2
         WHERE listing_id = $1`,
        [event.streamId.replace("marketplace.listing-", ""), event.timing.recordedAt],
      );
    },
    "marketplace.listing.paused": async (event) => {
      await db.query(
        `UPDATE discovery_market_listings
         SET status = 'paused',
             updated_at = $2
         WHERE listing_id = $1`,
        [event.streamId.replace("marketplace.listing-", ""), event.timing.recordedAt],
      );
    },
    "marketplace.listing.withdrawn": async (event) => {
      await db.query(
        `UPDATE discovery_market_listings
         SET status = 'withdrawn',
             updated_at = $2
         WHERE listing_id = $1`,
        [event.streamId.replace("marketplace.listing-", ""), event.timing.recordedAt],
      );
    },
  };
}
