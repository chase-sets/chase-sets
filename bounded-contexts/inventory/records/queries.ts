import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { InventoryHoldRow } from "../holds/queries";
import {
  summarizeVersionSelection,
  type InventoryVersionSchema,
  type InventoryVersionSelectionEntry,
} from "../catalog-items/versioning";

export type InventoryRecordListRow = Readonly<{
  record_id: string;
  account_id: string;
  catalog_item_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  version_selection: readonly InventoryVersionSelectionEntry[];
  version_summary: string | null;
  condition: string;
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

export type InventoryRecordDetailRow = InventoryRecordListRow &
  Readonly<{
    holds: readonly InventoryHoldRow[];
  }>;

type BaseInventoryRecordRow = Readonly<{
  record_id: string;
  account_id: string;
  catalog_item_id: string;
  version_selection: unknown;
  condition: string;
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
  item_id: string;
  title: string;
  subtitle: string | null;
  version_schema: unknown;
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
    `SELECT item_id, title, subtitle, version_schema
     FROM inventory_catalog_items
     WHERE item_id = ANY($1::text[])`,
    [catalogItemIds],
  );

  return new Map(result.rows.map((row) => [row.item_id, row]));
}

function enrichInventoryRecordRows(
  rows: readonly BaseInventoryRecordRow[],
  catalogItems: ReadonlyMap<string, CatalogItemSummaryRow>,
): InventoryRecordListRow[] {
  return rows.map((row) => {
    const catalogItem = catalogItems.get(row.catalog_item_id);
    const versionSelection = Array.isArray(row.version_selection)
      ? (row.version_selection as InventoryVersionSelectionEntry[])
      : [];
    const versionSchema =
      typeof catalogItem?.version_schema === "object" &&
      catalogItem.version_schema !== null
        ? (catalogItem.version_schema as InventoryVersionSchema)
        : null;

    return {
      ...row,
      item_title: catalogItem?.title ?? null,
      item_subtitle: catalogItem?.subtitle ?? null,
      version_selection: versionSelection,
      version_summary:
        summarizeVersionSelection(versionSchema, versionSelection) || null,
    };
  });
}

export async function listInventoryRecords(
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
       FROM inventory_records
       WHERE account_id = $1`,
      [params.accountId],
    ),
    db.query<BaseInventoryRecordRow>(
      `SELECT
         record.record_id,
         record.account_id,
         record.catalog_item_id,
         record.version_selection,
         record.condition,
         record.storage_location_id,
         location.name AS storage_location_name,
         location.ship_from_code,
         record.total_quantity,
         COALESCE(active_holds.held_quantity, 0) AS held_quantity,
         record.total_quantity - COALESCE(active_holds.held_quantity, 0) AS available_quantity,
         record.acquisition_cost_amount::text AS acquisition_cost_amount,
         record.created_at,
         record.updated_at
       FROM inventory_records AS record
       INNER JOIN inventory_storage_locations AS location
         ON location.storage_location_id = record.storage_location_id
       LEFT JOIN (
         SELECT record_id, SUM(quantity)::integer AS held_quantity
         FROM inventory_holds
         WHERE status = 'active'
         GROUP BY record_id
       ) AS active_holds
         ON active_holds.record_id = record.record_id
       WHERE record.account_id = $1
       ORDER BY record.updated_at DESC, record.record_id ASC
       LIMIT $2
       OFFSET $3`,
      [params.accountId, limit, offset],
    ),
  ]);

  const catalogItems = await loadCatalogItemSummaries(
    db,
    [...new Set(itemsResult.rows.map((row) => row.catalog_item_id))],
  );
  const items = enrichInventoryRecordRows(itemsResult.rows, catalogItems);

  return {
    items,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getInventoryRecord(
  db: PgQueryable,
  recordId: string,
  accountId: string,
) {
  const result = await db.query<BaseInventoryRecordRow>(
    `SELECT
       record.record_id,
       record.account_id,
       record.catalog_item_id,
       record.version_selection,
       record.condition,
       record.storage_location_id,
       location.name AS storage_location_name,
       location.ship_from_code,
       record.total_quantity,
       COALESCE(active_holds.held_quantity, 0) AS held_quantity,
       record.total_quantity - COALESCE(active_holds.held_quantity, 0) AS available_quantity,
       record.acquisition_cost_amount::text AS acquisition_cost_amount,
       record.created_at,
       record.updated_at
     FROM inventory_records AS record
     INNER JOIN inventory_storage_locations AS location
       ON location.storage_location_id = record.storage_location_id
     LEFT JOIN (
       SELECT record_id, SUM(quantity)::integer AS held_quantity
       FROM inventory_holds
       WHERE status = 'active'
       GROUP BY record_id
     ) AS active_holds
       ON active_holds.record_id = record.record_id
     WHERE record.record_id = $1
       AND record.account_id = $2`,
    [recordId, accountId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const holdsResult = await db.query<InventoryHoldRow>(
    `SELECT
       hold_id,
       account_id,
       record_id,
       quantity,
       reason,
       notes,
       status,
       created_at,
       updated_at,
       released_at
     FROM inventory_holds
     WHERE record_id = $1
       AND account_id = $2
     ORDER BY created_at DESC, hold_id DESC`,
    [recordId, accountId],
  );

  const catalogItems = await loadCatalogItemSummaries(db, [row.catalog_item_id]);
  const [enriched] = enrichInventoryRecordRows([row], catalogItems);

  return {
    ...enriched,
    holds: holdsResult.rows,
  } satisfies InventoryRecordDetailRow;
}
