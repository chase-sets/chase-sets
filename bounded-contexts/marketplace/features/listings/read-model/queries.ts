import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type MarketplaceListingListRow = Readonly<{
  listing_id: string;
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
  marketplace_fee_amount: string | null;
  payment_fee_amount: string | null;
  seller_net_amount: string | null;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
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
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  price_amount: string;
  marketplace_fee_amount: string | null;
  payment_fee_amount: string | null;
  seller_net_amount: string | null;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  quantity_cap: number;
  status: string;
  created_at: string;
  updated_at: string;
}>;

export type MarketplaceInventoryItemSupply = Readonly<{
  item_id: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  storage_location_name: string;
  ship_from_code: string;
  available_quantity: number;
}>;

function mapListingRow(row: MarketplaceListingPageRow): MarketplaceListingListRow {
  return {
    ...row,
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as MarketplaceListingListRow["selected_options"])
      : [],
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
    item_title: string | null;
    item_subtitle: string | null;
    selected_options: unknown;
    product_summary: string | null;
    storage_location_name: string;
    ship_from_code: string;
    available_quantity: number;
  }>(
    `SELECT
       item.item_id,
       item.account_id,
       item.catalog_catalog_item_id,
       item.product_id,
       catalog_item.title AS item_title,
       catalog_item.subtitle AS item_subtitle,
       item.selected_options,
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
       location.name AS storage_location_name,
       location.ship_from_code,
       item.total_quantity - COALESCE(active_holds.held_quantity, 0) AS available_quantity
     FROM marketplace_supply_items AS item
     INNER JOIN marketplace_supply_locations AS location
       ON location.storage_location_id = item.storage_location_id
     LEFT JOIN marketplace_catalog_items AS catalog_item
       ON catalog_item.catalog_item_id = item.catalog_catalog_item_id
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM marketplace_supply_holds
       WHERE status = 'active'
       GROUP BY item_id
     ) AS active_holds
       ON active_holds.item_id = item.item_id
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
      catalog_item.title AS item_title,
      catalog_item.subtitle AS item_subtitle,
      item.selected_options,
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
      location.name AS storage_location_name,
      location.ship_from_code,
      item.total_quantity - COALESCE(active_holds.held_quantity, 0) AS available_quantity
    FROM marketplace_supply_items AS item
    INNER JOIN marketplace_supply_locations AS location
      ON location.storage_location_id = item.storage_location_id
    LEFT JOIN marketplace_catalog_items AS catalog_item
      ON catalog_item.catalog_item_id = item.catalog_catalog_item_id
    LEFT JOIN (
      SELECT item_id, SUM(quantity)::integer AS held_quantity
      FROM marketplace_supply_holds
      WHERE status = 'active'
      GROUP BY item_id
    ) AS active_holds
      ON active_holds.item_id = item.item_id
    WHERE item.account_id = $1
      ${catalogCondition}
      AND item.total_quantity - COALESCE(active_holds.held_quantity, 0) > 0`;

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM marketplace_supply_items AS item
       LEFT JOIN (
         SELECT item_id, SUM(quantity)::integer AS held_quantity
         FROM marketplace_supply_holds
         WHERE status = 'active'
         GROUP BY item_id
       ) AS active_holds
         ON active_holds.item_id = item.item_id
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
      item_title: string | null;
      item_subtitle: string | null;
      selected_options: unknown;
      product_summary: string | null;
      storage_location_name: string;
      ship_from_code: string;
      available_quantity: number;
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
    })),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
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

export async function listActiveListingsForInventoryItem(
  db: PgQueryable,
  inventoryItemId: string,
) {
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
       COALESCE(SUM(quantity_cap), 0)::text AS total_visible_quantity
     FROM marketplace_listing_pages
     WHERE product_id = $1
       AND status = 'active'`,
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
     WHERE listing.product_id = $1
       AND listing.status = 'active'
     ORDER BY listing.price_amount ASC, listing.updated_at DESC, listing.listing_id ASC`,
    [productId],
  );

  return result.rows.map((row) => ({
    ...mapListingRow(row),
    seller_display_name: row.seller_display_name,
    visible_quantity: row.visible_quantity,
  }));
}
