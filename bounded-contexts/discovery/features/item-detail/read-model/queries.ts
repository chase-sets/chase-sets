import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { uniqueStrings } from "../../../support/item-support/unique-strings";
import {
  buyerVisibleListingPredicateSql,
  buyerVisibleListingQuantitySql,
} from "../../../support/market-support/listing-visibility";
import type {
  DiscoveryAccountOfferMatchWithTerms,
  DiscoveryItemDetailSellerOverlay,
  DiscoveryMarketListing,
  DiscoverySellerInventoryItem,
} from "../../../support/client-support/contracts";

export type DiscoveryItemDetailRow = Readonly<{
  catalog_item_id: string;
  slug: string;
  language_code: string;
  title_i18n: unknown;
  title: string;
  subtitle_i18n: unknown;
  subtitle: string | null;
  description_i18n: unknown;
  description: string;
  blueprint_id: string | null;
  blueprint: unknown;
  status: string;
  field_values: unknown;
  categories: unknown;
  tags: unknown;
  image_urls: unknown;
  product_asset_sets: unknown;
  image_fallback: unknown;
  product_schema: unknown;
  market_summary: Readonly<{
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }> | null;
  market_listings: readonly Readonly<{
    listing_id: string;
    listing_slug: string;
    product_slug: string;
    account_id: string;
    inventory_item_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    item_title: string | null;
    item_subtitle: string | null;
    selected_options: readonly { dimensionId: string; optionId: string }[];
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
    seller_slug: string | null;
    seller_display_name: string | null;
    seller_average_rating: string | null;
    seller_review_count: number;
    visible_quantity: number;
    created_at: string;
    updated_at: string;
  }>[];
  offer_demand_matches: readonly Readonly<{
    offer_id: string;
    buyer_account_id: string;
    buyer_display_name: string | null;
    catalog_catalog_item_id: string;
    product_id: string;
    item_title: string;
    item_subtitle: string | null;
    selected_options: readonly { dimensionId: string; optionId: string }[];
    product_summary: string | null;
    price_amount: string;
    quantity_requested: number;
    status: string;
    accepted_seller_account_id: string | null;
    accepted_at: string | null;
    buyer_slug: string | null;
    buyer_average_rating: string | null;
    buyer_review_count: number;
    created_at: string;
    updated_at: string;
  }>[];
  updated_at: string;
}>;

type BaseDiscoveryItemDetailRow = Omit<
  DiscoveryItemDetailRow,
  "market_summary" | "market_listings" | "offer_demand_matches"
>;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeCategoryRefs(value: unknown) {
  const categoryMap = new Map<string, { categoryId: string; slug: string; name: string }>();

  for (const entry of asArray<unknown>(value)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const categoryId = String((entry as { categoryId?: unknown }).categoryId ?? "");

    if (!categoryId || categoryMap.has(categoryId)) {
      continue;
    }

    categoryMap.set(categoryId, {
      categoryId,
      slug: String((entry as { slug?: unknown }).slug ?? categoryId),
      name: String((entry as { name?: unknown }).name ?? categoryId),
    });
  }

  return [...categoryMap.values()];
}

function normalizeStringArray(value: unknown) {
  return uniqueStrings(asArray<unknown>(value).filter((entry): entry is string => typeof entry === "string"));
}

function normalizeSelectedOptions(value: unknown): readonly { dimensionId: string; optionId: string }[] {
  return Array.isArray(value) ? (value as { dimensionId: string; optionId: string }[]) : [];
}

export async function getDiscoveryItemDetail(
  db: PgQueryable,
  itemIdOrSlug: string,
): Promise<DiscoveryItemDetailRow | null> {
  const result = await db.query<BaseDiscoveryItemDetailRow>(
    `SELECT page.*
     FROM discovery_item_detail_pages AS page
     LEFT JOIN discovery_slug_redirects AS redirect
       ON redirect.entity_kind = 'item'
      AND redirect.slug = $1
     WHERE page.catalog_item_id = $1
        OR page.slug = $1
        OR page.catalog_item_id = redirect.entity_id
        OR page.slug = redirect.target_slug
     ORDER BY
       (page.slug = $1) DESC,
       (page.catalog_item_id = $1) DESC
     LIMIT 1`,
    [itemIdOrSlug],
  );

  const item = result.rows[0] ?? null;
  if (!item) {
    return null;
  }

  const summaryResult = await db.query<{
    lowest_price_amount: string | null;
    active_listing_count: number;
    total_visible_quantity: number;
  }>(
    `WITH startable_listing AS (
       SELECT
         listing.price_amount,
         ${buyerVisibleListingQuantitySql("listing")} AS visible_quantity
       FROM discovery_market_listings AS listing
       INNER JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE listing.catalog_catalog_item_id = $1
         AND ${buyerVisibleListingPredicateSql("listing", "account")}
     )
     SELECT
       MIN(price_amount::numeric)::text AS lowest_price_amount,
       COUNT(*)::integer AS active_listing_count,
       COALESCE(SUM(visible_quantity), 0)::integer AS total_visible_quantity
     FROM startable_listing
     WHERE visible_quantity > 0`,
    [item.catalog_item_id],
  );

  const listingsResult = await db.query<
    Omit<DiscoveryItemDetailRow["market_listings"][number], "selected_options"> & {
      selected_options: unknown;
      product_measure_snapshot?: unknown;
      supply_total_quantity?: unknown;
      active_held_quantity?: unknown;
    }
  >(
    `WITH startable_listing AS (
       SELECT
         listing.*,
         account.seller_slug,
         account.seller_display_name,
         account.average_rating::text AS seller_average_rating,
         COALESCE(account.review_count, 0)::integer AS seller_review_count,
         ${buyerVisibleListingQuantitySql("listing")} AS visible_quantity
       FROM discovery_market_listings AS listing
       LEFT JOIN discovery_market_accounts AS account
         ON account.account_id = listing.account_id
       WHERE listing.catalog_catalog_item_id = $1
         AND ${buyerVisibleListingPredicateSql("listing", "account")}
     )
     SELECT *
     FROM startable_listing
     WHERE visible_quantity > 0
     ORDER BY price_amount::numeric ASC, updated_at DESC, listing_id ASC`,
    [item.catalog_item_id],
  );

  const offersResult = await db.query<
    Omit<DiscoveryItemDetailRow["offer_demand_matches"][number], "selected_options"> & {
      selected_options: unknown;
    }
  >(
    `SELECT
       offer.*,
       account.seller_slug AS buyer_slug,
       account.seller_display_name AS buyer_display_name,
       account.average_rating::text AS buyer_average_rating,
       COALESCE(account.review_count, 0)::integer AS buyer_review_count
     FROM discovery_offer_demand_matches AS offer
     LEFT JOIN discovery_market_accounts AS account
       ON account.account_id = offer.buyer_account_id
     WHERE offer.catalog_catalog_item_id = $1
       AND offer.status = 'submitted'
     ORDER BY
       offer.price_amount::numeric DESC,
       offer.quantity_requested DESC,
       offer.created_at ASC,
       offer.offer_id ASC`,
    [item.catalog_item_id],
  );

  const summaryRow = summaryResult.rows[0];
  const marketSummary =
    summaryRow && summaryRow.active_listing_count > 0
      ? {
          lowest_price_amount: summaryRow.lowest_price_amount,
          active_listing_count: summaryRow.active_listing_count,
          total_visible_quantity: summaryRow.total_visible_quantity,
        }
      : null;

  return {
    ...item,
    categories: normalizeCategoryRefs(item.categories),
    tags: normalizeStringArray(item.tags),
    image_urls: normalizeStringArray(item.image_urls),
    product_asset_sets: asArray(item.product_asset_sets),
    market_summary: marketSummary,
    market_listings: listingsResult.rows.map((row) => {
      const { product_measure_snapshot, supply_total_quantity, active_held_quantity, ...publicRow } = row;
      void product_measure_snapshot;
      void supply_total_quantity;
      void active_held_quantity;
      return {
        ...publicRow,
        selected_options: Array.isArray(row.selected_options) ? row.selected_options : [],
      };
    }),
    offer_demand_matches: offersResult.rows.map((row) => ({
      ...row,
      selected_options: Array.isArray(row.selected_options) ? row.selected_options : [],
    })),
  };
}

export async function getDiscoveryItemDetailSellerOverlay(
  db: PgQueryable,
  params: Readonly<{
    accountId: string;
    catalogItemId: string;
    selectedListingId?: string | null;
  }>,
): Promise<DiscoveryItemDetailSellerOverlay> {
  const accountOfferMatchesResult = await db.query<
    Omit<DiscoveryAccountOfferMatchWithTerms, "selected_options" | "acceptance_terms"> & {
      selected_options: unknown;
    }
  >(
    `WITH seller_listing AS (
       SELECT
         offer.offer_id,
         listing.listing_id,
         ${buyerVisibleListingQuantitySql("listing")} AS seller_available_quantity
       FROM discovery_offer_demand_matches AS offer
       INNER JOIN LATERAL (
         SELECT listing.*
         FROM discovery_market_listings AS listing
         INNER JOIN discovery_market_accounts AS seller
           ON seller.account_id = listing.account_id
         WHERE listing.account_id = $1
           AND listing.catalog_catalog_item_id = $2
           AND listing.product_id = offer.product_id
           AND ${buyerVisibleListingPredicateSql("listing", "seller")}
         ORDER BY
           listing.price_amount::numeric ASC,
           listing.updated_at DESC,
           listing.listing_id ASC
         LIMIT 1
       ) AS listing ON true
       WHERE offer.catalog_catalog_item_id = $2
         AND offer.status = 'submitted'
     )
     SELECT
       offer.offer_id,
       offer.buyer_account_id,
       buyer.seller_display_name AS buyer_display_name,
       offer.catalog_catalog_item_id,
       offer.product_id,
       offer.item_title,
       offer.item_subtitle,
       offer.selected_options,
       offer.product_summary,
       offer.price_amount,
       offer.quantity_requested,
       offer.status,
       offer.accepted_seller_account_id,
       offer.accepted_at::text AS accepted_at,
       buyer.seller_slug AS buyer_slug,
       buyer.average_rating::text AS buyer_average_rating,
       COALESCE(buyer.review_count, 0)::integer AS buyer_review_count,
       COALESCE(seller_listing.seller_available_quantity, 0)::integer AS seller_available_quantity,
       (COALESCE(seller_listing.seller_available_quantity, 0) >= offer.quantity_requested)::boolean AS can_fulfill,
       EXISTS (
         SELECT 1
         FROM discovery_item_detail_sell_list_lines AS line
         WHERE line.seller_account_id = $1
           AND line.line_type = 'selected-offer'
           AND line.offer_id = offer.offer_id
       ) AS in_sell_list,
       offer.created_at::text AS created_at,
       offer.updated_at::text AS updated_at
     FROM discovery_offer_demand_matches AS offer
     INNER JOIN seller_listing
       ON seller_listing.offer_id = offer.offer_id
     LEFT JOIN discovery_market_accounts AS buyer
       ON buyer.account_id = offer.buyer_account_id
     ORDER BY
       offer.price_amount::numeric DESC,
       offer.quantity_requested DESC,
       offer.created_at ASC,
       offer.offer_id ASC`,
    [params.accountId, params.catalogItemId],
  );

  const inventoryResult = await db.query<
    Omit<DiscoverySellerInventoryItem, "selected_options"> & {
      selected_options: unknown;
    }
  >(
    `SELECT
       supply.item_id,
       supply.catalog_catalog_item_id,
       supply.product_id,
       item.title AS item_title,
       item.subtitle AS item_subtitle,
       supply.selected_options,
       listing.product_summary,
       location.name AS storage_location_name,
       location.ship_from_code,
       GREATEST(supply.total_quantity - COALESCE(holds.held_quantity, 0), 0)::integer AS available_quantity
     FROM discovery_market_supply_items AS supply
     INNER JOIN discovery_market_supply_locations AS location
       ON location.storage_location_id = supply.storage_location_id
      AND location.is_archived = false
     LEFT JOIN discovery_item_detail_pages AS item
       ON item.catalog_item_id = supply.catalog_catalog_item_id
     LEFT JOIN LATERAL (
       SELECT product_summary
       FROM discovery_market_listings AS listing
       WHERE listing.inventory_item_id = supply.item_id
       ORDER BY listing.updated_at DESC, listing.listing_id ASC
       LIMIT 1
     ) AS listing ON true
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM discovery_market_supply_holds
       WHERE status = 'active'
       GROUP BY item_id
     ) AS holds
       ON holds.item_id = supply.item_id
     WHERE supply.account_id = $1
       AND supply.catalog_catalog_item_id = $2
       AND supply.product_id IS NOT NULL
       AND GREATEST(supply.total_quantity - COALESCE(holds.held_quantity, 0), 0) > 0
     ORDER BY location.name ASC, supply.updated_at DESC, supply.item_id ASC`,
    [params.accountId, params.catalogItemId],
  );

  const storageLocationResult = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM discovery_market_supply_locations
       WHERE account_id = $1
         AND is_archived = false
         AND (ship_from_code = 'LISTING-STOCK' OR name = 'Listing stock')
     ) AS exists`,
    [params.accountId],
  );

  const selectedListingResult = params.selectedListingId
    ? await db.query<
        Omit<DiscoveryMarketListing, "selected_options"> & {
          selected_options: unknown;
        }
      >(
        `SELECT
           listing.*,
           item.slug AS catalog_item_slug,
           account.seller_slug,
           account.seller_display_name,
           account.seller_listing_availability_status,
           account.seller_listing_availability_reason_category,
           account.seller_listing_available_again_on::text AS seller_listing_available_again_on,
           account.average_rating::text AS seller_average_rating,
           COALESCE(account.review_count, 0)::integer AS seller_review_count,
           ${buyerVisibleListingQuantitySql("listing")} AS visible_quantity
         FROM discovery_market_listings AS listing
         LEFT JOIN discovery_item_detail_pages AS item
           ON item.catalog_item_id = listing.catalog_catalog_item_id
         LEFT JOIN discovery_market_accounts AS account
           ON account.account_id = listing.account_id
         WHERE listing.listing_id = $1
           AND listing.account_id = $2
           AND listing.catalog_catalog_item_id = $3
           AND listing.status IN ('draft', 'active', 'paused')
         LIMIT 1`,
        [params.selectedListingId, params.accountId, params.catalogItemId],
      )
    : { rows: [] };

  const selectedListing = selectedListingResult.rows[0] ?? null;

  return {
    accountOfferMatches: accountOfferMatchesResult.rows.map((row) => ({
      ...row,
      selected_options: normalizeSelectedOptions(row.selected_options),
      acceptance_terms: null,
    })),
    sellerInventoryItems: inventoryResult.rows.map((row) => ({
      ...row,
      storage_location_name: row.storage_location_name ?? "",
      ship_from_code: row.ship_from_code ?? "",
      selected_options: normalizeSelectedOptions(row.selected_options),
    })),
    hasListingStockLocation: Boolean(storageLocationResult.rows[0]?.exists),
    selectedSellerListing: selectedListing
      ? {
          ...selectedListing,
          selected_options: normalizeSelectedOptions(selectedListing.selected_options),
        }
      : null,
  };
}
