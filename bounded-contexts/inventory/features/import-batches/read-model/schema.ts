import { durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";
import { durableJobWorkUnitSchemaSql } from "@chase-sets/platform-runtime/durable-job-work-units";
import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { contractInventoryImportSources } from "../api/source-migration";
import { inventoryDraftListingOutboxSchemaSql } from "../api/draft-listing-delivery";

export const inventoryImportSnapshotSchemaSql = `
ALTER TABLE inventory_import_batch_job_inputs
  ADD COLUMN IF NOT EXISTS snapshot_version integer NULL,
  ADD COLUMN IF NOT EXISTS snapshot_hash text NULL,
  ADD COLUMN IF NOT EXISTS row_count integer NULL,
  ADD COLUMN IF NOT EXISTS adapter_version integer NULL;

CREATE TABLE IF NOT EXISTS inventory_import_snapshot_rows (
  input_id text NOT NULL REFERENCES inventory_import_batch_job_inputs(input_id) ON DELETE CASCADE,
  row_number integer NOT NULL CHECK (row_number > 0),
  snapshot_version integer NOT NULL CHECK (snapshot_version = 1),
  row_hash text NOT NULL CHECK (row_hash ~ '^[a-f0-9]{64}$'),
  snapshot_row jsonb NOT NULL,
  row_index integer NOT NULL CHECK (row_index >= 0),
  row_proof jsonb NOT NULL,
  UNIQUE (input_id, row_index),
  PRIMARY KEY (input_id, row_number)
);

CREATE TABLE IF NOT EXISTS inventory_import_source_cleanup (
  input_id text PRIMARY KEY,
  snapshot_version integer NOT NULL,
  snapshot_hash text NOT NULL,
  reason text NOT NULL,
  deleted_at timestamptz NOT NULL
);
`;

export const inventoryImportBatchSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_import_batches (
  batch_id text PRIMARY KEY,
  account_id text NOT NULL,
  status text NOT NULL,
  source_key text NOT NULL DEFAULT 'native-csv',
  adapter_version integer NOT NULL DEFAULT 1,
  quantity_mode text NOT NULL DEFAULT 'add',
  default_storage_location_id text NULL,
  total_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  committed_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_import_batch_rows (
  row_id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES inventory_import_batches(batch_id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  status text NOT NULL,
  raw_row jsonb NOT NULL DEFAULT '{}'::jsonb,
  external_reference jsonb NULL,
  row_fingerprint text NOT NULL DEFAULT '',
  quantity_mode text NOT NULL DEFAULT 'add',
  quantity_delta integer NULL,
  set_quantity integer NULL,
  source_price_amount numeric(12, 2) NULL,
  resolution_status text NOT NULL DEFAULT 'native',
  catalog_item_id text NULL,
  product_id text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  storage_location_id text NULL,
  total_quantity integer NULL,
  acquisition_occurred_at timestamptz NULL,
  acquisition_cost_amount numeric(12, 2) NULL,
  seller_sku text NULL,
  listing_price_amount numeric(12, 2) NULL,
  listing_quantity_cap integer NULL,
  row_note text NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  committed_inventory_item_id text NULL,
  committed_listing_id text NULL,
  committed_at timestamptz NULL,
  commit_generation integer NOT NULL DEFAULT 0,
  commit_claim_token text NULL,
  commit_claimed_until timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (batch_id, row_number)
);

CREATE INDEX IF NOT EXISTS inventory_import_batches_account_idx
  ON inventory_import_batches (account_id, updated_at DESC, batch_id DESC);

CREATE INDEX IF NOT EXISTS inventory_import_batch_rows_batch_idx
  ON inventory_import_batch_rows (batch_id, row_number ASC);

CREATE TABLE IF NOT EXISTS inventory_import_batch_job_inputs (
  input_id text PRIMARY KEY,
  account_id text NOT NULL,
  source_key text NULL,
  quantity_mode text NULL,
  default_storage_location_id text NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_import_commit_inputs (
  input_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  actor_user_id text NOT NULL,
  account_id text NOT NULL,
  batch_id text NOT NULL REFERENCES inventory_import_batches(batch_id) ON DELETE CASCADE,
  snapshot_version integer NOT NULL CHECK (snapshot_version = 1),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  row_count integer NOT NULL CHECK (row_count >= 0),
  accepted_rows jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS inventory_import_commit_inputs_batch_idx
  ON inventory_import_commit_inputs (account_id, batch_id, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_import_batch_job_inputs_account_idx
  ON inventory_import_batch_job_inputs (account_id, created_at DESC);

${inventoryImportSnapshotSchemaSql}

CREATE TABLE IF NOT EXISTS inventory_import_account_sku_mappings (
  mapping_id text PRIMARY KEY,
  account_id text NOT NULL,
  seller_sku text NOT NULL,
  normalized_seller_sku text NOT NULL,
  catalog_item_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS inventory_import_account_sku_mappings_lookup_idx
  ON inventory_import_account_sku_mappings (account_id, normalized_seller_sku, updated_at DESC);

ALTER TABLE inventory_import_batches
  ADD COLUMN IF NOT EXISTS source_key text NOT NULL DEFAULT 'native-csv',
  ADD COLUMN IF NOT EXISTS adapter_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS quantity_mode text NOT NULL DEFAULT 'add',
  ADD COLUMN IF NOT EXISTS default_storage_location_id text NULL;

ALTER TABLE inventory_import_batch_rows
  ADD COLUMN IF NOT EXISTS external_reference jsonb NULL,
  ADD COLUMN IF NOT EXISTS row_fingerprint text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS quantity_mode text NOT NULL DEFAULT 'add',
  ADD COLUMN IF NOT EXISTS quantity_delta integer NULL,
  ADD COLUMN IF NOT EXISTS set_quantity integer NULL,
  ADD COLUMN IF NOT EXISTS source_price_amount numeric(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS resolution_status text NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS catalog_item_id text NULL,
  ADD COLUMN IF NOT EXISTS product_id text NULL,
  ADD COLUMN IF NOT EXISTS selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS storage_location_id text NULL,
  ADD COLUMN IF NOT EXISTS total_quantity integer NULL,
  ADD COLUMN IF NOT EXISTS acquisition_occurred_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS acquisition_cost_amount numeric(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS seller_sku text NULL,
  ADD COLUMN IF NOT EXISTS listing_price_amount numeric(12, 2) NULL,
  ADD COLUMN IF NOT EXISTS listing_quantity_cap integer NULL,
  ADD COLUMN IF NOT EXISTS row_note text NULL,
  ADD COLUMN IF NOT EXISTS validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS committed_inventory_item_id text NULL,
  ADD COLUMN IF NOT EXISTS committed_listing_id text NULL,
  ADD COLUMN IF NOT EXISTS committed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS commit_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commit_claim_token text NULL,
  ADD COLUMN IF NOT EXISTS commit_claimed_until timestamptz NULL;

${durableJobSchemaSql({
  jobsTable: "inventory_import_batch_jobs",
  eventsTable: "inventory_import_batch_job_events",
})}

CREATE INDEX IF NOT EXISTS inventory_import_batch_jobs_batch_state_idx
  ON inventory_import_batch_jobs ((payload->>'accountId'), (payload->>'batchId'), job_kind, status);

${durableJobWorkUnitSchemaSql({
  jobsTable: "inventory_import_batch_jobs",
  workUnitsTable: "inventory_import_batch_work_units",
})}

${inventoryDraftListingOutboxSchemaSql}
`;

export const inventoryImportBatchSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261028_inventory_import_row_commit_fences",
    description: "Fence frozen import row effects to one durable work-unit claim.",
    statements: [
      `ALTER TABLE inventory_import_batch_rows
         ADD COLUMN IF NOT EXISTS commit_generation integer NOT NULL DEFAULT 0,
         ADD COLUMN IF NOT EXISTS commit_claim_token text NULL,
         ADD COLUMN IF NOT EXISTS commit_claimed_until timestamptz NULL;`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_import_batch_rows_commit_claim_idx
         ON inventory_import_batch_rows (batch_id, commit_claimed_until, row_id);`,
    ],
  },
  {
    migrationId: "20261027_inventory_import_commit_inputs",
    description: "Persist immutable accepted import rows for durable commit jobs.",
    statements: [
      `CREATE TABLE IF NOT EXISTS inventory_import_commit_inputs (
  input_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  actor_user_id text NOT NULL,
  account_id text NOT NULL,
  batch_id text NOT NULL REFERENCES inventory_import_batches(batch_id) ON DELETE CASCADE,
  snapshot_version integer NOT NULL CHECK (snapshot_version = 1),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  row_count integer NOT NULL CHECK (row_count >= 0),
  accepted_rows jsonb NOT NULL,
  created_at timestamptz NOT NULL
);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_import_commit_inputs_batch_idx
        ON inventory_import_commit_inputs (account_id, batch_id, created_at DESC)`,
    ],
  },
  {
    migrationId: "20261016_inventory_import_safe_snapshots",
    description: "Install safe versioned import source readers and bounded row storage before writer cutover.",
    statements: [
      inventoryImportSnapshotSchemaSql,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_import_batch_jobs_batch_state_idx
        ON inventory_import_batch_jobs ((payload->>'accountId'), (payload->>'batchId'), job_kind, status)`,
    ],
  },
  // Runs after the safe-snapshot readers it converts into; the runner applies this array in order.
  {
    migrationId: "20261020_inventory_import_raw_source_contraction",
    description:
      "Convert leftover legacy import sources, re-sanitize retained history and drop the raw-source columns.",
    statements: [
      "SET LOCAL lock_timeout = '5s'",
      `ALTER TABLE inventory_import_batch_job_inputs
  DROP COLUMN IF EXISTS csv_text,
  DROP COLUMN IF EXISTS parsed_rows,
  DROP COLUMN IF EXISTS source_filename`,
      "ALTER TABLE inventory_import_batches DROP COLUMN IF EXISTS source_filename",
    ],
    dataStep: contractInventoryImportSources,
  },
  {
    migrationId: "20261006_inventory_import_product_resolution_scan",
    description: "Index the bounded rejected/uncommitted Product resolution keyset scan.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_import_batch_rows_product_resolution_scan_idx
  ON inventory_import_batch_rows (created_at, row_id)
  WHERE status = 'rejected' AND committed_at IS NULL`,
    ],
  },
  {
    migrationId: "20260908_inventory_import_acquisition_occurrence",
    description: "Preserve import-supplied acquisition occurrence through staged Inventory rows.",
    statements: [
      `ALTER TABLE inventory_import_batch_rows
  ADD COLUMN IF NOT EXISTS acquisition_occurred_at timestamptz NULL`,
    ],
  },
];
