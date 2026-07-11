import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { DiscoverySitemapEntityCounts, DiscoverySitemapEntityKind } from "../client-support/contracts";
import { buyerVisibleListingPredicateSql, buyerVisibleListingQuantitySql } from "./listing-visibility";

export type DiscoveryPublicListingRow = Readonly<{
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
  google_shopping_structured_data_payload: unknown | null;
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
  visible_quantity: number;
  created_at: string;
  updated_at: string;
}>;

type DiscoveryPublicListingDbRow = DiscoveryPublicListingRow &
  Readonly<{
    product_measure_snapshot?: unknown;
    supply_total_quantity?: unknown;
    active_held_quantity?: unknown;
  }>;

export type DiscoveryPublicAccountRow = Readonly<{
  account_id: string;
  account_slug: string;
  account_display_name: string | null;
  status: string;
  average_rating: string | null;
  review_count: number;
  active_listing_count: number;
  updated_at: string;
  recent_reviews: DiscoveryPublicAccountReviewRow[];
  listings: DiscoveryPublicListingRow[];
}>;

export type DiscoveryPublicAccountReviewRow = Readonly<{
  review_id: string;
  author_account_id: string;
  author_display_name: string | null;
  author_role: string;
  rating: number;
  feedback: string | null;
  submitted_at: string | null;
  updated_at: string;
}>;

function mapListing(row: DiscoveryPublicListingDbRow): DiscoveryPublicListingRow {
  const { product_measure_snapshot, supply_total_quantity, active_held_quantity, ...publicRow } = row;
  void product_measure_snapshot;
  void supply_total_quantity;
  void active_held_quantity;

  return {
    ...publicRow,
    selected_options: Array.isArray(row.selected_options) ? row.selected_options : [],
    google_shopping_structured_data_payload: objectValue(row.google_shopping_structured_data_payload),
  };
}

export async function getDiscoveryPublicListingBySlug(
  db: PgQueryable,
  slug: string,
): Promise<DiscoveryPublicListingRow | null> {
  const result = await db.query<DiscoveryPublicListingDbRow>(
    `WITH candidate_listing AS (
       SELECT
         listing.*,
         item.slug AS catalog_item_slug,
         account.seller_slug,
         account.seller_display_name,
         account.seller_listing_availability_status,
         account.seller_listing_availability_reason_category,
         account.seller_listing_available_again_on::text AS seller_listing_available_again_on,
         account.average_rating_as_seller::text AS seller_average_rating,
         COALESCE(account.review_count_as_seller, 0)::integer AS seller_review_count,
         google_feed.payload AS google_shopping_structured_data_payload,
       ${buyerVisibleListingQuantitySql("listing")} AS visible_quantity
       FROM discovery_market_listings AS listing
       LEFT JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       LEFT JOIN discovery_item_detail_pages AS item
         ON item.catalog_item_id = listing.catalog_catalog_item_id
       LEFT JOIN discovery_google_shopping_feed_rows AS google_feed
         ON google_feed.listing_id = listing.listing_id
        AND google_feed.eligibility_status = 'eligible'
        AND google_feed.tombstone_status = 'live'
        AND google_feed.payload IS NOT NULL
        AND google_feed.payload <> '{}'::jsonb
       LEFT JOIN discovery_slug_redirects AS redirect
         ON redirect.entity_kind = 'listing'
        AND redirect.slug = $1
       WHERE listing.listing_slug = $1
          OR listing.listing_id = $1
          OR listing.listing_id = redirect.entity_id
          OR listing.listing_slug = redirect.target_slug
     )
     SELECT *
     FROM candidate_listing
     WHERE status = 'active'
       AND seller_listing_availability_status = 'available'
       AND product_measure_snapshot IS NOT NULL
       AND visible_quantity > 0
     ORDER BY
       (listing_slug = $1) DESC,
       (listing_id = $1) DESC
     LIMIT 1`,
    [slug],
  );

  return result.rows[0] ? mapListing(result.rows[0]) : null;
}

export async function getDiscoveryPublicAccountBySlug(
  db: PgQueryable,
  slug: string,
): Promise<DiscoveryPublicAccountRow | null> {
  const accountResult = await db.query<
    Omit<DiscoveryPublicAccountRow, "listings" | "active_listing_count" | "recent_reviews">
  >(
    `SELECT
       account.account_id,
       account.seller_slug AS account_slug,
       account.seller_display_name AS account_display_name,
       account.status,
       account.average_rating_as_seller::text AS average_rating,
       COALESCE(account.review_count_as_seller, 0)::integer AS review_count,
       account.updated_at::text AS updated_at
     FROM discovery_market_accounts AS account
     LEFT JOIN discovery_slug_redirects AS redirect
       ON redirect.entity_kind = 'account'
      AND redirect.slug = $1
     WHERE account.seller_slug = $1
        OR account.account_id = $1
        OR account.account_id = redirect.entity_id
        OR account.seller_slug = redirect.target_slug
     ORDER BY
       (account.seller_slug = $1) DESC,
       (account.account_id = $1) DESC
     LIMIT 1`,
    [slug],
  );
  const account = accountResult.rows[0];

  if (!account) {
    return null;
  }

  const [listingResult, reviewResult] = await Promise.all([
    db.query<DiscoveryPublicListingDbRow>(
      `WITH startable_listing AS (
         SELECT
           listing.*,
           item.slug AS catalog_item_slug,
           account.seller_slug,
           account.seller_display_name,
           account.seller_listing_availability_status,
           account.seller_listing_availability_reason_category,
           account.seller_listing_available_again_on::text AS seller_listing_available_again_on,
           account.average_rating_as_seller::text AS seller_average_rating,
           COALESCE(account.review_count_as_seller, 0)::integer AS seller_review_count,
           NULL::jsonb AS google_shopping_structured_data_payload,
           ${buyerVisibleListingQuantitySql("listing")} AS visible_quantity
         FROM discovery_market_listings AS listing
         LEFT JOIN discovery_market_accounts AS account
           ON account.account_id = listing.account_id
         LEFT JOIN discovery_item_detail_pages AS item
           ON item.catalog_item_id = listing.catalog_catalog_item_id
         WHERE listing.account_id = $1
           AND ${buyerVisibleListingPredicateSql("listing", "account")}
       )
       SELECT *
       FROM startable_listing
       WHERE visible_quantity > 0
       ORDER BY updated_at DESC, price_amount::numeric ASC, listing_id ASC`,
      [account.account_id],
    ),
    db.query<DiscoveryPublicAccountReviewRow>(
      `SELECT
         review.review_id,
         review.author_account_id,
         author.seller_display_name AS author_display_name,
         review.author_role,
         review.rating,
         review.feedback,
         review.submitted_at::text AS submitted_at,
         review.updated_at::text AS updated_at
       FROM discovery_market_account_reviews AS review
       LEFT JOIN discovery_market_accounts AS author
         ON author.account_id = review.author_account_id
       WHERE review.subject_account_id = $1
         AND review.status = 'active'
       ORDER BY review.updated_at DESC, review.review_id DESC
       LIMIT 5`,
      [account.account_id],
    ),
  ]);

  return {
    ...account,
    active_listing_count: listingResult.rows.length,
    recent_reviews: reviewResult.rows,
    listings: listingResult.rows.map(mapListing),
  };
}

/** Kept well under the sitemap protocol's 50,000-URL-per-file ceiling. */
export const DISCOVERY_SITEMAP_PAGE_SIZE = 5000;

export const DISCOVERY_SITEMAP_ENTITY_KINDS: readonly DiscoverySitemapEntityKind[] = [
  "items",
  "categories",
  "sellers",
  "listings",
  "sets",
];

/**
 * Counts every crawlable public URL per sitemap entity kind so the marketplace
 * sitemap index can compute how many paginated child sitemaps each kind needs,
 * instead of silently truncating past a fixed row cap.
 */
export async function countDiscoveryPublicSitemapEntities(db: PgQueryable): Promise<DiscoverySitemapEntityCounts> {
  const [items, categories, sellers, listings, sets] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM discovery_item_detail_pages
       WHERE slug <> '' AND status = 'active'`,
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM discovery_categories
       WHERE slug <> '' AND status = 'active' AND item_count > 0`,
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM discovery_market_accounts AS account
       WHERE account.seller_slug <> ''
         AND account.status = 'active'
         AND EXISTS (
           SELECT 1
             FROM discovery_market_listings AS listing
             WHERE listing.account_id = account.account_id
               AND ${buyerVisibleListingPredicateSql("listing", "account")}
         )`,
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM discovery_market_listings AS listing
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE listing.listing_slug <> ''
         AND ${buyerVisibleListingPredicateSql("listing", "account")}`,
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM discovery_search_catalog_reference_records
       WHERE slug <> '' AND status = 'active'`,
    ),
  ]);

  return {
    items: Number(items.rows[0]?.count ?? 0),
    categories: Number(categories.rows[0]?.count ?? 0),
    sellers: Number(sellers.rows[0]?.count ?? 0),
    listings: Number(listings.rows[0]?.count ?? 0),
    sets: Number(sets.rows[0]?.count ?? 0),
  };
}

/**
 * Returns one 1-indexed page of crawlable public URLs for a sitemap entity kind,
 * ordered by a stable slug so pages stay consistent as `updated_at` changes between
 * requests. Callers use {@link countDiscoveryPublicSitemapEntities} to know how many
 * pages exist per kind.
 */
export async function listDiscoveryPublicSitemapEntityPage(
  db: PgQueryable,
  kind: DiscoverySitemapEntityKind,
  page: number,
): Promise<Array<{ path: string; updated_at: string }>> {
  const limit = DISCOVERY_SITEMAP_PAGE_SIZE;
  const offset = Math.max(page - 1, 0) * DISCOVERY_SITEMAP_PAGE_SIZE;

  switch (kind) {
    case "items": {
      const result = await db.query<{ slug: string; updated_at: string }>(
        `SELECT slug, updated_at
         FROM discovery_item_detail_pages
         WHERE slug <> '' AND status = 'active'
         ORDER BY slug ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return result.rows.map((row) => ({ path: `/items/${row.slug}`, updated_at: row.updated_at }));
    }
    case "categories": {
      const result = await db.query<{ slug: string; updated_at: string }>(
        `SELECT slug, updated_at
         FROM discovery_categories
         WHERE slug <> '' AND status = 'active' AND item_count > 0
         ORDER BY slug ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return result.rows.map((row) => ({ path: `/categories/${row.slug}`, updated_at: row.updated_at }));
    }
    case "sellers": {
      const result = await db.query<{ seller_slug: string; updated_at: string }>(
        `SELECT account.seller_slug, account.updated_at
         FROM discovery_market_accounts AS account
         WHERE account.seller_slug <> ''
           AND account.status = 'active'
           AND EXISTS (
             SELECT 1
               FROM discovery_market_listings AS listing
               WHERE listing.account_id = account.account_id
                 AND ${buyerVisibleListingPredicateSql("listing", "account")}
           )
         ORDER BY account.seller_slug ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return result.rows.map((row) => ({ path: `/accounts/${row.seller_slug}`, updated_at: row.updated_at }));
    }
    case "listings": {
      const result = await db.query<{ listing_slug: string; updated_at: string }>(
        `SELECT listing.listing_slug, listing.updated_at
         FROM discovery_market_listings AS listing
         INNER JOIN discovery_market_accounts AS account
           ON account.account_id = listing.account_id
         WHERE listing.listing_slug <> ''
           AND ${buyerVisibleListingPredicateSql("listing", "account")}
         ORDER BY listing.listing_slug ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return result.rows.map((row) => ({ path: `/listings/${row.listing_slug}`, updated_at: row.updated_at }));
    }
    case "sets": {
      const result = await db.query<{ slug: string; updated_at: string }>(
        `SELECT slug, updated_at
         FROM discovery_search_catalog_reference_records
         WHERE slug <> '' AND status = 'active'
         ORDER BY slug ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      return result.rows.map((row) => ({ path: `/sets/${row.slug}`, updated_at: row.updated_at }));
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unsupported sitemap entity kind: ${String(exhaustive)}`);
    }
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}
