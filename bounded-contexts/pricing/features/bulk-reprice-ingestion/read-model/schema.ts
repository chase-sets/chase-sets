import { durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";

/**
 * Bulk reprice ingestion (m113) owns three tables, all inside this feature
 * directory so a removal is exactly "drop this file's DDL + delete the
 * directory" (see ../../../docs/bulk-reprice-ingestion.md):
 *
 * - `pricing_bulk_reprice_job_inputs`: the staged upload (parsed rows as
 *   jsonb) a job references by `inputId`, mirroring Inventory's
 *   `inventory_import_batch_job_inputs` staging-table pattern so a job's
 *   payload stays small and indexable instead of carrying up to 250k rows
 *   inline.
 * - `pricing_bulk_reprice_jobs` / `pricing_bulk_reprice_job_events`: the
 *   generic durable-job-store tables (enqueue/claim/progress/SSE replay).
 * - `pricing_bulk_reprice_rows`: per-row outcome tracking (applied /
 *   unchanged / failed), upserted per processing wave and read back for the
 *   downloadable results CSV.
 */
export const pricingBulkRepriceIngestionSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_bulk_reprice_job_inputs (
  input_id text PRIMARY KEY,
  account_id text NOT NULL,
  rows jsonb NOT NULL,
  row_count integer NOT NULL,
  source_filename text NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_bulk_reprice_job_inputs_account_idx
  ON pricing_bulk_reprice_job_inputs (account_id, created_at DESC);

${durableJobSchemaSql({
  jobsTable: "pricing_bulk_reprice_jobs",
  eventsTable: "pricing_bulk_reprice_job_events",
})}

CREATE TABLE IF NOT EXISTS pricing_bulk_reprice_rows (
  job_id text NOT NULL,
  row_number integer NOT NULL,
  seller_sku text NULL,
  listing_id text NULL,
  requested_price_amount numeric(12, 2) NULL,
  resolved_listing_id text NULL,
  previous_price_amount numeric(12, 2) NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied', 'unchanged', 'failed')),
  error_message text NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, row_number)
);

CREATE INDEX IF NOT EXISTS pricing_bulk_reprice_rows_job_outcome_idx
  ON pricing_bulk_reprice_rows (job_id, outcome);
`;
