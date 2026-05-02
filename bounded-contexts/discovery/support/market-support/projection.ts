import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createMarketplaceSlug,
  rememberSlugRedirect,
} from "../runtime-support/slugs";

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
      const sellerSlug = createMarketplaceSlug([displayName], accountId);

      await db.query(
        `INSERT INTO discovery_market_accounts (
          account_id,
          seller_slug,
          seller_display_name,
          status,
          updated_at
        ) VALUES ($1, $2, $3, 'active', $4)
        ON CONFLICT (account_id) DO UPDATE SET
          seller_slug = EXCLUDED.seller_slug,
          seller_display_name = EXCLUDED.seller_display_name,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at`,
        [accountId, sellerSlug, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.profile-updated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      const { displayName } = event.data as { displayName: string };
      const sellerSlug = createMarketplaceSlug([displayName], accountId);
      const current = await db.query<{ seller_slug: string | null }>(
        `SELECT seller_slug FROM discovery_market_accounts WHERE account_id = $1`,
        [accountId],
      );

      await db.query(
        `INSERT INTO discovery_market_accounts (
          account_id,
          seller_slug,
          seller_display_name,
          updated_at
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (account_id) DO UPDATE SET
          seller_slug = EXCLUDED.seller_slug,
          seller_display_name = EXCLUDED.seller_display_name,
          updated_at = EXCLUDED.updated_at`,
        [accountId, sellerSlug, displayName, event.timing.recordedAt],
      );
      await rememberSlugRedirect(db, {
        entityKind: "seller",
        entityId: accountId,
        previousSlug: current.rows[0]?.seller_slug,
        nextSlug: sellerSlug,
        updatedAt: event.timing.recordedAt,
      });
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
        inventoryItemId: string;
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
      const listingSlug = createMarketplaceSlug(
        [data.itemTitle, data.itemSubtitle, data.productSummary],
        data.listingId,
      );
      const productSlug = createMarketplaceSlug(
        [data.itemTitle, data.itemSubtitle, data.productSummary],
        data.productId,
      );
      const current = await db.query<{
        listing_slug: string | null;
        product_slug: string | null;
      }>(
        `SELECT listing_slug, product_slug
         FROM discovery_market_listings
         WHERE listing_id = $1`,
        [data.listingId],
      );

      await db.query(
        `INSERT INTO discovery_market_listings (
          listing_id,
          listing_slug,
          product_slug,
          account_id,
          inventory_item_id,
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
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'draft', $16, $16
        )
        ON CONFLICT (listing_id) DO UPDATE SET
          listing_slug = EXCLUDED.listing_slug,
          product_slug = EXCLUDED.product_slug,
          account_id = EXCLUDED.account_id,
          inventory_item_id = EXCLUDED.inventory_item_id,
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
          listingSlug,
          productSlug,
          data.accountId,
          data.inventoryItemId,
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
      await rememberSlugRedirect(db, {
        entityKind: "listing",
        entityId: data.listingId,
        previousSlug: current.rows[0]?.listing_slug,
        nextSlug: listingSlug,
        updatedAt: event.timing.recordedAt,
      });
      await rememberSlugRedirect(db, {
        entityKind: "product",
        entityId: data.productId,
        previousSlug: current.rows[0]?.product_slug,
        nextSlug: productSlug,
        updatedAt: event.timing.recordedAt,
      });
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
    "marketplace.offer.submitted": async (event) => {
      const data = event.data as {
        offerId: string;
        buyerAccountId: string;
        catalogItemId: string;
        productId: string;
        itemTitle: string;
        itemSubtitle: string | null;
        selectedOptions: unknown;
        productSummary: string | null;
        priceAmount: string;
        quantityRequested: number;
      };

      await db.query(
        `INSERT INTO discovery_buyer_offer_matches (
          offer_id,
          buyer_account_id,
          catalog_catalog_item_id,
          product_id,
          item_title,
          item_subtitle,
          selected_options,
          product_summary,
          price_amount,
          quantity_requested,
          status,
          accepted_seller_account_id,
          accepted_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'submitted', NULL, NULL, $11, $11
        )
        ON CONFLICT (offer_id) DO UPDATE SET
          buyer_account_id = EXCLUDED.buyer_account_id,
          catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
          product_id = EXCLUDED.product_id,
          item_title = EXCLUDED.item_title,
          item_subtitle = EXCLUDED.item_subtitle,
          selected_options = EXCLUDED.selected_options,
          product_summary = EXCLUDED.product_summary,
          price_amount = EXCLUDED.price_amount,
          quantity_requested = EXCLUDED.quantity_requested,
          status = EXCLUDED.status,
          accepted_seller_account_id = EXCLUDED.accepted_seller_account_id,
          accepted_at = EXCLUDED.accepted_at,
          updated_at = EXCLUDED.updated_at`,
        [
          data.offerId,
          data.buyerAccountId,
          data.catalogItemId,
          data.productId,
          data.itemTitle,
          data.itemSubtitle,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.productSummary,
          data.priceAmount,
          data.quantityRequested,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.offer.accepted": async (event) => {
      const data = event.data as {
        offerId: string;
        sellerAccountId: string;
        acceptedAt: string;
      };

      await db.query(
        `UPDATE discovery_buyer_offer_matches
         SET status = 'accepted',
             accepted_seller_account_id = $2,
             accepted_at = $3,
             updated_at = $3
         WHERE offer_id = $1`,
        [data.offerId, data.sellerAccountId, data.acceptedAt],
      );
    },
  };
}
