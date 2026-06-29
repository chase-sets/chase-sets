export const checkoutInventorySupplySchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_supply_locations (
  storage_location_id text PRIMARY KEY,
  account_id text NOT NULL,
  name text NOT NULL,
  ship_from_code text NOT NULL,
  ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_archived boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checkout_supply_items (
  item_id text PRIMARY KEY,
  account_id text NULL,
  catalog_catalog_item_id text NULL,
  product_id text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  graded_card jsonb NULL,
  storage_location_id text NULL,
  total_quantity integer NOT NULL,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checkout_supply_holds (
  hold_id text PRIMARY KEY,
  item_id text NOT NULL,
  quantity integer NOT NULL,
  status text NOT NULL,
  released_at timestamptz NULL,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE checkout_supply_locations
  ADD COLUMN IF NOT EXISTS account_id text NULL,
  ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ship_from_code text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE checkout_supply_items
  ADD COLUMN IF NOT EXISTS account_id text NULL,
  ADD COLUMN IF NOT EXISTS catalog_catalog_item_id text NULL,
  ADD COLUMN IF NOT EXISTS product_id text NULL,
  ADD COLUMN IF NOT EXISTS selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS graded_card jsonb NULL,
  ADD COLUMN IF NOT EXISTS storage_location_id text NULL;

CREATE INDEX IF NOT EXISTS checkout_supply_holds_item_idx
  ON checkout_supply_holds (item_id, status);

CREATE INDEX IF NOT EXISTS checkout_supply_locations_account_idx
  ON checkout_supply_locations (account_id, is_archived, name);

CREATE INDEX IF NOT EXISTS checkout_supply_items_account_idx
  ON checkout_supply_items (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS checkout_supply_items_product_idx
  ON checkout_supply_items (product_id);
`;
