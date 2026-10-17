-- Derived from bounded-contexts/inventory/features/storage-locations/read-model/schema.ts and
-- bounded-contexts/inventory/features/inventory-items/read-model/schema.ts at
-- 6feb1454cecb4a73a90845103a9a0de2a336eaad. The test pins the raw SQL hash below this header.

CREATE TABLE IF NOT EXISTS inventory_storage_locations (
  storage_location_id text PRIMARY KEY,
  account_id text NOT NULL,
  name text NOT NULL,
  description text NULL,
  ship_from_code text NOT NULL,
  ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_archived boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory_storage_locations
  ADD COLUMN IF NOT EXISTS ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS inventory_storage_locations_account_idx
  ON inventory_storage_locations (account_id, is_archived, name);

CREATE TABLE IF NOT EXISTS inventory_items (
  item_id text PRIMARY KEY,
  account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  graded_card jsonb NULL,
  storage_location_id text NOT NULL REFERENCES inventory_storage_locations(storage_location_id),
  total_quantity integer NOT NULL CHECK (total_quantity >= 0),
  last_stream_version bigint NOT NULL DEFAULT 0 CHECK (last_stream_version >= 0),
  acquisition_cost_amount numeric(12,2) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_items_account_idx
  ON inventory_items (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS inventory_items_storage_location_idx
  ON inventory_items (storage_location_id);

CREATE INDEX IF NOT EXISTS inventory_items_catalog_version_idx
  ON inventory_items (product_id);

CREATE TABLE IF NOT EXISTS inventory_item_ledger (
  ledger_entry_id text PRIMARY KEY,
  item_id text NOT NULL,
  account_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL,
  quantity_delta integer NULL,
  hold_quantity integer NULL,
  purpose text NULL,
  reason text NOT NULL,
  reason_code text NULL,
  note text NULL,
  sale_price_amount numeric(12,2) NULL,
  channel text NULL,
  source_ref jsonb NULL,
  actor text NOT NULL,
  event_type text NOT NULL,
  stream_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version >= 1),
  recorded_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_item_adjustment_idempotency (
  idempotency_key text PRIMARY KEY,
  account_id text NOT NULL,
  item_id text NOT NULL,
  command_fingerprint text NOT NULL,
  claim_generation text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  result_item_id text NULL,
  result_version bigint NULL CHECK (result_version IS NULL OR result_version >= 0),
  result_collision jsonb NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS inventory_item_adjustment_idempotency_item_idx
  ON inventory_item_adjustment_idempotency (account_id, item_id, created_at DESC);
