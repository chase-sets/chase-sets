import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type InventoryImportBatchStatus = "uploaded" | "committed";
export type InventoryImportRowStatus = "accepted" | "rejected" | "committed";

export type InventoryImportBatchRow = Readonly<{
  row_id: string;
  batch_id: string;
  row_number: number;
  status: InventoryImportRowStatus;
  raw_row: Readonly<Record<string, string>>;
  catalog_item_id: string | null;
  product_id: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  storage_location_id: string | null;
  total_quantity: number | null;
  acquisition_cost_amount: string | null;
  seller_sku: string | null;
  listing_price_amount: string | null;
  listing_quantity_cap: number | null;
  row_note: string | null;
  validation_errors: readonly string[];
  committed_inventory_item_id: string | null;
  committed_listing_id: string | null;
  committed_at: string | null;
  created_at: string;
  updated_at: string;
}>;

export type InventoryImportBatch = Readonly<{
  batch_id: string;
  account_id: string;
  status: InventoryImportBatchStatus;
  source_filename: string | null;
  total_count: number;
  accepted_count: number;
  rejected_count: number;
  committed_count: number;
  created_at: string;
  updated_at: string;
}>;

export type InventoryImportBatchDetail = InventoryImportBatch & Readonly<{
  rows: readonly InventoryImportBatchRow[];
}>;

type RawImportBatchRow = Omit<
  InventoryImportBatchRow,
  "raw_row" | "selected_options" | "validation_errors"
> & Readonly<{
  raw_row: unknown;
  selected_options: unknown;
  validation_errors: unknown;
}>;

function normalizeRow(row: RawImportBatchRow): InventoryImportBatchRow {
  return {
    ...row,
    raw_row:
      typeof row.raw_row === "object" && row.raw_row !== null && !Array.isArray(row.raw_row)
        ? (row.raw_row as Record<string, string>)
        : {},
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as InventoryImportBatchRow["selected_options"])
      : [],
    validation_errors: Array.isArray(row.validation_errors)
      ? row.validation_errors.filter((value): value is string => typeof value === "string")
      : [],
  };
}

export async function getImportBatch(
  db: PgQueryable,
  batchId: string,
  accountId: string,
): Promise<InventoryImportBatchDetail | null> {
  const batchResult = await db.query<InventoryImportBatch>(
    `SELECT
       batch_id,
       account_id,
       status,
       source_filename,
       total_count,
       accepted_count,
       rejected_count,
       committed_count,
       created_at,
       updated_at
     FROM inventory_import_batches
     WHERE batch_id = $1
       AND account_id = $2`,
    [batchId, accountId],
  );
  const batch = batchResult.rows[0];
  if (!batch) {
    return null;
  }

  const rows = await db.query<RawImportBatchRow>(
    `SELECT
       row_id,
       batch_id,
       row_number,
       status,
       raw_row,
       catalog_item_id,
       product_id,
       selected_options,
       storage_location_id,
       total_quantity,
       acquisition_cost_amount::text,
       seller_sku,
       listing_price_amount::text,
       listing_quantity_cap,
       row_note,
       validation_errors,
       committed_inventory_item_id,
       committed_listing_id,
       committed_at,
       created_at,
       updated_at
     FROM inventory_import_batch_rows
     WHERE batch_id = $1
     ORDER BY row_number ASC`,
    [batchId],
  );

  return {
    ...batch,
    rows: rows.rows.map(normalizeRow),
  };
}

export async function listImportBatches(
  db: PgQueryable,
  params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
) {
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const offset = Math.max(0, params.offset ?? 0);
  const [countResult, itemResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM inventory_import_batches
       WHERE account_id = $1`,
      [params.accountId],
    ),
    db.query<InventoryImportBatch>(
      `SELECT
         batch_id,
         account_id,
         status,
         source_filename,
         total_count,
         accepted_count,
         rejected_count,
         committed_count,
         created_at,
         updated_at
       FROM inventory_import_batches
       WHERE account_id = $1
       ORDER BY updated_at DESC, batch_id DESC
       LIMIT $2 OFFSET $3`,
      [params.accountId, limit, offset],
    ),
  ]);

  return {
    items: itemResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}
