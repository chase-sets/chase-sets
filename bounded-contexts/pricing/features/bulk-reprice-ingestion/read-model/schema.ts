import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";

/**
 * Bulk reprice ingestion (m113) owns its durable inputs/jobs/outcomes plus
 * the feature-local create-rate bucket table, all inside this feature
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
 * - `pricing_bulk_reprice_create_rate_limit_buckets`: the m110-resolved,
 *   Postgres-backed request counters shared by every API replica.
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

CREATE TABLE IF NOT EXISTS pricing_bulk_reprice_create_rate_limit_buckets (
  account_id text PRIMARY KEY,
  request_count integer NOT NULL CHECK (request_count >= 1),
  window_started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

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

export const pricingBulkRepriceIngestionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260716_pricing_bulk_reprice_one_active_job_per_account",
    description: "Enforce one queued or running bulk-reprice job per account across every API replica.",
    statements: [
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pricing_bulk_reprice_jobs_one_active_per_account_idx
  ON pricing_bulk_reprice_jobs ((payload->>'accountId'))
  WHERE job_kind = 'bulk-reprice' AND status IN ('queued', 'running')`,
    ],
  },
];
