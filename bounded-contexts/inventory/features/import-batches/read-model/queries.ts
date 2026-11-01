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
const IMPORT_COMMIT_CENSUS_PAGE_SIZE = 100;

export type InventoryImportCommitParentCensus = Readonly<{
  total: number;
  completed: number;
  complete: boolean;
}>;

export type InventoryImportCommitCensusRow = Readonly<{
  row_id: string;
  batch_id: string;
  row_number: number;
  status: string;
}>;

type CommitCensusUnit = Readonly<{
  unit_id: string;
  unit_kind: string;
  state: string;
  payload: unknown;
  result: unknown;
  claim_owner_id: string | null;
  claim_token: string | null;
  claimed_until: string | Date | null;
}>;

type CommitCensusOutcome = Readonly<{
  row_id: string;
  batch_id: string;
  status: string;
  commit_generation: number | string;
  committed_at: string | Date | null;
}>;

function commitCensusReconciliationRequired(): never {
  throw new Error("Import commit outcomes require reconciliation.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Proves commit completion against the immutable accepted-row input and the
 * durable row outcomes. Every page is read to exhaustion; counters and the
 * presence of a work-unit container are never completion authority.
 */
export async function censusImportCommitParent(
  db: PgQueryable,
  input: Readonly<{
    jobId: string;
    inputId: string;
    batchId: string;
    accountId: string;
    acceptedRows: readonly InventoryImportCommitCensusRow[];
  }>,
): Promise<InventoryImportCommitParentCensus> {
  const total = input.acceptedRows.length;
  const acceptedRows = new Map<string, { rowNumber: number; batchId: string; status: string }>();
  const completedRows = new Set<string>();
  let ordinal = 0;
  let completed = 0;
  let sawNonterminal = false;

  for (;;) {
    const page = await db.query<{
      ordinal: number | string;
      row_id: string | null;
      row_number: number | string | null;
      expected_batch_id: string | null;
      expected_status: string | null;
      unit: CommitCensusUnit | null;
      outcome: CommitCensusOutcome | null;
    }>(
      `SELECT ($3::integer + frozen.ordinal)::integer AS ordinal,
              frozen.value->>'row_id' AS row_id,
              frozen.value->>'row_number' AS row_number,
              frozen.value->>'batch_id' AS expected_batch_id,
              frozen.value->>'status' AS expected_status,
              jsonb_build_object(
                'unit_id', unit.unit_id,
                'unit_kind', unit.unit_kind,
                'state', unit.state,
                'payload', unit.payload,
                'result', unit.result,
                'claim_owner_id', unit.claim_owner_id,
                'claim_token', unit.claim_token,
                'claimed_until', unit.claimed_until
              ) AS unit,
              jsonb_build_object(
                'row_id', outcome.row_id,
                'batch_id', outcome.batch_id,
                'status', outcome.status,
                'commit_generation', outcome.commit_generation,
                'committed_at', outcome.committed_at
              ) AS outcome
       FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS frozen(value, ordinal)
       LEFT JOIN inventory_import_batch_work_units AS unit
         ON unit.job_id = $2 AND unit.unit_id = frozen.value->>'row_id'
       LEFT JOIN inventory_import_batch_rows AS outcome
         ON outcome.row_id = frozen.value->>'row_id'
       ORDER BY frozen.ordinal
       LIMIT $4`,
      [
        JSON.stringify(input.acceptedRows.slice(ordinal, ordinal + IMPORT_COMMIT_CENSUS_PAGE_SIZE)),
        input.jobId,
        ordinal,
        IMPORT_COMMIT_CENSUS_PAGE_SIZE,
      ],
    );
    if (page.rows.length === 0) {
      if (ordinal < total) return commitCensusReconciliationRequired();
      break;
    }
    for (const row of page.rows) {
      const nextOrdinal = Number(row.ordinal);
      if (!Number.isSafeInteger(nextOrdinal) || nextOrdinal <= ordinal) return commitCensusReconciliationRequired();
      ordinal = nextOrdinal;
      if (
        typeof row.row_id !== "string" ||
        row.row_id.length === 0 ||
        typeof row.expected_batch_id !== "string" ||
        typeof row.expected_status !== "string"
      )
        return commitCensusReconciliationRequired();
      const rowNumber = Number(row.row_number);
      if (
        !Number.isSafeInteger(rowNumber) ||
        rowNumber < 0 ||
        row.expected_batch_id !== input.batchId ||
        !["accepted", "committed"].includes(row.expected_status)
      )
        return commitCensusReconciliationRequired();
      if (acceptedRows.has(row.row_id)) return commitCensusReconciliationRequired();
      acceptedRows.set(row.row_id, { rowNumber, batchId: row.expected_batch_id, status: row.expected_status });
      const unit = row.unit;
      const outcome = row.outcome;
      if (!unit || !outcome || unit.unit_id !== row.row_id || unit.unit_kind !== "commit-row-v1")
        return commitCensusReconciliationRequired();
      if (
        outcome.row_id !== row.row_id ||
        outcome.batch_id !== input.batchId ||
        !["accepted", "committed"].includes(outcome.status)
      ) {
        return commitCensusReconciliationRequired();
      }
      if (unit.claim_owner_id !== null || unit.claim_token !== null || unit.claimed_until !== null) {
        return commitCensusReconciliationRequired();
      }
      if (unit.state === "queued") {
        if (outcome.status !== "accepted" && outcome.status !== "committed")
          return commitCensusReconciliationRequired();
        sawNonterminal = true;
        continue;
      }
      if (unit.state !== "completed") return commitCensusReconciliationRequired();
      if (!isRecord(unit.payload) || Number(unit.payload.rowNumber) !== rowNumber)
        return commitCensusReconciliationRequired();
      if (!isRecord(unit.result) || unit.result.rowId !== row.row_id || unit.result.status !== "committed")
        return commitCensusReconciliationRequired();
      if (
        outcome.row_id !== row.row_id ||
        outcome.batch_id !== input.batchId ||
        outcome.status !== "committed" ||
        !Number.isSafeInteger(Number(outcome.commit_generation)) ||
        Number(outcome.commit_generation) < 1 ||
        outcome.committed_at === null
      ) {
        return commitCensusReconciliationRequired();
      }
      if (completedRows.has(row.row_id)) return commitCensusReconciliationRequired();
      completedRows.add(row.row_id);
      completed += 1;
    }
  }

  if (ordinal !== total || acceptedRows.size !== total || completedRows.size !== completed) {
    return commitCensusReconciliationRequired();
  }

  let afterUnitId = "";
  let unitCount = 0;
  for (;;) {
    const units = await db.query<CommitCensusUnit>(
      `SELECT unit_id, unit_kind, state, payload, result, claim_owner_id, claim_token, claimed_until
       FROM inventory_import_batch_work_units
       WHERE job_id = $1 AND unit_id > $2
       ORDER BY unit_id
       LIMIT $3`,
      [input.jobId, afterUnitId, IMPORT_COMMIT_CENSUS_PAGE_SIZE],
    );
    if (units.rows.length === 0) break;
    for (const unit of units.rows) {
      afterUnitId = unit.unit_id;
      unitCount += 1;
      if (unit.unit_kind !== "commit-row-v1" || !acceptedRows.has(unit.unit_id))
        return commitCensusReconciliationRequired();
    }
  }
  if (unitCount !== total) return commitCensusReconciliationRequired();

  return { total, completed, complete: total > 0 && !sawNonterminal && completed === total };
}

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
       updated_at::text AS updated_at
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
       import_row.updated_at::text AS updated_at
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
