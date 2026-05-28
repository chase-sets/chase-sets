import { durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";

export const inventoryImportBatchSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_import_batches (
  batch_id text PRIMARY KEY,
  account_id text NOT NULL,
  status text NOT NULL,
  source_key text NOT NULL DEFAULT 'native-csv',
  adapter_version integer NOT NULL DEFAULT 1,
  quantity_mode text NOT NULL DEFAULT 'add',
  default_storage_location_id text NULL,
  source_filename text NULL,
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
  acquisition_cost_amount numeric(12, 2) NULL,
  seller_sku text NULL,
  listing_price_amount numeric(12, 2) NULL,
  listing_quantity_cap integer NULL,
  row_note text NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  committed_inventory_item_id text NULL,
  committed_listing_id text NULL,
  committed_at timestamptz NULL,
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
  csv_text text NULL,
  parsed_rows jsonb NULL,
  source_key text NULL,
  quantity_mode text NULL,
  default_storage_location_id text NULL,
  source_filename text NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS inventory_import_batch_job_inputs_account_idx
  ON inventory_import_batch_job_inputs (account_id, created_at DESC);

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
  ADD COLUMN IF NOT EXISTS resolution_status text NOT NULL DEFAULT 'native';

${durableJobSchemaSql({
  jobsTable: "inventory_import_batch_jobs",
  eventsTable: "inventory_import_batch_job_events",
})}
`;
