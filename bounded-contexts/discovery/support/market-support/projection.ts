import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  recordRealtimeProjectionPatch,
  type RealtimeProjectionPatch,
} from "@chase-sets/platform-runtime/realtime";
import {
  createDiscoveryListingPatch,
  createDiscoveryOfferPatch,
  createDiscoverySellerRemovePatch,
  createDiscoverySellerUpsertPatch,
} from "../realtime-support/patches";
import { discoveryRealtimeTopics } from "../realtime-support/topics";
import {
  createMarketplaceSlug,
  rememberSlugRedirect,
} from "../runtime-support/slugs";

const ACCOUNT_STREAM_PREFIX = "identity.account-";
const MARKETPLACE_LISTING_STREAM_PREFIX = "marketplace.listing-";

function extractIdFromStreamId(streamId: string, prefix: string): string {
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Stream ID "${streamId}" does not start with prefix "${prefix}".`);
  }

  return streamId.slice(prefix.length);
}

async function loadRealtimeListing(db: PgQueryable, listingId: string) {
  const result = await db.query<{
    listing_id: string;
    listing_slug: string;
    product_slug: string;
    account_id: string;
    seller_slug: string | null;
    seller_display_name: string | null;
    seller_listing_availability_status: "available" | "unavailable";
    seller_listing_availability_reason_category: string | null;
    seller_listing_available_again_on: string | null;
    inventory_item_id: string;
    catalog_catalog_item_id: string;
    catalog_item_slug: string | null;
    product_id: string;
    item_title: string | null;
    item_subtitle: string | null;
    selected_options: unknown;
    product_summary: string | null;
    storage_location_name: string | null;
    ship_from_code: string | null;
    price_amount: string;
    shipping_allowance_percentage_bps: number;
    quantity_cap: number;
    max_units_per_order: number | null;
    max_units_per_day: number | null;
    max_units_per_customer_account: number | null;
    status: string;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT
       listing.*,
       item.slug AS catalog_item_slug,
       account.seller_slug,
       account.seller_display_name,
       account.seller_listing_availability_status,
       account.seller_listing_availability_reason_category,
       account.seller_listing_available_again_on::text AS seller_listing_available_again_on
     FROM discovery_market_listings AS listing
     LEFT JOIN discovery_market_accounts AS account
       ON account.account_id = listing.account_id
     LEFT JOIN discovery_item_detail_pages AS item
       ON item.catalog_item_id = listing.catalog_catalog_item_id
     WHERE listing.listing_id = $1`,
    [listingId],
  );
  const row = result.rows[0];

  return row
    ? {
        ...row,
        selected_options: Array.isArray(row.selected_options)
          ? row.selected_options
          : [],
      }
    : null;
}

async function loadRealtimeOffer(db: PgQueryable, offerId: string) {
  const result = await db.query<{
    offer_id: string;
    buyer_account_id: string;
    buyer_display_name: string | null;
    catalog_catalog_item_id: string;
    product_id: string;
    item_title: string;
    item_subtitle: string | null;
    selected_options: unknown;
    product_summary: string | null;
    price_amount: string;
    quantity_requested: number;
    status: string;
    accepted_seller_account_id: string | null;
    accepted_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT
       offer.*,
       account.seller_display_name AS buyer_display_name
     FROM discovery_buyer_offer_matches AS offer
     LEFT JOIN discovery_market_accounts AS account
       ON account.account_id = offer.buyer_account_id
     WHERE offer.offer_id = $1`,
    [offerId],
  );
  const row = result.rows[0];

  return row
    ? {
        ...row,
        selected_options: Array.isArray(row.selected_options)
          ? row.selected_options
          : [],
      }
    : null;
}

async function loadRealtimeMarketSummary(db: PgQueryable, catalogItemId: string) {
  const result = await db.query<{
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }>(
    `SELECT
       MIN(price_amount)::text AS lowest_price_amount,
       COUNT(*)::integer AS active_listing_count,
       COALESCE(SUM(quantity_cap), 0)::integer AS total_visible_quantity
     FROM discovery_market_listings
     INNER JOIN discovery_market_accounts AS account
       ON account.account_id = discovery_market_listings.account_id
     WHERE catalog_catalog_item_id = $1
       AND discovery_market_listings.status = 'active'
       AND account.seller_listing_availability_status = 'available'`,
    [catalogItemId],
  );
  const row = result.rows[0];

  return row && row.active_listing_count > 0
    ? row
    : {
        lowest_price_amount: null,
        active_listing_count: 0,
        total_visible_quantity: 0,
      };
}

async function emitRealtimeChanges(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  patchKey: string,
  patch: RealtimeProjectionPatch,
) {
  await recordRealtimeProjectionPatch(db, {
    sourceGlobalPosition: event.globalPosition,
    projectionName: "discovery-market-projection",
    patchKey,
    topics: patch.topics,
    recordedAt: event.timing.recordedAt,
    patch,
  });
}

async function emitListingPatch(db: PgQueryable, event: Parameters<ProjectorHandlerMap[string]>[0], listingId: string) {
  const listing = await loadRealtimeListing(db, listingId);
  if (!listing) {
    return;
  }

  const topics = [
    discoveryRealtimeTopics.publicMarket(),
    discoveryRealtimeTopics.item(listing.catalog_catalog_item_id),
    discoveryRealtimeTopics.listing(listing.listing_id),
    discoveryRealtimeTopics.seller(listing.account_id),
  ];
  const summary = await loadRealtimeMarketSummary(
    db,
    listing.catalog_catalog_item_id,
  );

  await emitRealtimeChanges(
    db,
    event,
    `listing:${listingId}`,
    createDiscoveryListingPatch(topics, listing, summary),
  );
}

async function emitSellerListingPatches(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  accountId: string,
) {
  const result = await db.query<{ listing_id: string }>(
    `SELECT listing_id
     FROM discovery_market_listings
     WHERE account_id = $1
       AND status = 'active'`,
    [accountId],
  );

  await Promise.all(
    result.rows.map((row) => emitListingPatch(db, event, row.listing_id)),
  );
}

async function emitOfferPatch(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  offerId: string,
) {
  const offer = await loadRealtimeOffer(db, offerId);
  if (!offer) {
    return;
  }

  await emitRealtimeChanges(
    db,
    event,
    `offer:${offerId}`,
    createDiscoveryOfferPatch(
      [
        discoveryRealtimeTopics.publicMarket(),
        discoveryRealtimeTopics.item(offer.catalog_catalog_item_id),
      ],
      offer,
    ),
  );
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
          seller_listing_availability_status,
          status,
          updated_at
        ) VALUES ($1, $2, $3, 'available', 'active', $4)
        ON CONFLICT (account_id) DO UPDATE SET
            seller_slug = EXCLUDED.seller_slug,
            seller_display_name = EXCLUDED.seller_display_name,
            seller_listing_availability_status = EXCLUDED.seller_listing_availability_status,
            status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at`,
        [accountId, sellerSlug, displayName, event.timing.recordedAt],
      );
      await emitRealtimeChanges(
        db,
        event,
        `seller:${accountId}`,
        createDiscoverySellerUpsertPatch(
          [
            discoveryRealtimeTopics.publicMarket(),
            discoveryRealtimeTopics.seller(accountId),
          ],
          {
            account_id: accountId,
            seller_slug: sellerSlug,
            seller_display_name: displayName,
            status: "active",
            updated_at: event.timing.recordedAt,
          },
          accountId,
        ),
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
            seller_listing_availability_status,
            updated_at
        ) VALUES ($1, $2, $3, 'available', $4)
        ON CONFLICT (account_id) DO UPDATE SET
          seller_slug = EXCLUDED.seller_slug,
          seller_display_name = EXCLUDED.seller_display_name,
          seller_listing_availability_status = COALESCE(discovery_market_accounts.seller_listing_availability_status, EXCLUDED.seller_listing_availability_status),
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
      await emitRealtimeChanges(
        db,
        event,
        `seller:${accountId}`,
        createDiscoverySellerUpsertPatch(
          [
            discoveryRealtimeTopics.publicMarket(),
            discoveryRealtimeTopics.seller(accountId),
          ],
          {
            account_id: accountId,
            seller_slug: sellerSlug,
            seller_display_name: displayName,
            status: "active",
            updated_at: event.timing.recordedAt,
          },
          accountId,
        ),
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
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      await emitRealtimeChanges(
        db,
        event,
        `seller:${accountId}`,
        createDiscoverySellerRemovePatch(
          [
            discoveryRealtimeTopics.publicMarket(),
            discoveryRealtimeTopics.seller(accountId),
          ],
          accountId,
        ),
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
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      await emitRealtimeChanges(
        db,
        event,
        `seller:${accountId}`,
        createDiscoverySellerUpsertPatch(
          [
            discoveryRealtimeTopics.publicMarket(),
            discoveryRealtimeTopics.seller(accountId),
          ],
          {
            account_id: accountId,
            status: "active",
            updated_at: event.timing.recordedAt,
          },
          accountId,
        ),
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
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      await emitRealtimeChanges(
        db,
        event,
        `seller:${accountId}`,
        createDiscoverySellerRemovePatch(
          [
            discoveryRealtimeTopics.publicMarket(),
            discoveryRealtimeTopics.seller(accountId),
          ],
          accountId,
        ),
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
        shippingAllowancePercentageBps?: number;
        quantityCap: number;
        purchaseLimits?: {
          maxUnitsPerOrder: number | null;
          maxUnitsPerDay: number | null;
          maxUnitsPerCustomerAccount: number | null;
        };
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
          shipping_allowance_percentage_bps,
          quantity_cap,
          max_units_per_order,
          max_units_per_day,
          max_units_per_customer_account,
          status,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'draft', $20, $20
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
          shipping_allowance_percentage_bps = EXCLUDED.shipping_allowance_percentage_bps,
          quantity_cap = EXCLUDED.quantity_cap,
          max_units_per_order = EXCLUDED.max_units_per_order,
          max_units_per_day = EXCLUDED.max_units_per_day,
          max_units_per_customer_account = EXCLUDED.max_units_per_customer_account,
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
          data.shippingAllowancePercentageBps ?? 500,
          data.quantityCap,
          data.purchaseLimits?.maxUnitsPerOrder ?? null,
          data.purchaseLimits?.maxUnitsPerDay ?? null,
          data.purchaseLimits?.maxUnitsPerCustomerAccount ?? null,
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
      await emitListingPatch(db, event, data.listingId);
    },
    "marketplace.listing.price-updated": async (event) => {
      await db.query(
        `UPDATE discovery_market_listings
         SET price_amount = $2,
             shipping_allowance_percentage_bps = COALESCE($3, shipping_allowance_percentage_bps),
             updated_at = $4
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          (event.data as { priceAmount: string }).priceAmount,
          (event.data as { shippingAllowancePercentageBps?: number }).shippingAllowancePercentageBps ?? null,
          event.timing.recordedAt,
        ],
      );
      await emitListingPatch(db, event, event.streamId.replace(MARKETPLACE_LISTING_STREAM_PREFIX, ""));
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const purchaseLimits = (event.data as {
        purchaseLimits?: {
          maxUnitsPerOrder: number | null;
          maxUnitsPerDay: number | null;
          maxUnitsPerCustomerAccount: number | null;
        };
      }).purchaseLimits;
      const hasPurchaseLimits = purchaseLimits !== undefined;
      await db.query(
        `UPDATE discovery_market_listings
         SET quantity_cap = $2,
             shipping_allowance_percentage_bps = COALESCE($3, shipping_allowance_percentage_bps),
             max_units_per_order = CASE WHEN $4 THEN $5 ELSE max_units_per_order END,
             max_units_per_day = CASE WHEN $4 THEN $6 ELSE max_units_per_day END,
             max_units_per_customer_account = CASE WHEN $4 THEN $7 ELSE max_units_per_customer_account END,
             updated_at = $8
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          (event.data as { quantityCap: number }).quantityCap,
          (event.data as { shippingAllowancePercentageBps?: number }).shippingAllowancePercentageBps ?? null,
          hasPurchaseLimits,
          purchaseLimits?.maxUnitsPerOrder ?? null,
          purchaseLimits?.maxUnitsPerDay ?? null,
          purchaseLimits?.maxUnitsPerCustomerAccount ?? null,
          event.timing.recordedAt,
        ],
      );
      await emitListingPatch(db, event, event.streamId.replace(MARKETPLACE_LISTING_STREAM_PREFIX, ""));
    },
    "marketplace.listing.purchase-limits-updated": async (event) => {
      const { purchaseLimits } = event.data as {
        purchaseLimits: {
          maxUnitsPerOrder: number | null;
          maxUnitsPerDay: number | null;
          maxUnitsPerCustomerAccount: number | null;
        };
      };
      await db.query(
        `UPDATE discovery_market_listings
         SET max_units_per_order = $2,
             max_units_per_day = $3,
             max_units_per_customer_account = $4,
             updated_at = $5
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          purchaseLimits.maxUnitsPerOrder,
          purchaseLimits.maxUnitsPerDay,
          purchaseLimits.maxUnitsPerCustomerAccount,
          event.timing.recordedAt,
        ],
      );
      await emitListingPatch(db, event, event.streamId.replace(MARKETPLACE_LISTING_STREAM_PREFIX, ""));
    },
    "marketplace.listing.published": async (event) => {
      await db.query(
        `UPDATE discovery_market_listings
         SET status = 'active',
             updated_at = $2
         WHERE listing_id = $1`,
        [event.streamId.replace("marketplace.listing-", ""), event.timing.recordedAt],
      );
      await emitListingPatch(db, event, event.streamId.replace(MARKETPLACE_LISTING_STREAM_PREFIX, ""));
    },
    "marketplace.listing.paused": async (event) => {
      await db.query(
        `UPDATE discovery_market_listings
         SET status = 'paused',
             updated_at = $2
         WHERE listing_id = $1`,
        [event.streamId.replace("marketplace.listing-", ""), event.timing.recordedAt],
      );
      await emitListingPatch(db, event, event.streamId.replace(MARKETPLACE_LISTING_STREAM_PREFIX, ""));
    },
    "marketplace.listing.withdrawn": async (event) => {
      await db.query(
        `UPDATE discovery_market_listings
         SET status = 'withdrawn',
             updated_at = $2
         WHERE listing_id = $1`,
        [event.streamId.replace("marketplace.listing-", ""), event.timing.recordedAt],
      );
      await emitListingPatch(db, event, event.streamId.replace(MARKETPLACE_LISTING_STREAM_PREFIX, ""));
    },
    "marketplace.seller-listing-availability.disabled": async (event) => {
      const data = event.data as {
        accountId: string;
        reasonCategory: string | null;
        availableAgainOn: string | null;
      };

      await db.query(
        `INSERT INTO discovery_market_accounts (
           account_id,
           seller_listing_availability_status,
           seller_listing_availability_reason_category,
           seller_listing_available_again_on,
           updated_at
         ) VALUES ($1, 'unavailable', $2, $3, $4)
         ON CONFLICT (account_id) DO UPDATE SET
           seller_listing_availability_status = EXCLUDED.seller_listing_availability_status,
           seller_listing_availability_reason_category = EXCLUDED.seller_listing_availability_reason_category,
           seller_listing_available_again_on = EXCLUDED.seller_listing_available_again_on,
           updated_at = EXCLUDED.updated_at`,
        [
          data.accountId,
          data.reasonCategory,
          data.availableAgainOn,
          event.timing.recordedAt,
        ],
      );
      await emitSellerListingPatches(db, event, data.accountId);
    },
    "marketplace.seller-listing-availability.enabled": async (event) => {
      const data = event.data as { accountId: string };

      await db.query(
        `INSERT INTO discovery_market_accounts (
           account_id,
           seller_listing_availability_status,
           seller_listing_availability_reason_category,
           seller_listing_available_again_on,
           updated_at
         ) VALUES ($1, 'available', NULL, NULL, $2)
         ON CONFLICT (account_id) DO UPDATE SET
           seller_listing_availability_status = EXCLUDED.seller_listing_availability_status,
           seller_listing_availability_reason_category = EXCLUDED.seller_listing_availability_reason_category,
           seller_listing_available_again_on = EXCLUDED.seller_listing_available_again_on,
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, event.timing.recordedAt],
      );
      await emitSellerListingPatches(db, event, data.accountId);
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
      await emitOfferPatch(db, event, data.offerId);
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
      await emitOfferPatch(db, event, data.offerId);
    },
  };
}
