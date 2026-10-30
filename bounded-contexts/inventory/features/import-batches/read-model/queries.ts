import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  InventoryImportExternalReference,
  InventoryImportQuantityMode,
  InventoryImportSourceKey,
} from "../domain/import-source-adapters";
import { importBatchCommitReadiness, importRowNeedsSeller } from "../domain/import-batch-review";
import { INVENTORY_IMPORT_CREATE_JOB_KINDS } from "../domain/job-kinds";

export type InventoryImportBatchStatus =
  | "uploaded"
  | "validating"
  | "ready-to-commit"
  | "committing"
  | "committed"
  | "partial"
  | "failed-safe"
  | "ambiguous"
  | "expired";
export type InventoryImportRowStatus = "accepted" | "rejected" | "committed";
export type InventoryImportResolutionStatus = "native" | "resolved" | "unresolved";

export type InventoryImportBatchRow = Readonly<{
  row_id: string;
  batch_id: string;
  row_number: number;
  status: InventoryImportRowStatus;
  raw_row: Readonly<Record<string, string>>;
  external_reference: InventoryImportExternalReference | null;
  row_fingerprint: string;
  quantity_mode: InventoryImportQuantityMode;
  quantity_delta: number | null;
  set_quantity: number | null;
  source_price_amount: string | null;
  resolution_status: InventoryImportResolutionStatus;
  catalog_item_id: string | null;
  product_id: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  storage_location_id: string | null;
  total_quantity: number | null;
  acquisition_occurred_at: string | null;
  acquisition_cost_amount: string | null;
  acquisition_cost_currency_code: string | null;
  seller_sku: string | null;
  listing_price_amount: string | null;
  listing_price_currency_code: string | null;
  listing_quantity_cap: number | null;
  row_note: string | null;
  validation_errors: readonly string[];
  committed_inventory_item_id: string | null;
  committed_listing_id: string | null;
  committed_at: string | null;
  created_at: string;
  updated_at: string;
  needs_seller: boolean;
}>;

export type InventoryImportBatch = Readonly<{
  batch_id: string;
  account_id: string;
  status: InventoryImportBatchStatus;
  source_key: InventoryImportSourceKey;
  adapter_version: number;
  quantity_mode: InventoryImportQuantityMode;
  default_storage_location_id: string | null;
  total_count: number;
  accepted_count: number;
  rejected_count: number;
  committed_count: number;
  created_at: string;
  updated_at: string;
}>;

export type InventoryImportBatchDetail = InventoryImportBatch &
  Readonly<{
    can_commit: boolean;
    commit_ready_count: number;
    rows: readonly InventoryImportBatchRow[];
  }>;

export type InventoryImportBatchResolution = InventoryImportBatchDetail &
  Readonly<{ next_needs_seller_row_id: string | null }>;

type RawImportBatchRow = Omit<
  InventoryImportBatchRow,
  "raw_row" | "external_reference" | "selected_options" | "validation_errors" | "needs_seller"
> &
  Readonly<{
    raw_row: unknown;
    external_reference: unknown;
    selected_options: unknown;
    validation_errors: unknown;
  }>;

const IMPORT_BATCH_CREATE_JOB_KINDS_SQL = INVENTORY_IMPORT_CREATE_JOB_KINDS.map((kind) => `'${kind}'`).join(", ");

const IMPORT_BATCH_STATUS_SQL = `CASE
  WHEN status = 'expired' THEN 'expired'
  WHEN total_count > 0
   AND accepted_count > 0
   AND committed_count = accepted_count
    THEN 'committed'
  WHEN EXISTS (SELECT 1 FROM inventory_import_batch_jobs AS job
    WHERE job.payload->>'batchId' = inventory_import_batches.batch_id
      AND job.payload->>'accountId' = inventory_import_batches.account_id
      AND job.job_kind = ANY(ARRAY[${IMPORT_BATCH_CREATE_JOB_KINDS_SQL}]::text[]) AND job.status = 'failed') THEN 'failed-safe'
  WHEN EXISTS (SELECT 1 FROM inventory_import_batch_jobs AS job
    WHERE job.payload->>'batchId' = inventory_import_batches.batch_id
      AND job.payload->>'accountId' = inventory_import_batches.account_id
      AND job.job_kind = ANY(ARRAY[${IMPORT_BATCH_CREATE_JOB_KINDS_SQL}]::text[]) AND job.status IN ('queued', 'running')) THEN 'validating'
  WHEN EXISTS (SELECT 1 FROM inventory_import_batch_jobs AS job
    WHERE job.payload->>'batchId' = inventory_import_batches.batch_id
      AND job.payload->>'accountId' = inventory_import_batches.account_id
      AND job.job_kind = 'commit' AND job.status IN ('queued', 'running')) THEN 'committing'
  WHEN committed_count > 0 THEN 'partial'
  WHEN EXISTS (SELECT 1 FROM inventory_import_batch_jobs AS job
    WHERE job.payload->>'batchId' = inventory_import_batches.batch_id
      AND job.payload->>'accountId' = inventory_import_batches.account_id
      AND job.job_kind = ANY(ARRAY[${IMPORT_BATCH_CREATE_JOB_KINDS_SQL}]::text[]) AND job.status = 'completed'
      AND (job.progress->>'total')::integer <> inventory_import_batches.total_count) THEN 'ambiguous'
  WHEN total_count > 0 THEN 'ready-to-commit'
  ELSE 'uploaded'
END`;

function normalizeRow(row: RawImportBatchRow, sourceKey: InventoryImportSourceKey): InventoryImportBatchRow {
  return {
    ...row,
    needs_seller: importRowNeedsSeller({
      sourceKey,
      status: row.status,
      resolutionStatus: row.resolution_status,
      productId: row.product_id,
      committedAt: row.committed_at,
    }),
    acquisition_occurred_at:
      row.acquisition_occurred_at === null || row.acquisition_occurred_at === undefined
        ? null
        : new Date(row.acquisition_occurred_at).toISOString(),
    committed_at:
      row.committed_at === null || row.committed_at === undefined ? null : new Date(row.committed_at).toISOString(),
    raw_row:
      typeof row.raw_row === "object" && row.raw_row !== null && !Array.isArray(row.raw_row)
        ? (row.raw_row as Record<string, string>)
        : {},
    external_reference:
      typeof row.external_reference === "object" &&
      row.external_reference !== null &&
      !Array.isArray(row.external_reference)
        ? (row.external_reference as InventoryImportExternalReference)
        : null,
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
  page?: Readonly<{ limit: number; offset?: number }>,
  options?: Readonly<{ stockProgressionEnabled?: boolean }>,
): Promise<InventoryImportBatchDetail | null> {
  const batchResult = await db.query<InventoryImportBatch>(
    `SELECT
       batch_id,
       account_id,
       ${IMPORT_BATCH_STATUS_SQL} AS status,
       source_key,
       adapter_version,
       quantity_mode,
       default_storage_location_id,
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
       external_reference,
       row_fingerprint,
       quantity_mode,
       quantity_delta,
       set_quantity,
       source_price_amount::text,
       resolution_status,
       catalog_item_id,
       product_id,
       selected_options,
       storage_location_id,
       total_quantity,
       acquisition_occurred_at::text,
       acquisition_cost_amount::text,
       NULLIF(raw_row->>'acquisitionCostCurrencyCode', '') AS acquisition_cost_currency_code,
       seller_sku,
       listing_price_amount::text,
       NULLIF(raw_row->>'listingPriceCurrencyCode', '') AS listing_price_currency_code,
       listing_quantity_cap,
       row_note,
       validation_errors,
       committed_inventory_item_id,
       CASE WHEN outbox.state = 'failed' THEN NULL
            ELSE import_row.committed_listing_id END AS committed_listing_id,
       committed_at,
       import_row.created_at,
       import_row.updated_at
     FROM inventory_import_batch_rows AS import_row
     LEFT JOIN inventory_import_draft_listing_outbox AS outbox
       ON outbox.message_id = import_row.row_id
     WHERE import_row.batch_id = $1
     ORDER BY import_row.row_number ASC${page ? " LIMIT $2 OFFSET $3" : ""}`,
    page ? [batchId, Math.max(0, Math.min(page.limit, 100)), Math.max(0, page.offset ?? 0)] : [batchId],
  );

  const readiness = importBatchCommitReadiness({
    status: batch.status,
    acceptedCount: batch.accepted_count,
    committedCount: batch.committed_count,
    stockProgressionEnabled: options?.stockProgressionEnabled,
  });
  return {
    ...batch,
    can_commit: readiness.canCommit,
    commit_ready_count: readiness.commitReadyCount,
    rows: rows.rows.map((row) => normalizeRow(row, batch.source_key)),
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
         ${IMPORT_BATCH_STATUS_SQL} AS status,
         source_key,
         adapter_version,
         quantity_mode,
         default_storage_location_id,
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
