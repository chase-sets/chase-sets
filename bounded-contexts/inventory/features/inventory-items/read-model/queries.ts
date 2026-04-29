import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { InventoryHoldRow } from "../../holds/read-model/queries";
import {
  summarizeSelectedOptions,
  type InventoryProductSchema,
  type InventorySelectedOptionEntry,
} from "../integrations/catalog/versioning";

export type InventoryItemListRow = Readonly<{
  item_id: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly InventorySelectedOptionEntry[];
  product_summary: string | null;
  storage_location_id: string;
  storage_location_name: string;
  ship_from_code: string;
  total_quantity: number;
  held_quantity: number;
  available_quantity: number;
  acquisition_cost_amount: string | null;
  created_at: string;
  updated_at: string;
}>;

export type InventoryItemDetailRow = InventoryItemListRow &
  Readonly<{
    holds: readonly InventoryHoldRow[];
  }>;

type BaseInventoryItemRow = Readonly<{
  item_id: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  selected_options: unknown;
  storage_location_id: string;
  storage_location_name: string;
  ship_from_code: string;
  total_quantity: number;
  held_quantity: number;
  available_quantity: number;
  acquisition_cost_amount: string | null;
  created_at: string;
  updated_at: string;
}>;

type CatalogItemSummaryRow = Readonly<{
  catalog_item_id: string;
  title: string;
  subtitle: string | null;
  product_schema: unknown;
}>;

async function loadCatalogItemSummaries(
  db: PgQueryable,
  catalogItemIds: readonly string[],
) {
  if (catalogItemIds.length === 0) {
    return new Map<string, CatalogItemSummaryRow>();
  }

  const tableResult = await db.query<{ table_name: string | null }>(
    `SELECT to_regclass('public.inventory_catalog_items') AS table_name`,
  );

  if (!tableResult.rows[0]?.table_name) {
    return new Map<string, CatalogItemSummaryRow>();
  }

  const result = await db.query<CatalogItemSummaryRow>(
    `SELECT catalog_item_id, title, subtitle, product_schema
     FROM inventory_catalog_items
     WHERE catalog_item_id = ANY($1::text[])`,
    [catalogItemIds],
  );

  return new Map(result.rows.map((row) => [row.catalog_item_id, row]));
}

function enrichInventoryItemRows(
  rows: readonly BaseInventoryItemRow[],
  catalogItems: ReadonlyMap<string, CatalogItemSummaryRow>,
): InventoryItemListRow[] {
  return rows.map((row) => {
    const catalogItem = catalogItems.get(row.catalog_catalog_item_id);
    const selectedOptions = Array.isArray(row.selected_options)
      ? (row.selected_options as InventorySelectedOptionEntry[])
      : [];
    const productSchema =
      typeof catalogItem?.product_schema === "object" &&
      catalogItem.product_schema !== null
        ? (catalogItem.product_schema as InventoryProductSchema)
        : null;

    return {
      ...row,
      item_title: catalogItem?.title ?? null,
      item_subtitle: catalogItem?.subtitle ?? null,
      selected_options: selectedOptions,
      product_summary:
        summarizeSelectedOptions(productSchema, selectedOptions) || null,
    };
  });
}

export async function listInventoryItems(
  db: PgQueryable,
  params: Readonly<{
    accountId: string;
    limit?: number;
    offset?: number;
  }>,
) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM inventory_items
       WHERE account_id = $1`,
      [params.accountId],
    ),
    db.query<BaseInventoryItemRow>(
      `SELECT
         item.item_id,
         item.account_id,
         item.catalog_catalog_item_id,
         item.product_id,
         item.selected_options,
         item.storage_location_id,
         location.name AS storage_location_name,
         location.ship_from_code,
         item.total_quantity,
         COALESCE(active_holds.held_quantity, 0) AS held_quantity,
         item.total_quantity - COALESCE(active_holds.held_quantity, 0) AS available_quantity,
         item.acquisition_cost_amount::text AS acquisition_cost_amount,
         item.created_at,
         item.updated_at
       FROM inventory_items AS item
       INNER JOIN inventory_storage_locations AS location
         ON location.storage_location_id = item.storage_location_id
       LEFT JOIN (
         SELECT item_id, SUM(quantity)::integer AS held_quantity
         FROM inventory_holds
         WHERE status = 'active'
         GROUP BY item_id
       ) AS active_holds
         ON active_holds.item_id = item.item_id
       WHERE item.account_id = $1
       ORDER BY item.updated_at DESC, item.item_id ASC
       LIMIT $2
       OFFSET $3`,
      [params.accountId, limit, offset],
    ),
  ]);

  const catalogItems = await loadCatalogItemSummaries(
    db,
    [...new Set(itemsResult.rows.map((row) => row.catalog_catalog_item_id))],
  );
  const items = enrichInventoryItemRows(itemsResult.rows, catalogItems);

  return {
    items,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getInventoryItem(
  db: PgQueryable,
  itemId: string,
  accountId: string,
) {
  const result = await db.query<BaseInventoryItemRow>(
    `SELECT
       item.item_id,
       item.account_id,
       item.catalog_catalog_item_id,
       item.product_id,
       item.selected_options,
       item.storage_location_id,
       location.name AS storage_location_name,
       location.ship_from_code,
       item.total_quantity,
       COALESCE(active_holds.held_quantity, 0) AS held_quantity,
       item.total_quantity - COALESCE(active_holds.held_quantity, 0) AS available_quantity,
       item.acquisition_cost_amount::text AS acquisition_cost_amount,
       item.created_at,
       item.updated_at
     FROM inventory_items AS item
     INNER JOIN inventory_storage_locations AS location
       ON location.storage_location_id = item.storage_location_id
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM inventory_holds
       WHERE status = 'active'
       GROUP BY item_id
     ) AS active_holds
       ON active_holds.item_id = item.item_id
     WHERE item.item_id = $1
       AND item.account_id = $2`,
    [itemId, accountId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const holdsResult = await db.query<InventoryHoldRow>(
    `SELECT
       hold_id,
       account_id,
       item_id,
       quantity,
       reason,
       notes,
       status,
       created_at,
       updated_at,
       released_at
     FROM inventory_holds
     WHERE item_id = $1
       AND account_id = $2
     ORDER BY created_at DESC, hold_id DESC`,
    [itemId, accountId],
  );

  const catalogItems = await loadCatalogItemSummaries(db, [row.catalog_catalog_item_id]);
  const [enriched] = enrichInventoryItemRows([row], catalogItems);

  return {
    ...enriched,
    holds: holdsResult.rows,
  } satisfies InventoryItemDetailRow;
}
