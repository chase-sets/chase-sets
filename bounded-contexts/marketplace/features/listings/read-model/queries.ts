import { escapeLikePattern, type PgQueryable } from "@chase-sets/event-core-postgres";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductMeasureSnapshot } from "@chase-sets/product-measures";
import {
  hydrateStoredListingPhoto,
  type MarketplaceGradedCardDetails,
  type MarketplaceListingFeeLock,
  type MarketplaceListingPhoto,
  type MarketplaceListingPhotoDraft,
} from "../domain/domain";
import { toPublicListingGallery, type MarketplaceListingPublicGalleryImage } from "../domain/evidence-gallery";

export type MarketplaceListingListRow = Readonly<{
  listing_id: string;
  account_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  product_measure_snapshot: ProductMeasureSnapshot | null;
  graded_card: MarketplaceGradedCardDetails | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  ship_from_address: AddressSnapshot;
  price_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  fee_quote_fingerprint: string;
  fee_locks: readonly MarketplaceListingFeeLock[];
  quantity_cap: number;
  max_units_per_order: number | null;
  max_units_per_day: number | null;
  max_units_per_customer_account: number | null;
  listing_photos: readonly MarketplaceListingPhoto[];
  status: string;
  created_at: string;
  updated_at: string;
}>;

export type MarketplaceItemListingRow = MarketplaceListingListRow &
  Readonly<{
    seller_display_name: string | null;
    visible_quantity: number;
    /**
     * Buyer-safe evidence gallery. Public item-listing reads expose only this
     * sanitized view; `listing_photos` is emptied on public rows so storage
     * keys, source hashes, byte sizes, filenames, and non-active audit entries
     * never leak.
     */
    public_gallery: readonly MarketplaceListingPublicGalleryImage[];
  }>;

export type MarketplaceListingFeeLockReportRow = Readonly<{
  listing_id: string;
  inventory_item_id: string;
  item_language_code: string | null;
  item_title: string | null;
  product_summary: string | null;
  status: string;
  price_amount: string;
  quantity_cap: number;
  max_units_per_order: number | null;
  max_units_per_day: number | null;
  max_units_per_customer_account: number | null;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  fee_quote_fingerprint: string;
  fee_locks: readonly MarketplaceListingFeeLock[];
  created_at: string;
  updated_at: string;
}>;

export type MarketplaceMarketSummaryRow = Readonly<{
  lowest_price_amount: string | null;
  active_listing_count: number;
  total_visible_quantity: number;
}>;

export type MarketplaceSellerListingAvailabilityRow = Readonly<{
  account_id: string;
  status: "available" | "unavailable";
  disabled_reason_category: string | null;
  available_again_on: string | null;
  available_again_at: string | null;
  disabled_at: string | null;
  enabled_at: string | null;
  /** The pending Away Window's start, or null when no window is scheduled. */
  away_window_starts_at: string | null;
  away_window_ends_at: string | null;
  away_window_reason_category: string | null;
  updated_at: string;
}>;

export type MarketplaceSellerOrderCapacityRow = Readonly<{
  account_id: string;
  max_open_orders: number | null;
  updated_at: string;
}>;

export type MarketplaceAccountRiskRow = Readonly<{
  account_id: string;
  badges: readonly string[];
  review_count: number;
  average_rating: string | null;
}>;

type MarketplaceListingPageRow = Readonly<{
  listing_id: string;
  account_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  product_measure_snapshot: unknown;
  graded_card: unknown;
  storage_location_name: string | null;
  ship_from_code: string | null;
  ship_from_address: unknown;
  price_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  fee_quote_fingerprint: string;
  fee_locks: unknown;
  quantity_cap: number;
  max_units_per_order: number | null;
  max_units_per_day: number | null;
  max_units_per_customer_account: number | null;
  listing_photos: unknown;
  status: string;
  created_at: string;
  updated_at: string;
}>;

// Public product listing pages intentionally default to 50 rows to keep hot-path reads bounded.
export const MARKETPLACE_ITEM_LISTINGS_DEFAULT_PAGE_SIZE = 50;
const MARKETPLACE_ITEM_LISTINGS_MAX_PAGE_SIZE = 100;

const activeSupplyHoldQuantityJoinSql = `
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(supply_hold.quantity), 0)::integer AS held_quantity
      FROM marketplace_supply_holds AS supply_hold
      WHERE supply_hold.item_id = item.item_id
        AND supply_hold.status = 'active'
    ) AS active_holds ON TRUE`;

const listingPageColumnSelectSql = `
       listing.listing_id,
       listing.account_id,
       listing.inventory_item_id,
       listing.catalog_catalog_item_id,
       listing.product_id,
       listing.item_language_code,
       listing.item_title,
       listing.item_subtitle,
       listing.selected_options,
       listing.product_summary,
       listing.product_measure_snapshot,
       listing.graded_card,
       listing.storage_location_name,
       listing.ship_from_code,
       listing.ship_from_address,
       listing.price_amount,
       listing.marketplace_sales_fee_unit_amount,
       listing.seller_net_unit_amount,
       listing.shipping_allowance_percentage_bps,
       listing.terms_schedule_id,
       listing.terms_agreement_id,
       listing.terms_resolved_at,
       listing.fee_quote_fingerprint,
       listing.fee_locks,
       listing.quantity_cap,
       listing.max_units_per_order,
       listing.max_units_per_day,
       listing.max_units_per_customer_account,
       listing.listing_photos,
       listing.status,
       listing.created_at,
       listing.updated_at`;

function normalizeBadgeArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export type MarketplaceInventoryItemSupply = Readonly<{
  item_id: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  product_measure_snapshot: ProductMeasureSnapshot | null;
  graded_card: MarketplaceGradedCardDetails | null;
  storage_location_id: string;
  storage_location_name: string;
  ship_from_code: string;
  ship_from_address: AddressSnapshot;
  total_quantity: number;
  available_quantity: number;
  acquisition_cost_amount: string | null;
}>;

function mapListingRow(row: MarketplaceListingPageRow): MarketplaceListingListRow {
  return {
    ...row,
    ship_from_address:
      typeof row.ship_from_address === "object" && row.ship_from_address !== null
        ? (row.ship_from_address as AddressSnapshot)
        : {
            name: "",
            line1: "",
            city: "",
            state: "",
            postalCode: "",
            country: "US",
          },
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as MarketplaceListingListRow["selected_options"])
      : [],
    product_measure_snapshot:
      typeof row.product_measure_snapshot === "object" && row.product_measure_snapshot !== null
        ? (row.product_measure_snapshot as ProductMeasureSnapshot)
        : null,
    graded_card:
      typeof row.graded_card === "object" && row.graded_card !== null
        ? (row.graded_card as MarketplaceGradedCardDetails)
        : null,
    listing_photos: Array.isArray(row.listing_photos)
      ? (row.listing_photos as MarketplaceListingPhotoDraft[]).map(hydrateStoredListingPhoto)
      : [],
    fee_locks: Array.isArray(row.fee_locks) ? (row.fee_locks as MarketplaceListingFeeLock[]) : [],
  };
}

export async function getInventoryItemSupply(
  db: PgQueryable,
  itemId: string,
  accountId?: string,
): Promise<MarketplaceInventoryItemSupply | null> {
  const values: unknown[] = [itemId];
  const accountCondition = accountId ? "AND item.account_id = $2" : "";
  if (accountId) {
    values.push(accountId);
  }

  const result = await db.query<{
    item_id: string;
    account_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    item_language_code: string | null;
    item_title: string | null;
    item_subtitle: string | null;
    selected_options: unknown;
    product_summary: string | null;
    product_measure_snapshot: unknown;
    graded_card: unknown;
    storage_location_id: string;
    storage_location_name: string;
    ship_from_code: string;
    ship_from_address: unknown;
    total_quantity: number;
    available_quantity: number;
    acquisition_cost_amount: string | null;
  }>(
    `SELECT
       item.item_id,
       item.account_id,
       item.catalog_catalog_item_id,
       item.product_id,
       catalog_item.language_code AS item_language_code,
       catalog_item.title AS item_title,
       catalog_item.subtitle AS item_subtitle,
       item.selected_options,
       item.graded_card,
       (
         CASE
           WHEN catalog_item.product_schema IS NULL THEN NULL
           ELSE (
             SELECT string_agg(part, ' | ' ORDER BY ordinality)
             FROM (
               SELECT
                 ordinality,
                 COALESCE(dimension->>'dimensionName', dimension->>'dimensionId') || ': ' ||
                 COALESCE(
                   option->'labels'->0->>'value',
                   option->>'code',
                   selection->>'optionId'
                 ) AS part
               FROM jsonb_array_elements(item.selected_options) WITH ORDINALITY AS selected(selection, ordinality)
               LEFT JOIN LATERAL (
                 SELECT dimension
                 FROM jsonb_array_elements(COALESCE(catalog_item.product_schema->'dimensions', '[]'::jsonb)) AS dimension
                 WHERE dimension->>'dimensionId' = selection->>'dimensionId'
               ) matched_dimension ON TRUE
               LEFT JOIN LATERAL (
                 SELECT option
                 FROM jsonb_array_elements(COALESCE(matched_dimension.dimension->'allowedOptions', '[]'::jsonb)) AS option
                 WHERE option->>'optionId' = selection->>'optionId'
               ) matched_choice ON TRUE
             ) parts
           )
         END
       ) AS product_summary,
       (
         SELECT measure
         FROM jsonb_array_elements(COALESCE(catalog_item.product_measure_snapshots, '[]'::jsonb)) AS measure
         WHERE measure->>'productId' = item.product_id
         LIMIT 1
       ) AS product_measure_snapshot,
       item.storage_location_id,
       location.name AS storage_location_name,
       location.ship_from_code,
       location.ship_from_address,
       item.total_quantity,
       item.total_quantity - COALESCE(active_holds.held_quantity, 0) AS available_quantity,
       item.acquisition_cost_amount
     FROM marketplace_supply_items AS item
     INNER JOIN marketplace_supply_locations AS location
       ON location.storage_location_id = item.storage_location_id
     LEFT JOIN marketplace_catalog_items AS catalog_item
       ON catalog_item.catalog_item_id = item.catalog_catalog_item_id
     ${activeSupplyHoldQuantityJoinSql}
     WHERE item.item_id = $1
       ${accountCondition}`,
    values,
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    ...row,
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as MarketplaceInventoryItemSupply["selected_options"])
      : [],
    product_measure_snapshot:
      typeof row.product_measure_snapshot === "object" && row.product_measure_snapshot !== null
        ? (row.product_measure_snapshot as ProductMeasureSnapshot)
        : null,
    graded_card:
      typeof row.graded_card === "object" && row.graded_card !== null
        ? (row.graded_card as MarketplaceGradedCardDetails)
        : null,
    ship_from_address:
      typeof row.ship_from_address === "object" && row.ship_from_address !== null
        ? (row.ship_from_address as AddressSnapshot)
        : {
            name: "",
            line1: "",
            city: "",
            state: "",
            postalCode: "",
            country: "US",
          },
  };
}

export async function listSellerInventoryItemSupply(
  db: PgQueryable,
  params: Readonly<{ accountId: string; catalogItemId?: string; limit?: number; offset?: number }>,
): Promise<{ items: MarketplaceInventoryItemSupply[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const values: unknown[] = [params.accountId];
  const catalogCondition = params.catalogItemId ? "AND item.catalog_catalog_item_id = $2" : "";

  if (params.catalogItemId) {
    values.push(params.catalogItemId);
  }

  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;

  const selectSql = `
    SELECT
      item.item_id,
      item.account_id,
      item.catalog_catalog_item_id,
      item.product_id,
      catalog_item.language_code AS item_language_code,
      catalog_item.title AS item_title,
      catalog_item.subtitle AS item_subtitle,
      item.selected_options,
      item.graded_card,
      (
        CASE
          WHEN catalog_item.product_schema IS NULL THEN NULL
          ELSE (
            SELECT string_agg(part, ' | ' ORDER BY ordinality)
            FROM (
              SELECT
                ordinality,
                COALESCE(dimension->>'dimensionName', dimension->>'dimensionId') || ': ' ||
                COALESCE(
                  option->'labels'->0->>'value',
                  option->>'code',
                  selection->>'optionId'
                ) AS part
              FROM jsonb_array_elements(item.selected_options) WITH ORDINALITY AS selected(selection, ordinality)
              LEFT JOIN LATERAL (
                SELECT dimension
                FROM jsonb_array_elements(COALESCE(catalog_item.product_schema->'dimensions', '[]'::jsonb)) AS dimension
                WHERE dimension->>'dimensionId' = selection->>'dimensionId'
              ) matched_dimension ON TRUE
              LEFT JOIN LATERAL (
                SELECT option
                FROM jsonb_array_elements(COALESCE(matched_dimension.dimension->'allowedOptions', '[]'::jsonb)) AS option
                WHERE option->>'optionId' = selection->>'optionId'
              ) matched_choice ON TRUE
            ) parts
          )
        END
      ) AS product_summary,
      (
        SELECT measure
        FROM jsonb_array_elements(COALESCE(catalog_item.product_measure_snapshots, '[]'::jsonb)) AS measure
        WHERE measure->>'productId' = item.product_id
        LIMIT 1
      ) AS product_measure_snapshot,
      item.storage_location_id,
      location.name AS storage_location_name,
      location.ship_from_code,
      location.ship_from_address,
      item.total_quantity,
      item.total_quantity - COALESCE(active_holds.held_quantity, 0) AS available_quantity,
      item.acquisition_cost_amount
    FROM marketplace_supply_items AS item
    INNER JOIN marketplace_supply_locations AS location
      ON location.storage_location_id = item.storage_location_id
    LEFT JOIN marketplace_catalog_items AS catalog_item
      ON catalog_item.catalog_item_id = item.catalog_catalog_item_id
    ${activeSupplyHoldQuantityJoinSql}
    WHERE item.account_id = $1
      ${catalogCondition}
      AND item.total_quantity - COALESCE(active_holds.held_quantity, 0) > 0`;

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM marketplace_supply_items AS item
       ${activeSupplyHoldQuantityJoinSql}
       WHERE item.account_id = $1
         ${catalogCondition}
         AND item.total_quantity - COALESCE(active_holds.held_quantity, 0) > 0`,
      values,
    ),
    db.query<{
      item_id: string;
      account_id: string;
      catalog_catalog_item_id: string;
      product_id: string;
      item_language_code: string | null;
      item_title: string | null;
      item_subtitle: string | null;
      selected_options: unknown;
      product_summary: string | null;
      product_measure_snapshot: unknown;
      graded_card: unknown;
      storage_location_id: string;
      storage_location_name: string;
      ship_from_code: string;
      ship_from_address: unknown;
      total_quantity: number;
      available_quantity: number;
      acquisition_cost_amount: string | null;
    }>(
      `${selectSql}
       ORDER BY catalog_item.title ASC, item.product_id ASC, item.item_id ASC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      [...values, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows.map((row) => ({
      ...row,
      selected_options: Array.isArray(row.selected_options)
        ? (row.selected_options as MarketplaceInventoryItemSupply["selected_options"])
        : [],
      product_measure_snapshot:
        typeof row.product_measure_snapshot === "object" && row.product_measure_snapshot !== null
          ? (row.product_measure_snapshot as ProductMeasureSnapshot)
          : null,
      graded_card:
        typeof row.graded_card === "object" && row.graded_card !== null
          ? (row.graded_card as MarketplaceGradedCardDetails)
          : null,
      ship_from_address:
        typeof row.ship_from_address === "object" && row.ship_from_address !== null
          ? (row.ship_from_address as AddressSnapshot)
          : {
              name: "",
              line1: "",
              city: "",
              state: "",
              postalCode: "",
              country: "US",
            },
    })),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function hasSellerSupplyLocationNamed(
  db: PgQueryable,
  params: Readonly<{ accountId: string; name: string }>,
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM marketplace_supply_locations
       WHERE account_id = $1
         AND name = $2
         AND is_archived = false
     ) AS exists`,
    [params.accountId, params.name],
  );

  return result.rows[0]?.exists ?? false;
}

export async function getActiveQuantityCapForInventoryItem(
  db: PgQueryable,
  inventoryItemId: string,
  excludeListingId?: string,
): Promise<number> {
  const values: unknown[] = [inventoryItemId];
  let excludeSql = "";

  if (excludeListingId) {
    values.push(excludeListingId);
    excludeSql = `AND listing_id != $2`;
  }

  const result = await db.query<{ quantity_cap: string }>(
    `SELECT COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap
     FROM marketplace_listing_pages
     WHERE inventory_item_id = $1
       AND status = 'active'
       ${excludeSql}`,
    values,
  );

  return Number(result.rows[0]?.quantity_cap ?? 0);
}

export async function listActiveListingsForInventoryItem(db: PgQueryable, inventoryItemId: string) {
  const result = await db.query<MarketplaceListingPageRow>(
    `SELECT *
     FROM marketplace_listing_pages
     WHERE inventory_item_id = $1
       AND status = 'active'
     ORDER BY updated_at DESC, listing_id DESC`,
    [inventoryItemId],
  );

  return result.rows.map(mapListingRow);
}

const SELLER_LISTING_STATUSES = new Set(["draft", "active", "paused", "withdrawn"]);

export async function listSellerListings(
  db: PgQueryable,
  params: Readonly<{ accountId: string; limit?: number; offset?: number; status?: string; search?: string }>,
): Promise<{ items: MarketplaceListingListRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const status = params.status && SELLER_LISTING_STATUSES.has(params.status) ? params.status : null;
  const search = params.search?.trim() ? params.search.trim() : null;

  const values: unknown[] = [params.accountId];
  const conditions: string[] = [];
  if (status) {
    values.push(status);
    conditions.push(`status = $${values.length}`);
  }
  if (search) {
    values.push(`%${escapeLikePattern(search)}%`);
    conditions.push(`item_title ILIKE $${values.length} ESCAPE '\\'`);
  }
  const filterSql = conditions.map((condition) => `AND ${condition}`).join("\n       ");
  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_listing_pages
       WHERE account_id = $1
       ${filterSql}`,
      values,
    ),
    db.query<MarketplaceListingPageRow>(
      `SELECT *
       FROM marketplace_listing_pages
       WHERE account_id = $1
       ${filterSql}
       ORDER BY updated_at DESC, listing_id DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      [...values, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows.map(mapListingRow),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export type MarketplaceSellerListingStatusCounts = Readonly<{
  active: number;
  draft: number;
  paused: number;
  withdrawn: number;
}>;

export async function getSellerListingStatusCounts(
  db: PgQueryable,
  accountId: string,
): Promise<MarketplaceSellerListingStatusCounts> {
  const result = await db.query<{ active: string; draft: string; paused: string; withdrawn: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active') AS active,
       COUNT(*) FILTER (WHERE status = 'draft') AS draft,
       COUNT(*) FILTER (WHERE status = 'paused') AS paused,
       COUNT(*) FILTER (WHERE status = 'withdrawn') AS withdrawn
     FROM marketplace_listing_pages
     WHERE account_id = $1`,
    [accountId],
  );
  const row = result.rows[0];

  return {
    active: Number(row?.active ?? 0),
    draft: Number(row?.draft ?? 0),
    paused: Number(row?.paused ?? 0),
    withdrawn: Number(row?.withdrawn ?? 0),
  };
}

export async function getSellerListingAvailability(
  db: PgQueryable,
  accountId: string,
): Promise<MarketplaceSellerListingAvailabilityRow> {
  const result = await db.query<MarketplaceSellerListingAvailabilityRow>(
    `SELECT
       account_id,
       status,
       disabled_reason_category,
       available_again_on::text AS available_again_on,
       available_again_at::text AS available_again_at,
       disabled_at::text AS disabled_at,
       enabled_at::text AS enabled_at,
       away_window_starts_at::text AS away_window_starts_at,
       away_window_ends_at::text AS away_window_ends_at,
       away_window_reason_category,
       updated_at::text AS updated_at
     FROM marketplace_seller_listing_availability_pages
     WHERE account_id = $1`,
    [accountId],
  );

  return (
    result.rows[0] ?? {
      account_id: accountId,
      status: "available",
      disabled_reason_category: null,
      available_again_on: null,
      available_again_at: null,
      disabled_at: null,
      enabled_at: null,
      away_window_starts_at: null,
      away_window_ends_at: null,
      away_window_reason_category: null,
      updated_at: new Date(0).toISOString(),
    }
  );
}

/**
 * Order Capacity read. Absent row (or a NULL max_open_orders) means
 * unlimited, mirroring the domain aggregate's default-unlimited-when-no-
 * stream-exists shape. Inert until the enforcement slice reads it.
 */
export async function getSellerOrderCapacity(
  db: PgQueryable,
  accountId: string,
): Promise<MarketplaceSellerOrderCapacityRow> {
  const result = await db.query<MarketplaceSellerOrderCapacityRow>(
    `SELECT
       account_id,
       max_open_orders,
       updated_at::text AS updated_at
     FROM marketplace_seller_order_capacity_pages
     WHERE account_id = $1`,
    [accountId],
  );

  return (
    result.rows[0] ?? {
      account_id: accountId,
      max_open_orders: null,
      updated_at: new Date(0).toISOString(),
    }
  );
}

export type MarketplaceDueSellerAvailabilityRestoreRow = Readonly<{
  account_id: string;
  available_again_at: string;
}>;

/**
 * Auto-resume sweep due index: accounts whose Resume Instant has passed
 * while still marked unavailable. Ordered by `available_again_at` so the
 * sweep processes the longest-overdue accounts first within a batch; the
 * partial index backing this query only exists for
 * `status = 'unavailable' AND available_again_at IS NOT NULL`, so a legacy
 * `availableAgainOn`-only row (no resume instant) is never returned here.
 */
export async function listDueSellerAvailabilityRestores(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly MarketplaceDueSellerAvailabilityRestoreRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const result = await db.query<MarketplaceDueSellerAvailabilityRestoreRow>(
    `SELECT
       account_id,
       available_again_at::text AS available_again_at
     FROM marketplace_seller_listing_availability_pages
     WHERE status = 'unavailable'
       AND available_again_at IS NOT NULL
       AND available_again_at <= $1::timestamptz
     ORDER BY available_again_at ASC, account_id ASC
     LIMIT $2`,
    [params.now, limit],
  );

  return result.rows;
}

export type MarketplaceDueSellerAwayWindowStartRow = Readonly<{
  account_id: string;
  away_window_starts_at: string;
  away_window_ends_at: string | null;
  away_window_reason_category: string;
}>;

/**
 * Away Window start sweep due index: accounts with a pending window whose
 * `startsAt` has passed. Ordered by `away_window_starts_at` so the sweep
 * processes the longest-overdue windows first within a batch. The window's
 * end boundary is not queried here -- once the sweep disables the account
 * with `availableAgainAt = away_window_ends_at`, the end rides the existing
 * Resume Instant sweep (`listDueSellerAvailabilityRestores`) for free.
 */
export async function listDueSellerAwayWindowStarts(
  db: PgQueryable,
  params: Readonly<{ now: string; limit?: number }>,
): Promise<readonly MarketplaceDueSellerAwayWindowStartRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const result = await db.query<MarketplaceDueSellerAwayWindowStartRow>(
    `SELECT
       account_id,
       away_window_starts_at::text AS away_window_starts_at,
       away_window_ends_at::text AS away_window_ends_at,
       away_window_reason_category
     FROM marketplace_seller_listing_availability_pages
     WHERE away_window_starts_at IS NOT NULL
       AND away_window_starts_at <= $1::timestamptz
     ORDER BY away_window_starts_at ASC, account_id ASC
     LIMIT $2`,
    [params.now, limit],
  );

  return result.rows;
}

// High-dollar listing publication trust is gated on the account's OWN
// reliability as a SELLER, so this reads the as-seller reputation dimension
// (m108) — an account's history as a buyer must not unlock seller trust.
export async function getMarketplaceAccountRisk(
  db: PgQueryable,
  accountId: string,
): Promise<MarketplaceAccountRiskRow> {
  const result = await db.query<{
    account_id: string;
    badges: unknown;
    review_count: number;
    average_rating: string | null;
  }>(
    `SELECT
       account_id,
       badges,
       review_count_as_seller AS review_count,
       average_rating_as_seller::text AS average_rating
     FROM marketplace_account_pages
     WHERE account_id = $1`,
    [accountId],
  );
  const row = result.rows[0];

  return {
    account_id: accountId,
    badges: normalizeBadgeArray(row?.badges),
    review_count: row?.review_count ?? 0,
    average_rating: row?.average_rating ?? null,
  };
}

export async function listSellerListingFeeLockReport(
  db: PgQueryable,
  params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
): Promise<{ items: MarketplaceListingFeeLockReportRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_listing_pages
       WHERE account_id = $1`,
      [params.accountId],
    ),
    db.query<MarketplaceListingFeeLockReportRow>(
      `SELECT
         listing_id,
         inventory_item_id,
         item_language_code,
         item_title,
         product_summary,
         status,
         price_amount,
         quantity_cap,
         max_units_per_order,
         max_units_per_day,
         max_units_per_customer_account,
         marketplace_sales_fee_unit_amount,
         seller_net_unit_amount,
         shipping_allowance_percentage_bps,
         terms_schedule_id,
         terms_agreement_id,
         terms_resolved_at,
         fee_quote_fingerprint,
         fee_locks,
         created_at,
         updated_at
       FROM marketplace_listing_pages
       WHERE account_id = $1
       ORDER BY updated_at DESC, listing_id DESC
       LIMIT $2 OFFSET $3`,
      [params.accountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export type MarketplaceLockedFeeListingCohortWeeklyPoint = Readonly<{
  weekStart: string;
  listingsCreatedCount: number;
}>;

export type MarketplaceLockedFeeListingCohortSummary = Readonly<{
  listingsCreatedCount: number;
  lockedSellerAccountIds: readonly string[];
  weeklyListingsCreated: readonly MarketplaceLockedFeeListingCohortWeeklyPoint[];
}>;

/**
 * Platform-wide (not single-seller) summary of listings locked to a 0%
 * marketplace sales fee via a Commercial Terms agreement -- the
 * offer-economics monitor's cohort membership source. A listing
 * qualifies when its listing-time fee snapshot (`terms_agreement_id`,
 * `marketplace_sales_fee_unit_amount`) resolved through an agreement at
 * exactly 0.00, i.e. the founders-offer fee-lock mechanism (an agreement
 * is the fee-lock primitive; see
 * `commercialTermsAgreementPolicy`'s bps=0/fixed=0.00 shape) rather than the
 * standard schedule. `lockedSellerAccountIds` feeds Pricing's
 * `getSellerCohortGmvSummary`/`getSellerCohortWeeklyGmv` so the monitor can
 * report the cohort's realized GMV without Platform Operations querying
 * `marketplace_listing_pages` or `pricing_market_trades` directly.
 */
export async function getLockedFeeListingCohortSummary(
  db: PgQueryable,
  params: Readonly<{ from: string; to: string }>,
): Promise<MarketplaceLockedFeeListingCohortSummary> {
  const [totalsResult, weeklyResult] = await Promise.all([
    db.query<{ listings_created_count: string; locked_seller_account_ids: string[] | null }>(
      `SELECT
         COUNT(*)::integer AS listings_created_count,
         COALESCE(array_agg(DISTINCT account_id), ARRAY[]::text[]) AS locked_seller_account_ids
       FROM marketplace_listing_pages
       WHERE terms_agreement_id IS NOT NULL
         AND marketplace_sales_fee_unit_amount = 0
         AND created_at >= ($1::date)::timestamp AT TIME ZONE 'UTC'
         AND created_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'`,
      [params.from, params.to],
    ),
    db.query<{ week_start: string; listings_created_count: string }>(
      `SELECT
         date_trunc('week', created_at)::date::text AS week_start,
         COUNT(*)::integer AS listings_created_count
       FROM marketplace_listing_pages
       WHERE terms_agreement_id IS NOT NULL
         AND marketplace_sales_fee_unit_amount = 0
         AND created_at >= ($1::date)::timestamp AT TIME ZONE 'UTC'
         AND created_at < ($2::date + 1)::timestamp AT TIME ZONE 'UTC'
       GROUP BY date_trunc('week', created_at)
       ORDER BY date_trunc('week', created_at) ASC`,
      [params.from, params.to],
    ),
  ]);
  const totalsRow = totalsResult.rows[0];

  return {
    listingsCreatedCount: Number(totalsRow?.listings_created_count ?? 0),
    lockedSellerAccountIds: totalsRow?.locked_seller_account_ids ?? [],
    weeklyListingsCreated: weeklyResult.rows.map((row) => ({
      weekStart: row.week_start,
      listingsCreatedCount: Number(row.listings_created_count),
    })),
  };
}

export async function getSellerListing(
  db: PgQueryable,
  listingId: string,
  accountId: string,
): Promise<MarketplaceListingListRow | null> {
  const result = await db.query<MarketplaceListingPageRow>(
    `SELECT *
     FROM marketplace_listing_pages
     WHERE listing_id = $1
       AND account_id = $2`,
    [listingId, accountId],
  );

  const row = result.rows[0];
  return row ? mapListingRow(row) : null;
}

export async function getMarketSummaryForItem(
  db: PgQueryable,
  productId: string,
): Promise<MarketplaceMarketSummaryRow> {
  const result = await db.query<{
    lowest_price_amount: string | null;
    active_listing_count: string;
    total_visible_quantity: string;
  }>(
    `SELECT
       MIN(price_amount)::text AS lowest_price_amount,
       COUNT(*)::text AS active_listing_count,
       COALESCE(SUM(
         LEAST(
           listing.quantity_cap,
           GREATEST(item.total_quantity - COALESCE(active_holds.held_quantity, 0), 0)
         )
       ), 0)::text AS total_visible_quantity
     FROM marketplace_listing_pages AS listing
     INNER JOIN marketplace_supply_items AS item
       ON item.item_id = listing.inventory_item_id
     ${activeSupplyHoldQuantityJoinSql}
     LEFT JOIN marketplace_seller_listing_availability_pages AS availability
       ON availability.account_id = listing.account_id
     WHERE listing.product_id = $1
       AND listing.status = 'active'
       AND COALESCE(availability.status, 'available') = 'available'`,
    [productId],
  );

  return {
    lowest_price_amount: result.rows[0]?.lowest_price_amount ?? null,
    active_listing_count: Number(result.rows[0]?.active_listing_count ?? 0),
    total_visible_quantity: Number(result.rows[0]?.total_visible_quantity ?? 0),
  };
}

export async function listItemListings(
  db: PgQueryable,
  productId: string,
  params: Readonly<{ limit?: number; offset?: number }> = {},
): Promise<MarketplaceItemListingRow[]> {
  const limit = Math.max(
    1,
    Math.min(params.limit ?? MARKETPLACE_ITEM_LISTINGS_DEFAULT_PAGE_SIZE, MARKETPLACE_ITEM_LISTINGS_MAX_PAGE_SIZE),
  );
  const offset = Math.max(0, params.offset ?? 0);
  const result = await db.query<
    MarketplaceListingPageRow & {
      seller_display_name: string | null;
      visible_quantity: number;
    }
  >(
    `SELECT
${listingPageColumnSelectSql},
       account.display_name AS seller_display_name,
       LEAST(
         listing.quantity_cap,
         GREATEST(item.total_quantity - COALESCE(active_holds.held_quantity, 0), 0)
       ) AS visible_quantity
     FROM marketplace_listing_pages AS listing
     INNER JOIN marketplace_supply_items AS item
       ON item.item_id = listing.inventory_item_id
     ${activeSupplyHoldQuantityJoinSql}
     LEFT JOIN marketplace_account_pages AS account
       ON account.account_id = listing.account_id
     LEFT JOIN marketplace_seller_listing_availability_pages AS availability
       ON availability.account_id = listing.account_id
     WHERE listing.product_id = $1
       AND listing.status = 'active'
       AND COALESCE(availability.status, 'available') = 'available'
       AND LEAST(
         listing.quantity_cap,
         GREATEST(item.total_quantity - COALESCE(active_holds.held_quantity, 0), 0)
       ) > 0
     ORDER BY listing.price_amount ASC, listing.updated_at DESC, listing.listing_id ASC
     LIMIT $2 OFFSET $3`,
    [productId, limit, offset],
  );

  return result.rows.map((row) => {
    const mapped = mapListingRow(row);
    return {
      ...mapped,
      // Public rows never carry the raw evidence set; buyers consume
      // `public_gallery` (buyer-safe metadata only).
      listing_photos: [],
      public_gallery: toPublicListingGallery(mapped.listing_photos),
      seller_display_name: row.seller_display_name,
      visible_quantity: row.visible_quantity,
    };
  });
}
