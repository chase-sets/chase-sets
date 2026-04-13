export const marketplaceSupplyProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_account_pages (
  account_id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_catalog_items (
  item_id text PRIMARY KEY,
  title text NOT NULL,
  subtitle text NULL,
  blueprint_id text NULL,
  status text NOT NULL,
  version_schema jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_catalog_blueprints (
  blueprint_id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonical_dimension_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_catalog_dimensions (
  dimension_id text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_catalog_dimension_choices (
  choice_id text PRIMARY KEY,
  dimension_id text NOT NULL,
  code text NOT NULL,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_supply_locations (
  storage_location_id text PRIMARY KEY,
  account_id text NOT NULL,
  name text NOT NULL,
  ship_from_code text NOT NULL,
  is_archived boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_supply_records (
  record_id text PRIMARY KEY,
  account_id text NOT NULL,
  catalog_item_id text NOT NULL,
  catalog_version_key text NOT NULL,
  version_selection jsonb NOT NULL DEFAULT '[]'::jsonb,
  storage_location_id text NOT NULL,
  total_quantity integer NOT NULL,
  acquisition_cost_amount numeric(12,2) NULL,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_supply_holds (
  hold_id text PRIMARY KEY,
  account_id text NOT NULL,
  record_id text NOT NULL,
  quantity integer NOT NULL,
  status text NOT NULL,
  released_at timestamptz NULL,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_account_pages_status_idx
  ON marketplace_account_pages (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_catalog_items_blueprint_idx
  ON marketplace_catalog_items (blueprint_id);

CREATE INDEX IF NOT EXISTS marketplace_catalog_items_status_idx
  ON marketplace_catalog_items (status);

CREATE INDEX IF NOT EXISTS marketplace_catalog_dimension_choices_dimension_idx
  ON marketplace_catalog_dimension_choices (dimension_id);

CREATE INDEX IF NOT EXISTS marketplace_supply_locations_account_idx
  ON marketplace_supply_locations (account_id, is_archived, name);

CREATE INDEX IF NOT EXISTS marketplace_supply_records_account_idx
  ON marketplace_supply_records (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_supply_records_storage_location_idx
  ON marketplace_supply_records (storage_location_id);

CREATE INDEX IF NOT EXISTS marketplace_supply_records_catalog_version_idx
  ON marketplace_supply_records (catalog_version_key);

CREATE INDEX IF NOT EXISTS marketplace_supply_holds_record_idx
  ON marketplace_supply_holds (record_id, status);
`;
