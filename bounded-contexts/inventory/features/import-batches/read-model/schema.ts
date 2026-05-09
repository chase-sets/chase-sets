export const inventoryImportBatchSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_import_batches (
  batch_id text PRIMARY KEY,
  account_id text NOT NULL,
  status text NOT NULL,
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
`;
