import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type MarketplaceListingListRow = Readonly<{
  listing_id: string;
  account_id: string;
  inventory_record_id: string;
  catalog_item_id: string;
  catalog_version_key: string;
  item_title: string | null;
  item_subtitle: string | null;
  version_selection: readonly { dimensionId: string; choiceId: string }[];
  version_summary: string | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  quantity_cap: number;
  status: string;
  created_at: string;
  updated_at: string;
}>;

export type MarketplaceItemListingRow = MarketplaceListingListRow &
  Readonly<{
    seller_display_name: string | null;
    visible_quantity: number;
  }>;

export type MarketplaceMarketSummaryRow = Readonly<{
  lowest_price_amount: string | null;
  active_listing_count: number;
  total_visible_quantity: number;
}>;

type MarketplaceListingPageRow = Readonly<{
  listing_id: string;
  account_id: string;
  inventory_record_id: string;
  catalog_item_id: string;
  catalog_version_key: string;
  item_title: string | null;
  item_subtitle: string | null;
  version_selection: unknown;
  version_summary: string | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  quantity_cap: number;
  status: string;
  created_at: string;
  updated_at: string;
}>;

export type MarketplaceInventoryRecordSupply = Readonly<{
  record_id: string;
  account_id: string;
  catalog_item_id: string;
  catalog_version_key: string;
  item_title: string | null;
  item_subtitle: string | null;
  version_selection: readonly { dimensionId: string; choiceId: string }[];
  version_summary: string | null;
  storage_location_name: string;
  ship_from_code: string;
  available_quantity: number;
}>;

function mapListingRow(row: MarketplaceListingPageRow): MarketplaceListingListRow {
  return {
    ...row,
    version_selection: Array.isArray(row.version_selection)
      ? (row.version_selection as MarketplaceListingListRow["version_selection"])
      : [],
  };
}

export async function getInventoryRecordSupply(
  db: PgQueryable,
  recordId: string,
  accountId?: string,
): Promise<MarketplaceInventoryRecordSupply | null> {
  const values: unknown[] = [recordId];
  const accountCondition = accountId ? "AND record.account_id = $2" : "";
  if (accountId) {
    values.push(accountId);
  }

  const result = await db.query<{
    record_id: string;
    account_id: string;
    catalog_item_id: string;
    catalog_version_key: string;
    item_title: string | null;
    item_subtitle: string | null;
    version_selection: unknown;
    version_summary: string | null;
    storage_location_name: string;
    ship_from_code: string;
    available_quantity: number;
  }>(
    `SELECT
       record.record_id,
       record.account_id,
       record.catalog_item_id,
       record.catalog_version_key,
       catalog_item.title AS item_title,
       catalog_item.subtitle AS item_subtitle,
       record.version_selection,
       (
         CASE
           WHEN catalog_item.version_schema IS NULL THEN NULL
           ELSE (
             SELECT string_agg(part, ' | ' ORDER BY ordinality)
             FROM (
               SELECT
                 ordinality,
                 COALESCE(dimension->>'dimensionName', dimension->>'dimensionId') || ': ' ||
                 COALESCE(
                   choice->'labels'->0->>'value',
                   choice->>'code',
                   selection->>'choiceId'
                 ) AS part
               FROM jsonb_array_elements(record.version_selection) WITH ORDINALITY AS selected(selection, ordinality)
               LEFT JOIN LATERAL (
                 SELECT dimension
                 FROM jsonb_array_elements(COALESCE(catalog_item.version_schema->'dimensions', '[]'::jsonb)) AS dimension
                 WHERE dimension->>'dimensionId' = selection->>'dimensionId'
               ) matched_dimension ON TRUE
               LEFT JOIN LATERAL (
                 SELECT choice
                 FROM jsonb_array_elements(COALESCE(matched_dimension.dimension->'allowedChoices', '[]'::jsonb)) AS choice
                 WHERE choice->>'choiceId' = selection->>'choiceId'
               ) matched_choice ON TRUE
             ) parts
           )
         END
       ) AS version_summary,
       location.name AS storage_location_name,
       location.ship_from_code,
       record.total_quantity - COALESCE(active_holds.held_quantity, 0) AS available_quantity
     FROM marketplace_supply_records AS record
     INNER JOIN marketplace_supply_locations AS location
       ON location.storage_location_id = record.storage_location_id
     LEFT JOIN marketplace_catalog_items AS catalog_item
       ON catalog_item.item_id = record.catalog_item_id
     LEFT JOIN (
       SELECT record_id, SUM(quantity)::integer AS held_quantity
       FROM marketplace_supply_holds
       WHERE status = 'active'
       GROUP BY record_id
     ) AS active_holds
       ON active_holds.record_id = record.record_id
     WHERE record.record_id = $1
       ${accountCondition}`,
    values,
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    ...row,
    version_selection: Array.isArray(row.version_selection)
      ? (row.version_selection as MarketplaceInventoryRecordSupply["version_selection"])
      : [],
  };
}

export async function getActiveQuantityCapForInventoryRecord(
  db: PgQueryable,
  inventoryRecordId: string,
  excludeListingId?: string,
): Promise<number> {
  const values: unknown[] = [inventoryRecordId];
  let excludeSql = "";

  if (excludeListingId) {
    values.push(excludeListingId);
    excludeSql = `AND listing_id != $2`;
  }

  const result = await db.query<{ quantity_cap: string }>(
    `SELECT COALESCE(SUM(quantity_cap), 0)::text AS quantity_cap
     FROM marketplace_listing_pages
     WHERE inventory_record_id = $1
       AND status = 'active'
       ${excludeSql}`,
    values,
  );

  return Number(result.rows[0]?.quantity_cap ?? 0);
}

export async function listActiveListingsForInventoryRecord(
  db: PgQueryable,
  inventoryRecordId: string,
) {
  const result = await db.query<MarketplaceListingPageRow>(
    `SELECT *
     FROM marketplace_listing_pages
     WHERE inventory_record_id = $1
       AND status = 'active'
     ORDER BY updated_at DESC, listing_id DESC`,
    [inventoryRecordId],
  );

  return result.rows.map(mapListingRow);
}

export async function listSellerListings(
  db: PgQueryable,
  params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
): Promise<{ items: MarketplaceListingListRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_listing_pages
       WHERE account_id = $1`,
      [params.accountId],
    ),
    db.query<MarketplaceListingPageRow>(
      `SELECT *
       FROM marketplace_listing_pages
       WHERE account_id = $1
       ORDER BY updated_at DESC, listing_id DESC
       LIMIT $2 OFFSET $3`,
      [params.accountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows.map(mapListingRow),
    total: Number(countResult.rows[0]?.count ?? 0),
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
  catalogVersionKey: string,
): Promise<MarketplaceMarketSummaryRow> {
  const result = await db.query<{
    lowest_price_amount: string | null;
    active_listing_count: string;
    total_visible_quantity: string;
  }>(
    `SELECT
       MIN(price_amount)::text AS lowest_price_amount,
       COUNT(*)::text AS active_listing_count,
       COALESCE(SUM(quantity_cap), 0)::text AS total_visible_quantity
     FROM marketplace_listing_pages
     WHERE catalog_version_key = $1
       AND status = 'active'`,
    [catalogVersionKey],
  );

  return {
    lowest_price_amount: result.rows[0]?.lowest_price_amount ?? null,
    active_listing_count: Number(result.rows[0]?.active_listing_count ?? 0),
    total_visible_quantity: Number(result.rows[0]?.total_visible_quantity ?? 0),
  };
}

export async function listItemListings(
  db: PgQueryable,
  catalogVersionKey: string,
): Promise<MarketplaceItemListingRow[]> {
  const result = await db.query<
    MarketplaceListingPageRow & {
      seller_display_name: string | null;
      visible_quantity: number;
    }
  >(
    `SELECT
       listing.*,
       account.display_name AS seller_display_name,
       listing.quantity_cap AS visible_quantity
     FROM marketplace_listing_pages AS listing
     LEFT JOIN marketplace_account_pages AS account
       ON account.account_id = listing.account_id
     WHERE listing.catalog_version_key = $1
       AND listing.status = 'active'
     ORDER BY listing.price_amount ASC, listing.updated_at DESC, listing.listing_id ASC`,
    [catalogVersionKey],
  );

  return result.rows.map((row) => ({
    ...mapListingRow(row),
    seller_display_name: row.seller_display_name,
    visible_quantity: row.visible_quantity,
  }));
}
