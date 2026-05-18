import type { PgQueryable } from "@chase-sets/event-core-postgres";

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
}>;

export type DiscoveryPublicSellerRow = Readonly<{
  account_id: string;
  seller_slug: string;
  seller_display_name: string | null;
  status: string;
  average_rating: string | null;
  review_count: number;
  active_listing_count: number;
  updated_at: string;
  recent_reviews: DiscoveryPublicSellerReviewRow[];
  listings: DiscoveryPublicListingRow[];
}>;

export type DiscoveryPublicSellerReviewRow = Readonly<{
  review_id: string;
  author_account_id: string;
  author_display_name: string | null;
  author_role: string;
  rating: number;
  feedback: string | null;
  submitted_at: string | null;
  updated_at: string;
}>;

function mapListing(row: DiscoveryPublicListingRow): DiscoveryPublicListingRow {
  return {
    ...row,
    selected_options: Array.isArray(row.selected_options)
      ? row.selected_options
      : [],
  };
}

export async function getDiscoveryPublicListingBySlug(
  db: PgQueryable,
  slug: string,
): Promise<DiscoveryPublicListingRow | null> {
  const result = await db.query<DiscoveryPublicListingRow>(
    `SELECT
       listing.*,
       item.slug AS catalog_item_slug,
       account.seller_slug,
       account.seller_display_name,
       account.seller_listing_availability_status,
       account.seller_listing_availability_reason_category,
       account.seller_listing_available_again_on::text AS seller_listing_available_again_on,
       account.average_rating::text AS seller_average_rating,
       COALESCE(account.review_count, 0)::integer AS seller_review_count
     FROM discovery_market_listings AS listing
     LEFT JOIN discovery_market_accounts AS account
       ON account.account_id = listing.account_id
     LEFT JOIN discovery_item_detail_pages AS item
       ON item.catalog_item_id = listing.catalog_catalog_item_id
     LEFT JOIN discovery_slug_redirects AS redirect
       ON redirect.entity_kind = 'listing'
      AND redirect.slug = $1
     WHERE listing.listing_slug = $1
        OR listing.listing_id = $1
        OR listing.listing_id = redirect.entity_id
        OR listing.listing_slug = redirect.target_slug
     ORDER BY
       (listing.listing_slug = $1) DESC,
       (listing.listing_id = $1) DESC
     LIMIT 1`,
    [slug],
  );

  return result.rows[0] ? mapListing(result.rows[0]) : null;
}

export async function getDiscoveryPublicSellerBySlug(
  db: PgQueryable,
  slug: string,
): Promise<DiscoveryPublicSellerRow | null> {
  const sellerResult = await db.query<Omit<DiscoveryPublicSellerRow, "listings" | "active_listing_count" | "recent_reviews">>(
    `SELECT
       account.account_id,
       account.seller_slug,
       account.seller_display_name,
       account.status,
       account.average_rating::text AS average_rating,
       COALESCE(account.review_count, 0)::integer AS review_count,
       account.updated_at::text AS updated_at
     FROM discovery_market_accounts AS account
     LEFT JOIN discovery_slug_redirects AS redirect
       ON redirect.entity_kind = 'seller'
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
  const seller = sellerResult.rows[0];

  if (!seller) {
    return null;
  }

  const [listingResult, reviewResult] = await Promise.all([
    db.query<DiscoveryPublicListingRow>(
      `SELECT
         listing.*,
         item.slug AS catalog_item_slug,
         account.seller_slug,
         account.seller_display_name,
         account.seller_listing_availability_status,
         account.seller_listing_availability_reason_category,
         account.seller_listing_available_again_on::text AS seller_listing_available_again_on,
         account.average_rating::text AS seller_average_rating,
         COALESCE(account.review_count, 0)::integer AS seller_review_count
       FROM discovery_market_listings AS listing
       LEFT JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       LEFT JOIN discovery_item_detail_pages AS item
         ON item.catalog_item_id = listing.catalog_catalog_item_id
       WHERE listing.account_id = $1
         AND listing.status = 'active'
         AND account.seller_listing_availability_status = 'available'
       ORDER BY listing.updated_at DESC, listing.price_amount ASC, listing.listing_id ASC`,
      [seller.account_id],
    ),
    db.query<DiscoveryPublicSellerReviewRow>(
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
      [seller.account_id],
    ),
  ]);

  return {
    ...seller,
    active_listing_count: listingResult.rows.length,
    recent_reviews: reviewResult.rows,
    listings: listingResult.rows.map(mapListing),
  };
}

export async function listDiscoveryPublicSitemapUrls(
  db: PgQueryable,
): Promise<Array<{ path: string; updated_at: string }>> {
  const [items, categories, sellers, listings] = await Promise.all([
    db.query<{ slug: string; updated_at: string }>(
      `SELECT slug, updated_at
       FROM discovery_item_detail_pages
       WHERE slug <> '' AND status = 'active'
       ORDER BY updated_at DESC
       LIMIT 5000`,
    ),
    db.query<{ slug: string; updated_at: string }>(
      `SELECT slug, updated_at
       FROM discovery_categories
       WHERE slug <> '' AND status = 'active' AND item_count > 0
       ORDER BY display_order ASC, updated_at DESC
       LIMIT 5000`,
    ),
    db.query<{ seller_slug: string; updated_at: string }>(
      `SELECT account.seller_slug, account.updated_at
       FROM discovery_market_accounts AS account
       WHERE account.seller_slug <> ''
         AND account.status = 'active'
         AND EXISTS (
           SELECT 1
           FROM discovery_market_listings AS listing
           WHERE listing.account_id = account.account_id
             AND listing.status = 'active'
             AND account.seller_listing_availability_status = 'available'
         )
       ORDER BY account.updated_at DESC
       LIMIT 5000`,
    ),
    db.query<{ listing_slug: string; updated_at: string }>(
      `SELECT listing.listing_slug, listing.updated_at
       FROM discovery_market_listings AS listing
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE listing.listing_slug <> ''
         AND listing.status = 'active'
         AND account.seller_listing_availability_status = 'available'
       ORDER BY listing.updated_at DESC
       LIMIT 5000`,
    ),
  ]);

  return [
    ...items.rows.map((row) => ({ path: `/items/${row.slug}`, updated_at: row.updated_at })),
    ...categories.rows.map((row) => ({ path: `/categories/${row.slug}`, updated_at: row.updated_at })),
    ...sellers.rows.map((row) => ({ path: `/sellers/${row.seller_slug}`, updated_at: row.updated_at })),
    ...listings.rows.map((row) => ({ path: `/listings/${row.listing_slug}`, updated_at: row.updated_at })),
  ];
}
