import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import {
  refreshAffectedRows,
  transitionStatus,
  updateRow,
  upsertRow,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { recordRealtimeProjectionPatch, type RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import {
  createDiscoveryAccountRemovePatch,
  createDiscoveryAccountUpsertPatch,
  createDiscoveryListingPatch,
  createDiscoveryOfferPatch,
} from "../realtime-support/patches";
import { discoveryRealtimeTopics } from "../realtime-support/topics";
import {
  refreshGoogleShoppingFeedRowForListing,
  type GoogleShoppingIncrementalSyncReason,
} from "../../features/google-shopping-operations/api/feed-row-projection";
import { createMarketplaceSlug, rememberSlugRedirect } from "../runtime-support/slugs";

const ACCOUNT_STREAM_PREFIX = "identity.account-";
const MARKETPLACE_LISTING_STREAM_PREFIX = "marketplace.listing-";
const MARKET_ACCOUNTS_TABLE = "discovery_market_accounts";
const MARKET_LISTINGS_TABLE = "discovery_market_listings";
const OFFER_DEMAND_MATCHES_TABLE = "discovery_offer_demand_matches";
const CHECKOUT_SELL_LIST_STREAM_PREFIX = "checkout.sell-list-";
const MARKET_ACCOUNT_CREATED_COLUMNS = [
  "account_id",
  "seller_slug",
  "seller_display_name",
  "seller_listing_availability_status",
  "status",
  "created_at",
  "updated_at",
] as const;
const MARKET_ACCOUNT_AVAILABILITY_COLUMNS = [
  "account_id",
  "seller_listing_availability_status",
  "seller_listing_availability_reason_category",
  "seller_listing_available_again_on",
  "updated_at",
] as const;
const MARKET_LISTING_CREATED_COLUMNS = [
  "listing_id",
  "listing_slug",
  "product_slug",
  "account_id",
  "inventory_item_id",
  "catalog_catalog_item_id",
  "product_id",
  "item_title",
  "item_subtitle",
  "selected_options",
  "product_summary",
  "product_measure_snapshot",
  "graded_card",
  "storage_location_name",
  "ship_from_code",
  "price_amount",
  "shipping_allowance_percentage_bps",
  "quantity_cap",
  "max_units_per_order",
  "max_units_per_day",
  "max_units_per_customer_account",
  "supply_total_quantity",
  "active_held_quantity",
  "status",
  "created_at",
  "updated_at",
] as const;
const MARKET_LISTING_CREATED_UPDATE_COLUMNS = [
  "listing_slug",
  "product_slug",
  "account_id",
  "inventory_item_id",
  "catalog_catalog_item_id",
  "product_id",
  "item_title",
  "item_subtitle",
  "selected_options",
  "product_summary",
  "product_measure_snapshot",
  "graded_card",
  "storage_location_name",
  "ship_from_code",
  "price_amount",
  "shipping_allowance_percentage_bps",
  "quantity_cap",
  "max_units_per_order",
  "max_units_per_day",
  "max_units_per_customer_account",
  "supply_total_quantity",
  "active_held_quantity",
  "updated_at",
] as const;
const OFFER_DEMAND_MATCH_CREATED_COLUMNS = [
  "offer_id",
  "buyer_account_id",
  "catalog_catalog_item_id",
  "product_id",
  "item_title",
  "item_subtitle",
  "selected_options",
  "product_summary",
  "price_amount",
  "quantity_requested",
  "status",
  "accepted_seller_account_id",
  "accepted_at",
  "created_at",
  "updated_at",
] as const;
const OFFER_DEMAND_MATCH_UPDATE_COLUMNS = [
  "buyer_account_id",
  "catalog_catalog_item_id",
  "product_id",
  "item_title",
  "item_subtitle",
  "selected_options",
  "product_summary",
  "price_amount",
  "quantity_requested",
  "status",
  "accepted_seller_account_id",
  "accepted_at",
  "updated_at",
] as const;

function productMeasureSnapshotFromUnknown(value: unknown) {
  return value && typeof value === "object" ? JSON.stringify(value) : null;
}

function resolveSellListSellerAccountId(event: { streamId: string }, data: { sellerAccountId?: unknown }) {
  if (typeof data.sellerAccountId === "string" && data.sellerAccountId.trim()) {
    return data.sellerAccountId;
  }

  return event.streamId.startsWith(CHECKOUT_SELL_LIST_STREAM_PREFIX)
    ? event.streamId.slice(CHECKOUT_SELL_LIST_STREAM_PREFIX.length)
    : null;
}

async function loadDiscoveryMarketProductMeasureSnapshot(
  db: PgQueryable,
  catalogItemId: string,
  productId: string,
): Promise<string | null> {
  const result = await db.query<{ measure_snapshot: string }>(
    `SELECT measure_snapshot::text AS measure_snapshot
     FROM discovery_market_product_measures
     WHERE catalog_item_id = $1
       AND product_id = $2`,
    [catalogItemId, productId],
  );

  return result.rows[0]?.measure_snapshot ?? null;
}

async function recomputeDiscoveryMarketListingSupply(db: PgQueryable, itemId: string): Promise<string[]> {
  const updated = await db.query<{ listing_id: string }>(
    `UPDATE discovery_market_listings AS listing
     SET supply_total_quantity = supply.total_quantity,
         active_held_quantity = COALESCE(holds.held_quantity, 0)
     FROM discovery_market_supply_items AS supply
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM discovery_market_supply_holds
       WHERE status = 'active'
       GROUP BY item_id
     ) AS holds
       ON holds.item_id = supply.item_id
     WHERE supply.item_id = $1
       AND listing.inventory_item_id = supply.item_id
     RETURNING listing.listing_id`,
    [itemId],
  );

  return updated.rows.map((row) => row.listing_id);
}

async function refreshAvailabilityListingPatches(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  listingIds: readonly string[],
) {
  for (const listingId of listingIds) {
    await refreshGoogleShoppingListing(db, event, listingId, "availability");
    await emitListingPatch(db, event, listingId);
  }
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
    seller_average_rating: string | null;
    seller_review_count: number;
    inventory_item_id: string;
    catalog_catalog_item_id: string;
    catalog_item_slug: string | null;
    product_id: string;
    item_title: string | null;
    item_subtitle: string | null;
    selected_options: unknown;
    product_summary: string | null;
    product_measure_snapshot: unknown | null;
    storage_location_name: string | null;
    ship_from_code: string | null;
    price_amount: string;
    shipping_allowance_percentage_bps: number;
    quantity_cap: number;
    max_units_per_order: number | null;
    max_units_per_day: number | null;
    max_units_per_customer_account: number | null;
    visible_quantity: number;
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
       account.seller_listing_available_again_on::text AS seller_listing_available_again_on,
       account.average_rating_as_seller::text AS seller_average_rating,
       account.review_count_as_seller AS seller_review_count,
       LEAST(
         listing.quantity_cap,
         GREATEST(
           COALESCE(listing.supply_total_quantity, listing.quantity_cap) - COALESCE(listing.active_held_quantity, 0),
           0
         )
       ) AS visible_quantity
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
        selected_options: Array.isArray(row.selected_options) ? row.selected_options : [],
      }
    : null;
}

async function loadRealtimeOffer(db: PgQueryable, offerId: string) {
  const result = await db.query<{
    offer_id: string;
    buyer_account_id: string;
    buyer_slug: string | null;
    buyer_display_name: string | null;
    buyer_average_rating: string | null;
    buyer_review_count: number;
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
       account.seller_slug AS buyer_slug,
       account.seller_display_name AS buyer_display_name,
       account.average_rating_as_buyer::text AS buyer_average_rating,
       account.review_count_as_buyer AS buyer_review_count
     FROM discovery_offer_demand_matches AS offer
     LEFT JOIN discovery_market_accounts AS account
       ON account.account_id = offer.buyer_account_id
     WHERE offer.offer_id = $1`,
    [offerId],
  );
  const row = result.rows[0];

  return row
    ? {
        ...row,
        selected_options: Array.isArray(row.selected_options) ? row.selected_options : [],
      }
    : null;
}

async function loadRealtimeMarketSummary(db: PgQueryable, catalogItemId: string) {
  const result = await db.query<{
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }>(
    `WITH startable_listing AS (
       SELECT
         discovery_market_listings.price_amount,
         LEAST(
           discovery_market_listings.quantity_cap,
           GREATEST(
             COALESCE(discovery_market_listings.supply_total_quantity, discovery_market_listings.quantity_cap) -
               COALESCE(discovery_market_listings.active_held_quantity, 0),
             0
           )
         ) AS visible_quantity
       FROM discovery_market_listings
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = discovery_market_listings.account_id
       WHERE catalog_catalog_item_id = $1
         AND discovery_market_listings.status = 'active'
         AND account.seller_listing_availability_status = 'available'
         AND discovery_market_listings.product_measure_snapshot IS NOT NULL
     )
     SELECT
       MIN(price_amount::numeric)::text AS lowest_price_amount,
       COUNT(*)::integer AS active_listing_count,
       COALESCE(SUM(visible_quantity), 0)::integer AS total_visible_quantity
     FROM startable_listing
     WHERE visible_quantity > 0`,
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
    discoveryRealtimeTopics.account(listing.account_id),
  ];
  const summary = await loadRealtimeMarketSummary(db, listing.catalog_catalog_item_id);

  await emitRealtimeChanges(db, event, `listing:${listingId}`, createDiscoveryListingPatch(topics, listing, summary));
}

async function refreshGoogleShoppingListing(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  listingId: string,
  reason: GoogleShoppingIncrementalSyncReason,
) {
  await refreshGoogleShoppingFeedRowForListing(db, listingId, {
    reason,
    requestedAt: event.timing.recordedAt,
  });
}

async function refreshGoogleShoppingSellerListings(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  accountId: string,
  reason: GoogleShoppingIncrementalSyncReason,
) {
  await refreshAffectedRows(db, {
    select: { column: "listing_id" },
    from: { table: MARKET_LISTINGS_TABLE },
    where: [{ column: "account_id", value: accountId }],
    refresh: (listingId) => refreshGoogleShoppingListing(db, event, listingId, reason),
  });
}

async function emitSellerListingPatches(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  accountId: string,
) {
  await refreshAffectedRows(db, {
    select: { column: "listing_id" },
    from: { table: MARKET_LISTINGS_TABLE },
    where: [
      { column: "account_id", value: accountId },
      { column: "status", value: "active" },
    ],
    refresh: (listingId) => emitListingPatch(db, event, listingId),
  });
}

async function emitOfferPatch(db: PgQueryable, event: Parameters<ProjectorHandlerMap[string]>[0], offerId: string) {
  const offer = await loadRealtimeOffer(db, offerId);
  if (!offer) {
    return;
  }

  await emitRealtimeChanges(
    db,
    event,
    `offer:${offerId}`,
    createDiscoveryOfferPatch(
      [discoveryRealtimeTopics.publicMarket(), discoveryRealtimeTopics.item(offer.catalog_catalog_item_id)],
      offer,
    ),
  );
}

async function markDiscoveryMarketSupplyHoldTerminal(
  db: PgQueryable,
  params: Readonly<{
    holdId: string;
    status: "released" | "expired";
    releasedAt: string;
    recordedAt: string;
    streamVersion: number;
  }>,
): Promise<string | null> {
  const released = await db.query<{ item_id: string }>(
    `UPDATE discovery_market_supply_holds
     SET status = $2,
         released_at = $3,
         updated_at = $4,
         last_stream_version = $5
     WHERE hold_id = $1
       AND last_stream_version < $5
     RETURNING item_id`,
    [params.holdId, params.status, params.releasedAt, params.recordedAt, params.streamVersion],
  );

  return released.rows[0]?.item_id ?? null;
}

async function updateDiscoveryAccountBadges(
  db: PgQueryable,
  accountId: string,
  badgeKey: string,
  assigned: boolean,
  updatedAt: string,
) {
  await db.query(
    `UPDATE discovery_market_accounts
     SET badges = CASE
         WHEN $2 THEN (
           SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
           FROM (
             SELECT DISTINCT value
             FROM jsonb_array_elements_text(discovery_market_accounts.badges || jsonb_build_array($3::text)) AS badge(value)
           ) badges
         )
         ELSE COALESCE(
           (
             SELECT jsonb_agg(value ORDER BY value)
             FROM jsonb_array_elements_text(discovery_market_accounts.badges) AS badge(value)
             WHERE value <> $3
           ),
           '[]'::jsonb
         )
       END,
       updated_at = $4
     WHERE account_id = $1`,
    [accountId, assigned, badgeKey, updatedAt],
  );
}

export function buildDiscoveryMarketProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, displayName } = event.data as {
        accountId: string;
        displayName: string;
      };
      const sellerSlug = createMarketplaceSlug([displayName], accountId);

      await upsertRow(db, {
        table: MARKET_ACCOUNTS_TABLE,
        insertColumns: MARKET_ACCOUNT_CREATED_COLUMNS,
        conflictColumns: ["account_id"],
        // created_at is set once here and excluded from the conflict update so a
        // replayed or redelivered "identity.account.created" event never shifts
        // the public profile's "member since" date (m108, #4268).
        updateColumns: MARKET_ACCOUNT_CREATED_COLUMNS.filter(
          (column) => column !== "account_id" && column !== "created_at",
        ),
        values: {
          account_id: accountId,
          seller_slug: sellerSlug,
          seller_display_name: displayName,
          seller_listing_availability_status: "available",
          status: "active",
          created_at: event.timing.recordedAt,
          updated_at: event.timing.recordedAt,
        },
      });
      await emitRealtimeChanges(
        db,
        event,
        `account:${accountId}`,
        createDiscoveryAccountUpsertPatch(
          [discoveryRealtimeTopics.publicMarket(), discoveryRealtimeTopics.account(accountId)],
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
        entityKind: "account",
        entityId: accountId,
        previousSlug: current.rows[0]?.seller_slug,
        nextSlug: sellerSlug,
        updatedAt: event.timing.recordedAt,
      });
      await emitRealtimeChanges(
        db,
        event,
        `account:${accountId}`,
        createDiscoveryAccountUpsertPatch(
          [discoveryRealtimeTopics.publicMarket(), discoveryRealtimeTopics.account(accountId)],
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
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      await transitionStatus(db, {
        table: MARKET_ACCOUNTS_TABLE,
        idColumn: "account_id",
        id: accountId,
        status: "suspended",
        updatedAt: event.timing.recordedAt,
      });
      await emitRealtimeChanges(
        db,
        event,
        `account:${accountId}`,
        createDiscoveryAccountRemovePatch(
          [discoveryRealtimeTopics.publicMarket(), discoveryRealtimeTopics.account(accountId)],
          accountId,
        ),
      );
    },
    "identity.account.reactivated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      await transitionStatus(db, {
        table: MARKET_ACCOUNTS_TABLE,
        idColumn: "account_id",
        id: accountId,
        status: "active",
        updatedAt: event.timing.recordedAt,
      });
      await emitRealtimeChanges(
        db,
        event,
        `account:${accountId}`,
        createDiscoveryAccountUpsertPatch(
          [discoveryRealtimeTopics.publicMarket(), discoveryRealtimeTopics.account(accountId)],
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
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      await transitionStatus(db, {
        table: MARKET_ACCOUNTS_TABLE,
        idColumn: "account_id",
        id: accountId,
        status: "closed",
        updatedAt: event.timing.recordedAt,
      });
      await emitRealtimeChanges(
        db,
        event,
        `account:${accountId}`,
        createDiscoveryAccountRemovePatch(
          [discoveryRealtimeTopics.publicMarket(), discoveryRealtimeTopics.account(accountId)],
          accountId,
        ),
      );
    },
    // Account badges mirror (m87 badge facts, m108 #4271): the same
    // add/remove-one-value-from-a-jsonb-array upsert marketplace already
    // uses for `marketplace_account_pages.badges`
    // (features/listings/integrations/supply/supply-projection.ts). No
    // realtime patch is emitted for a badge change -- badges change rarely
    // (an operator action, not buyer/seller commerce activity) and the
    // public profile/item-detail already reload on their own realtime
    // topics for other reasons; a fresh page load picks up a badge change.
    "identity.account.badge-assigned": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      const { badgeKey } = event.data as { badgeKey: string };
      await updateDiscoveryAccountBadges(db, accountId, badgeKey, true, event.timing.recordedAt);
    },
    "identity.account.badge-removed": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, ACCOUNT_STREAM_PREFIX);
      const { badgeKey } = event.data as { badgeKey: string };
      await updateDiscoveryAccountBadges(db, accountId, badgeKey, false, event.timing.recordedAt);
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
        productMeasureSnapshot?: unknown;
        gradedCard?: unknown;
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
      const productMeasureSnapshot =
        productMeasureSnapshotFromUnknown(data.productMeasureSnapshot) ??
        (await loadDiscoveryMarketProductMeasureSnapshot(db, data.catalogItemId, data.productId));
      const current = await db.query<{
        listing_slug: string | null;
        product_slug: string | null;
      }>(
        `SELECT listing_slug, product_slug
         FROM discovery_market_listings
         WHERE listing_id = $1`,
        [data.listingId],
      );

      await upsertRow(db, {
        table: MARKET_LISTINGS_TABLE,
        insertColumns: MARKET_LISTING_CREATED_COLUMNS,
        conflictColumns: ["listing_id"],
        updateColumns: MARKET_LISTING_CREATED_UPDATE_COLUMNS,
        values: {
          listing_id: data.listingId,
          listing_slug: listingSlug,
          product_slug: productSlug,
          account_id: data.accountId,
          inventory_item_id: data.inventoryItemId,
          catalog_catalog_item_id: data.catalogItemId,
          product_id: data.productId,
          item_title: data.itemTitle,
          item_subtitle: data.itemSubtitle,
          selected_options: Array.isArray(data.selectedOptions) ? data.selectedOptions : [],
          product_summary: data.productSummary,
          product_measure_snapshot: productMeasureSnapshot,
          graded_card: data.gradedCard && typeof data.gradedCard === "object" ? data.gradedCard : null,
          storage_location_name: data.storageLocationName,
          ship_from_code: data.shipFromCode,
          price_amount: data.priceAmount,
          shipping_allowance_percentage_bps: data.shippingAllowancePercentageBps ?? 500,
          quantity_cap: data.quantityCap,
          max_units_per_order: data.purchaseLimits?.maxUnitsPerOrder ?? null,
          max_units_per_day: data.purchaseLimits?.maxUnitsPerDay ?? null,
          max_units_per_customer_account: data.purchaseLimits?.maxUnitsPerCustomerAccount ?? null,
          supply_total_quantity: null,
          active_held_quantity: null,
          status: "draft",
          created_at: event.timing.recordedAt,
          updated_at: event.timing.recordedAt,
        },
        casts: { selected_options: "jsonb", product_measure_snapshot: "jsonb", graded_card: "jsonb" },
      });
      await recomputeDiscoveryMarketListingSupply(db, data.inventoryItemId);
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
      await refreshGoogleShoppingListing(db, event, data.listingId, "listing-created");
      await emitListingPatch(db, event, data.listingId);
    },
    "catalog.catalog-item.product-measures-resolved": async (event) => {
      const data = event.data as {
        catalogItemId: string;
        products?: unknown;
      };
      const products = JSON.stringify(Array.isArray(data.products) ? data.products : []);

      await db.query(
        `DELETE FROM discovery_market_product_measures
         WHERE catalog_item_id = $1
           AND product_id NOT IN (
             SELECT measure->>'productId'
             FROM jsonb_array_elements($2::jsonb) AS product(measure)
             WHERE COALESCE(measure->>'productId', '') <> ''
           )`,
        [data.catalogItemId, products],
      );
      await db.query(
        `INSERT INTO discovery_market_product_measures (
           catalog_item_id,
           product_id,
           measure_snapshot,
           updated_at
         )
         SELECT $1, measure->>'productId', measure, $3
         FROM jsonb_array_elements($2::jsonb) AS product(measure)
         WHERE COALESCE(measure->>'productId', '') <> ''
         ON CONFLICT (catalog_item_id, product_id) DO UPDATE SET
           measure_snapshot = EXCLUDED.measure_snapshot,
           updated_at = EXCLUDED.updated_at`,
        [data.catalogItemId, products, event.timing.recordedAt],
      );

      const updated = await db.query<{ listing_id: string }>(
        `WITH resolved_products AS (
           SELECT measure
           FROM jsonb_array_elements($2::jsonb) AS product(measure)
         )
         UPDATE discovery_market_listings AS listing
         SET product_measure_snapshot = (
               SELECT measure
               FROM resolved_products
               WHERE measure->>'productId' = listing.product_id
               LIMIT 1
             ),
             updated_at = $3
         WHERE listing.catalog_catalog_item_id = $1
         RETURNING listing.listing_id`,
        [data.catalogItemId, products, event.timing.recordedAt],
      );

      for (const row of updated.rows) {
        await refreshGoogleShoppingListing(db, event, row.listing_id, "catalog");
        await emitListingPatch(db, event, row.listing_id);
      }
    },
    "inventory.storage-location.created": async (event) => {
      const data = event.data as {
        storageLocationId: string;
        accountId: string;
        name: string;
        shipFromCode: string;
        shipFromAddress: unknown;
      };

      await db.query(
        `INSERT INTO discovery_market_supply_locations (
           storage_location_id,
           account_id,
           name,
           ship_from_code,
           ship_from_address,
           is_archived,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, false, $6)
         ON CONFLICT (storage_location_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           name = EXCLUDED.name,
           ship_from_code = EXCLUDED.ship_from_code,
           ship_from_address = EXCLUDED.ship_from_address,
           is_archived = false,
           updated_at = EXCLUDED.updated_at`,
        [
          data.storageLocationId,
          data.accountId,
          data.name,
          data.shipFromCode,
          JSON.stringify(data.shipFromAddress ?? {}),
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.storage-location.updated": async (event) => {
      const data = event.data as {
        storageLocationId: string;
        name: string;
        shipFromCode: string;
        shipFromAddress: unknown;
      };

      await db.query(
        `UPDATE discovery_market_supply_locations
         SET name = $2,
             ship_from_code = $3,
             ship_from_address = $4,
             updated_at = $5
         WHERE storage_location_id = $1`,
        [
          data.storageLocationId,
          data.name,
          data.shipFromCode,
          JSON.stringify(data.shipFromAddress ?? {}),
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.storage-location.archived": async (event) => {
      const data = event.data as { storageLocationId: string };

      await db.query(
        `UPDATE discovery_market_supply_locations
         SET is_archived = true,
             updated_at = $2
         WHERE storage_location_id = $1`,
        [data.storageLocationId, event.timing.recordedAt],
      );
    },
    "inventory.item.created": async (event) => {
      const data = event.data as {
        itemId: string;
        accountId?: string;
        catalogItemId?: string;
        productId?: string;
        selectedOptions?: unknown;
        gradedCard?: unknown;
        storageLocationId?: string;
        totalQuantity: number;
      };

      await db.query(
        `INSERT INTO discovery_market_supply_items (
           item_id,
           account_id,
           catalog_catalog_item_id,
           product_id,
           selected_options,
           graded_card,
           storage_location_id,
           total_quantity,
           last_stream_version,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (item_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
           product_id = EXCLUDED.product_id,
           selected_options = EXCLUDED.selected_options,
           graded_card = EXCLUDED.graded_card,
           storage_location_id = EXCLUDED.storage_location_id,
           total_quantity = EXCLUDED.total_quantity,
           last_stream_version = EXCLUDED.last_stream_version,
           updated_at = EXCLUDED.updated_at
         WHERE discovery_market_supply_items.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.itemId,
          data.accountId ?? null,
          data.catalogItemId ?? null,
          data.productId ?? null,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.gradedCard === null || typeof data.gradedCard !== "object" ? null : JSON.stringify(data.gradedCard),
          data.storageLocationId ?? null,
          data.totalQuantity,
          event.streamVersion,
          event.timing.recordedAt,
        ],
      );

      const listingIds = await recomputeDiscoveryMarketListingSupply(db, data.itemId);
      await refreshAvailabilityListingPatches(db, event, listingIds);
    },
    "inventory.item.adjusted": async (event) => {
      const data = event.data as {
        itemId: string;
        quantityDelta: number;
      };

      await db.query(
        `UPDATE discovery_market_supply_items
         SET total_quantity = total_quantity + $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE item_id = $1
           AND last_stream_version < $4`,
        [data.itemId, data.quantityDelta, event.timing.recordedAt, event.streamVersion],
      );

      const listingIds = await recomputeDiscoveryMarketListingSupply(db, data.itemId);
      await refreshAvailabilityListingPatches(db, event, listingIds);
    },
    "inventory.hold.placed": async (event) => {
      const data = event.data as {
        holdId: string;
        itemId: string;
        quantity: number;
      };

      await db.query(
        `INSERT INTO discovery_market_supply_holds (
           hold_id,
           item_id,
           quantity,
           status,
           released_at,
           last_stream_version,
           updated_at
         ) VALUES ($1, $2, $3, 'active', NULL, $4, $5)
         ON CONFLICT (hold_id) DO UPDATE SET
           item_id = EXCLUDED.item_id,
           quantity = EXCLUDED.quantity,
           status = EXCLUDED.status,
           released_at = EXCLUDED.released_at,
           last_stream_version = EXCLUDED.last_stream_version,
           updated_at = EXCLUDED.updated_at
         WHERE discovery_market_supply_holds.last_stream_version < EXCLUDED.last_stream_version`,
        [data.holdId, data.itemId, data.quantity, event.streamVersion, event.timing.recordedAt],
      );

      const listingIds = await recomputeDiscoveryMarketListingSupply(db, data.itemId);
      await refreshAvailabilityListingPatches(db, event, listingIds);
    },
    "inventory.hold.converted": async (event) => {
      const data = event.data as {
        holdId: string;
      };

      await db.query(
        `UPDATE discovery_market_supply_holds
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
        `UPDATE discovery_market_supply_holds
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

      const itemId = await markDiscoveryMarketSupplyHoldTerminal(db, {
        holdId: data.holdId,
        status: "released",
        releasedAt: data.releasedAt,
        recordedAt: event.timing.recordedAt,
        streamVersion: event.streamVersion,
      });
      if (itemId) {
        const listingIds = await recomputeDiscoveryMarketListingSupply(db, itemId);
        await refreshAvailabilityListingPatches(db, event, listingIds);
      }
    },
    "inventory.hold.expired": async (event) => {
      const data = event.data as {
        holdId: string;
        expiredAt: string;
      };

      const itemId = await markDiscoveryMarketSupplyHoldTerminal(db, {
        holdId: data.holdId,
        status: "expired",
        releasedAt: data.expiredAt,
        recordedAt: event.timing.recordedAt,
        streamVersion: event.streamVersion,
      });
      if (itemId) {
        const listingIds = await recomputeDiscoveryMarketListingSupply(db, itemId);
        await refreshAvailabilityListingPatches(db, event, listingIds);
      }
    },
    "marketplace.listing.price-updated": async (event) => {
      const listingId = extractIdFromStreamId(event.streamId, MARKETPLACE_LISTING_STREAM_PREFIX);
      await db.query(
        `UPDATE discovery_market_listings
         SET price_amount = $2,
             shipping_allowance_percentage_bps = COALESCE($3, shipping_allowance_percentage_bps),
             updated_at = $4
         WHERE listing_id = $1`,
        [
          listingId,
          (event.data as { priceAmount: string }).priceAmount,
          (event.data as { shippingAllowancePercentageBps?: number }).shippingAllowancePercentageBps ?? null,
          event.timing.recordedAt,
        ],
      );
      await refreshGoogleShoppingListing(db, event, listingId, "price");
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const listingId = extractIdFromStreamId(event.streamId, MARKETPLACE_LISTING_STREAM_PREFIX);
      const purchaseLimits = (
        event.data as {
          purchaseLimits?: {
            maxUnitsPerOrder: number | null;
            maxUnitsPerDay: number | null;
            maxUnitsPerCustomerAccount: number | null;
          };
        }
      ).purchaseLimits;
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
          listingId,
          (event.data as { quantityCap: number }).quantityCap,
          (event.data as { shippingAllowancePercentageBps?: number }).shippingAllowancePercentageBps ?? null,
          hasPurchaseLimits,
          purchaseLimits?.maxUnitsPerOrder ?? null,
          purchaseLimits?.maxUnitsPerDay ?? null,
          purchaseLimits?.maxUnitsPerCustomerAccount ?? null,
          event.timing.recordedAt,
        ],
      );
      await refreshGoogleShoppingListing(db, event, listingId, "availability");
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.purchase-limits-updated": async (event) => {
      const listingId = extractIdFromStreamId(event.streamId, MARKETPLACE_LISTING_STREAM_PREFIX);
      const { purchaseLimits } = event.data as {
        purchaseLimits: {
          maxUnitsPerOrder: number | null;
          maxUnitsPerDay: number | null;
          maxUnitsPerCustomerAccount: number | null;
        };
      };
      await updateRow(db, {
        table: MARKET_LISTINGS_TABLE,
        setColumns: ["max_units_per_order", "max_units_per_day", "max_units_per_customer_account", "updated_at"],
        values: {
          max_units_per_order: purchaseLimits.maxUnitsPerOrder,
          max_units_per_day: purchaseLimits.maxUnitsPerDay,
          max_units_per_customer_account: purchaseLimits.maxUnitsPerCustomerAccount,
          updated_at: event.timing.recordedAt,
        },
        where: { columns: ["listing_id"], values: { listing_id: listingId } },
      });
      await refreshGoogleShoppingListing(db, event, listingId, "eligibility");
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.published": async (event) => {
      const listingId = extractIdFromStreamId(event.streamId, MARKETPLACE_LISTING_STREAM_PREFIX);
      await transitionStatus(db, {
        table: MARKET_LISTINGS_TABLE,
        idColumn: "listing_id",
        id: listingId,
        status: "active",
        updatedAt: event.timing.recordedAt,
      });
      await refreshGoogleShoppingListing(db, event, listingId, "visibility");
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.paused": async (event) => {
      const listingId = extractIdFromStreamId(event.streamId, MARKETPLACE_LISTING_STREAM_PREFIX);
      await transitionStatus(db, {
        table: MARKET_LISTINGS_TABLE,
        idColumn: "listing_id",
        id: listingId,
        status: "paused",
        updatedAt: event.timing.recordedAt,
      });
      await refreshGoogleShoppingListing(db, event, listingId, "visibility");
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.auto-unlisted": async (event) => {
      const listingId = extractIdFromStreamId(event.streamId, MARKETPLACE_LISTING_STREAM_PREFIX);
      await transitionStatus(db, {
        table: MARKET_LISTINGS_TABLE,
        idColumn: "listing_id",
        id: listingId,
        status: "paused",
        updatedAt: event.timing.recordedAt,
      });
      await refreshGoogleShoppingListing(db, event, listingId, "visibility");
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.withdrawn": async (event) => {
      const listingId = extractIdFromStreamId(event.streamId, MARKETPLACE_LISTING_STREAM_PREFIX);
      await transitionStatus(db, {
        table: MARKET_LISTINGS_TABLE,
        idColumn: "listing_id",
        id: listingId,
        status: "withdrawn",
        updatedAt: event.timing.recordedAt,
      });
      await refreshGoogleShoppingListing(db, event, listingId, "visibility");
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.seller-listing-availability.disabled": async (event) => {
      const data = event.data as {
        accountId: string;
        reasonCategory: string | null;
        availableAgainOn: string | null;
      };

      await upsertRow(db, {
        table: MARKET_ACCOUNTS_TABLE,
        insertColumns: MARKET_ACCOUNT_AVAILABILITY_COLUMNS,
        conflictColumns: ["account_id"],
        values: {
          account_id: data.accountId,
          seller_listing_availability_status: "unavailable",
          seller_listing_availability_reason_category: data.reasonCategory,
          seller_listing_available_again_on: data.availableAgainOn,
          updated_at: event.timing.recordedAt,
        },
      });
      await refreshGoogleShoppingSellerListings(db, event, data.accountId, "seller-availability");
      await emitSellerListingPatches(db, event, data.accountId);
    },
    "marketplace.seller-listing-availability.enabled": async (event) => {
      const data = event.data as { accountId: string };

      await upsertRow(db, {
        table: MARKET_ACCOUNTS_TABLE,
        insertColumns: MARKET_ACCOUNT_AVAILABILITY_COLUMNS,
        conflictColumns: ["account_id"],
        values: {
          account_id: data.accountId,
          seller_listing_availability_status: "available",
          seller_listing_availability_reason_category: null,
          seller_listing_available_again_on: null,
          updated_at: event.timing.recordedAt,
        },
      });
      await refreshGoogleShoppingSellerListings(db, event, data.accountId, "seller-availability");
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

      await upsertRow(db, {
        table: OFFER_DEMAND_MATCHES_TABLE,
        insertColumns: OFFER_DEMAND_MATCH_CREATED_COLUMNS,
        conflictColumns: ["offer_id"],
        updateColumns: OFFER_DEMAND_MATCH_UPDATE_COLUMNS,
        values: {
          offer_id: data.offerId,
          buyer_account_id: data.buyerAccountId,
          catalog_catalog_item_id: data.catalogItemId,
          product_id: data.productId,
          item_title: data.itemTitle,
          item_subtitle: data.itemSubtitle,
          selected_options: Array.isArray(data.selectedOptions) ? data.selectedOptions : [],
          product_summary: data.productSummary,
          price_amount: data.priceAmount,
          quantity_requested: data.quantityRequested,
          status: "submitted",
          accepted_seller_account_id: null,
          accepted_at: null,
          created_at: event.timing.recordedAt,
          updated_at: event.timing.recordedAt,
        },
        casts: { selected_options: "jsonb" },
      });
      await emitOfferPatch(db, event, data.offerId);
    },
    "marketplace.offer.accepted": async (event) => {
      const data = event.data as {
        offerId: string;
        sellerAccountId: string;
        acceptedAt: string;
      };

      await updateRow(db, {
        table: OFFER_DEMAND_MATCHES_TABLE,
        setColumns: ["status", "accepted_seller_account_id", "accepted_at", "updated_at"],
        values: {
          status: "accepted",
          accepted_seller_account_id: data.sellerAccountId,
          accepted_at: data.acceptedAt,
          updated_at: data.acceptedAt,
        },
        where: { columns: ["offer_id"], values: { offer_id: data.offerId } },
      });
      await db.query(
        `DELETE FROM discovery_item_detail_sell_list_lines
         WHERE seller_account_id = $1
           AND line_type = 'selected-offer'
           AND offer_id = $2`,
        [data.sellerAccountId, data.offerId],
      );
      await emitOfferPatch(db, event, data.offerId);
    },
    "checkout.sell-list.line-added": async (event) => {
      const data = event.data as {
        sellerAccountId: string;
        lineId: string;
        lineType: string;
        offerId: string | null;
        catalogItemId: string;
        productId: string;
        quantity: number;
      };
      const conflictTarget = data.offerId
        ? "(seller_account_id, offer_id) WHERE offer_id IS NOT NULL"
        : "(seller_account_id, line_id)";

      await db.query(
        `INSERT INTO discovery_item_detail_sell_list_lines (
           seller_account_id,
           line_id,
           line_type,
           offer_id,
           catalog_catalog_item_id,
           product_id,
           quantity,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT ${conflictTarget} DO UPDATE
         SET line_id = EXCLUDED.line_id,
             line_type = EXCLUDED.line_type,
             offer_id = EXCLUDED.offer_id,
             catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             quantity = EXCLUDED.quantity,
             updated_at = EXCLUDED.updated_at`,
        [
          data.sellerAccountId,
          data.lineId,
          data.lineType === "selected-offer" ? "selected-offer" : "product",
          data.offerId,
          data.catalogItemId,
          data.productId,
          data.quantity,
          event.timing.recordedAt,
        ],
      );
    },
    "checkout.sell-list.line-quantity-set": async (event) => {
      const data = event.data as { sellerAccountId?: string | null; lineId: string; quantity: number };
      const sellerAccountId = resolveSellListSellerAccountId(event, data);

      if (sellerAccountId) {
        await db.query(
          `UPDATE discovery_item_detail_sell_list_lines
           SET quantity = $3,
               updated_at = $4
           WHERE seller_account_id = $1
             AND line_id = $2`,
          [sellerAccountId, data.lineId, data.quantity, event.timing.recordedAt],
        );
        return;
      }

      await db.query(
        `UPDATE discovery_item_detail_sell_list_lines
         SET quantity = $2,
             updated_at = $3
         WHERE line_id = $1`,
        [data.lineId, data.quantity, event.timing.recordedAt],
      );
    },
    "checkout.sell-list.line-removed": async (event) => {
      const data = event.data as { sellerAccountId?: string | null; lineId: string };
      const sellerAccountId = resolveSellListSellerAccountId(event, data);

      if (sellerAccountId) {
        await db.query(
          `DELETE FROM discovery_item_detail_sell_list_lines
           WHERE seller_account_id = $1
             AND line_id = $2`,
          [sellerAccountId, data.lineId],
        );
        return;
      }

      await db.query(
        `DELETE FROM discovery_item_detail_sell_list_lines
         WHERE line_id = $1`,
        [data.lineId],
      );
    },
    "checkout.sell-list.checkout-confirmed": async (event) => {
      const data = event.data as {
        sellerAccountId: string;
        completedLineIds: string[];
        remainingLineQuantities: readonly { lineId: string; quantity: number }[];
      };

      if (Array.isArray(data.completedLineIds) && data.completedLineIds.length > 0) {
        await db.query(
          `DELETE FROM discovery_item_detail_sell_list_lines
           WHERE seller_account_id = $1
             AND line_id = ANY($2::text[])`,
          [data.sellerAccountId, data.completedLineIds],
        );
      }

      for (const entry of data.remainingLineQuantities) {
        await db.query(
          `UPDATE discovery_item_detail_sell_list_lines
           SET quantity = $3,
               updated_at = $4
           WHERE seller_account_id = $1
             AND line_id = $2`,
          [data.sellerAccountId, entry.lineId, entry.quantity, event.timing.recordedAt],
        );
      }
    },
    "marketplace.review.submitted": async (event) => {
      const data = event.data as {
        reviewId: string;
        authorAccountId: string;
        subjectAccountId: string;
        authorRole: string;
        rating: number;
        feedback: string | null;
        submittedAt: string;
      };

      await db.query(
        `INSERT INTO discovery_market_account_reviews (
           review_id,
           author_account_id,
           subject_account_id,
           author_role,
           rating,
           feedback,
           status,
           submitted_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7)
         ON CONFLICT (review_id) DO UPDATE SET
           author_account_id = EXCLUDED.author_account_id,
           subject_account_id = EXCLUDED.subject_account_id,
           author_role = EXCLUDED.author_role,
           rating = EXCLUDED.rating,
           feedback = EXCLUDED.feedback,
           status = EXCLUDED.status,
           submitted_at = COALESCE(discovery_market_account_reviews.submitted_at, EXCLUDED.submitted_at),
           updated_at = EXCLUDED.updated_at`,
        [
          data.reviewId,
          data.authorAccountId,
          data.subjectAccountId,
          data.authorRole,
          data.rating,
          data.feedback,
          data.submittedAt,
        ],
      );
      await refreshAccountReputation(db, data.subjectAccountId, data.submittedAt);
      await emitAccountReputationPatches(db, event, data.subjectAccountId);
    },
    "marketplace.review.updated": async (event) => {
      const data = event.data as {
        reviewId: string;
        rating: number;
        feedback: string | null;
        updatedAt: string;
      };
      const subjectResult = await updateRow(db, {
        table: "discovery_market_account_reviews",
        setColumns: ["rating", "feedback", "updated_at"],
        values: { rating: data.rating, feedback: data.feedback, updated_at: data.updatedAt },
        where: { columns: ["review_id"], values: { review_id: data.reviewId } },
        returning: ["subject_account_id"],
      });
      const subjectAccountId = subjectResult.rows[0]?.subject_account_id;
      if (typeof subjectAccountId !== "string") {
        return;
      }

      await refreshAccountReputation(db, subjectAccountId, data.updatedAt);
      await emitAccountReputationPatches(db, event, subjectAccountId);
    },
    "marketplace.review.withdrawn": async (event) => {
      const data = event.data as {
        reviewId: string;
        withdrawnAt: string;
      };
      const subjectResult = await transitionStatus(db, {
        table: "discovery_market_account_reviews",
        idColumn: "review_id",
        id: data.reviewId,
        status: "withdrawn",
        updatedAt: data.withdrawnAt,
        returning: ["subject_account_id"],
      });
      const subjectAccountId = subjectResult.rows[0]?.subject_account_id;
      if (typeof subjectAccountId !== "string") {
        return;
      }

      await refreshAccountReputation(db, subjectAccountId, data.withdrawnAt);
      await emitAccountReputationPatches(db, event, subjectAccountId);
    },
    "marketplace.review.revealed": async (event) => {
      const data = event.data as {
        reviewId: string;
        revealedAt: string;
      };
      // Raw SQL (not the updateRow helper): the idempotency guard needs
      // "revealed_at IS NULL", which updateRow's `where` equality cannot
      // express (a NULL-valued `=` comparison never matches in Postgres).
      const subjectResult = await db.query<{ subject_account_id: string }>(
        `UPDATE discovery_market_account_reviews
         SET revealed_at = $2
         WHERE review_id = $1
           AND revealed_at IS NULL
         RETURNING subject_account_id`,
        [data.reviewId, data.revealedAt],
      );
      const subjectAccountId = subjectResult.rows[0]?.subject_account_id;
      if (typeof subjectAccountId !== "string") {
        return;
      }

      await refreshAccountReputation(db, subjectAccountId, data.revealedAt);
      await emitAccountReputationPatches(db, event, subjectAccountId);
    },
    "marketplace.review.feedback-redacted": async (event) => {
      const data = event.data as { reviewId: string; redactedAt: string };

      // No reputation/patch refresh: the rating stands and reputation
      // counters never store feedback text -- only the mirrored row's own
      // display needs updating.
      await db.query(
        `UPDATE discovery_market_account_reviews
         SET feedback = NULL,
             feedback_redacted_at = $2,
             updated_at = $2
         WHERE review_id = $1`,
        [data.reviewId, data.redactedAt],
      );
    },
    "marketplace.review.reply-submitted": async (event) => {
      const data = event.data as {
        reviewId: string;
        replyId: string;
        feedback: string;
        submittedAt: string;
      };

      const updated = await db.query<{ subject_account_id: string }>(
        `UPDATE discovery_market_account_reviews
         SET reply_id = $2,
             reply_feedback = $3,
             reply_status = 'active',
             reply_submitted_at = $4,
             reply_withdrawn_at = NULL,
             updated_at = $4
         WHERE review_id = $1
         RETURNING subject_account_id`,
        [data.reviewId, data.replyId, data.feedback, data.submittedAt],
      );
      const subjectAccountId = updated.rows[0]?.subject_account_id;
      if (subjectAccountId) {
        await emitAccountReputationPatches(db, event, subjectAccountId);
      }
    },
    "marketplace.review.reply-withdrawn": async (event) => {
      const data = event.data as { reviewId: string; withdrawnAt: string };

      const updated = await db.query<{ subject_account_id: string }>(
        `UPDATE discovery_market_account_reviews
         SET reply_status = 'withdrawn',
             reply_withdrawn_at = $2,
             updated_at = $2
         WHERE review_id = $1
         RETURNING subject_account_id`,
        [data.reviewId, data.withdrawnAt],
      );
      const subjectAccountId = updated.rows[0]?.subject_account_id;
      if (subjectAccountId) {
        await emitAccountReputationPatches(db, event, subjectAccountId);
      }
    },
  };
}

// Splits reputation into as-seller (reviews authored by buyers) and as-buyer
// (reviews authored by sellers) dimensions (m108): `discovery_market_account_reviews`
// already stores `author_role` on every row; the fix is aggregating WITH it
// instead of blending both roles into one counter.
async function refreshAccountReputation(db: PgQueryable, accountId: string, updatedAt: string) {
  await db.query(
    `INSERT INTO discovery_market_accounts (
       account_id,
       average_rating_as_seller,
       review_count_as_seller,
       rating_1_count_as_seller,
       rating_2_count_as_seller,
       rating_3_count_as_seller,
       rating_4_count_as_seller,
       rating_5_count_as_seller,
       average_rating_as_buyer,
       review_count_as_buyer,
       rating_1_count_as_buyer,
       rating_2_count_as_buyer,
       rating_3_count_as_buyer,
       rating_4_count_as_buyer,
       rating_5_count_as_buyer,
       reputation_updated_at,
       updated_at
     )
     SELECT
       $1,
       CASE
         WHEN COUNT(*) FILTER (WHERE author_role = 'buyer') = 0 THEN NULL
         ELSE ROUND(AVG(rating) FILTER (WHERE author_role = 'buyer')::numeric, 2)
       END,
       COUNT(*) FILTER (WHERE author_role = 'buyer')::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating = 1)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating = 2)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating = 3)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating = 4)::integer,
       COUNT(*) FILTER (WHERE author_role = 'buyer' AND rating = 5)::integer,
       CASE
         WHEN COUNT(*) FILTER (WHERE author_role = 'seller') = 0 THEN NULL
         ELSE ROUND(AVG(rating) FILTER (WHERE author_role = 'seller')::numeric, 2)
       END,
       COUNT(*) FILTER (WHERE author_role = 'seller')::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating = 1)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating = 2)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating = 3)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating = 4)::integer,
       COUNT(*) FILTER (WHERE author_role = 'seller' AND rating = 5)::integer,
       $2,
       $2
     FROM discovery_market_account_reviews
     WHERE subject_account_id = $1
       AND status = 'active'
       AND revealed_at IS NOT NULL
     ON CONFLICT (account_id) DO UPDATE SET
       average_rating_as_seller = EXCLUDED.average_rating_as_seller,
       review_count_as_seller = EXCLUDED.review_count_as_seller,
       rating_1_count_as_seller = EXCLUDED.rating_1_count_as_seller,
       rating_2_count_as_seller = EXCLUDED.rating_2_count_as_seller,
       rating_3_count_as_seller = EXCLUDED.rating_3_count_as_seller,
       rating_4_count_as_seller = EXCLUDED.rating_4_count_as_seller,
       rating_5_count_as_seller = EXCLUDED.rating_5_count_as_seller,
       average_rating_as_buyer = EXCLUDED.average_rating_as_buyer,
       review_count_as_buyer = EXCLUDED.review_count_as_buyer,
       rating_1_count_as_buyer = EXCLUDED.rating_1_count_as_buyer,
       rating_2_count_as_buyer = EXCLUDED.rating_2_count_as_buyer,
       rating_3_count_as_buyer = EXCLUDED.rating_3_count_as_buyer,
       rating_4_count_as_buyer = EXCLUDED.rating_4_count_as_buyer,
       rating_5_count_as_buyer = EXCLUDED.rating_5_count_as_buyer,
       reputation_updated_at = EXCLUDED.reputation_updated_at,
       updated_at = EXCLUDED.updated_at`,
    [accountId, updatedAt],
  );
}

async function emitAccountReputationPatches(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  accountId: string,
) {
  await emitSellerListingPatches(db, event, accountId);

  await refreshAffectedRows(db, {
    select: { column: "offer_id" },
    from: { table: OFFER_DEMAND_MATCHES_TABLE },
    where: [
      { column: "buyer_account_id", value: accountId },
      { column: "status", value: "submitted" },
    ],
    refresh: (offerId) => emitOfferPatch(db, event, offerId),
  });
}
