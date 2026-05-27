export const marketplaceSupplyProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_account_pages (
  account_id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL,
  badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  average_rating numeric(4, 2) NULL,
  review_count integer NOT NULL DEFAULT 0,
  rating_1_count integer NOT NULL DEFAULT 0,
  rating_2_count integer NOT NULL DEFAULT 0,
  rating_3_count integer NOT NULL DEFAULT 0,
  rating_4_count integer NOT NULL DEFAULT 0,
  rating_5_count integer NOT NULL DEFAULT 0,
  reputation_updated_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketplace_account_pages
  ADD COLUMN IF NOT EXISTS badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS average_rating numeric(4, 2) NULL,
  ADD COLUMN IF NOT EXISTS review_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_1_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_2_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_3_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_4_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rating_5_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reputation_updated_at timestamptz NULL;

CREATE TABLE IF NOT EXISTS marketplace_account_reviews (
  review_id text PRIMARY KEY,
  subject_account_id text NOT NULL,
  rating integer NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS marketplace_account_reviews_subject_idx
  ON marketplace_account_reviews (subject_account_id, status);

CREATE TABLE IF NOT EXISTS marketplace_catalog_items (
  catalog_item_id text PRIMARY KEY,
  language_code text NOT NULL DEFAULT 'en',
  title text NOT NULL,
  subtitle text NULL,
  blueprint_id text NULL,
  status text NOT NULL,
  product_measure_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_schema jsonb NULL,
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

CREATE TABLE IF NOT EXISTS marketplace_catalog_dimension_options (
  option_id text PRIMARY KEY,
  dimension_id text NOT NULL,
  code text NOT NULL,
  label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  label text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketplace_catalog_dimension_options
  ADD COLUMN IF NOT EXISTS label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';

ALTER TABLE marketplace_catalog_items
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS product_measure_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS marketplace_supply_locations (
  storage_location_id text PRIMARY KEY,
  account_id text NOT NULL,
  name text NOT NULL,
  ship_from_code text NOT NULL,
  ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_archived boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_supply_items (
  item_id text PRIMARY KEY,
  account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  graded_card jsonb NULL,
  storage_location_id text NOT NULL,
  total_quantity integer NOT NULL,
  acquisition_cost_amount numeric(12,2) NULL,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_supply_holds (
  hold_id text PRIMARY KEY,
  account_id text NOT NULL,
  item_id text NOT NULL,
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

CREATE INDEX IF NOT EXISTS marketplace_catalog_items_language_idx
  ON marketplace_catalog_items (language_code);

CREATE INDEX IF NOT EXISTS marketplace_catalog_items_status_idx
  ON marketplace_catalog_items (status);

CREATE INDEX IF NOT EXISTS marketplace_catalog_dimension_options_dimension_idx
  ON marketplace_catalog_dimension_options (dimension_id);

CREATE INDEX IF NOT EXISTS marketplace_supply_locations_account_idx
  ON marketplace_supply_locations (account_id, is_archived, name);

CREATE INDEX IF NOT EXISTS marketplace_supply_items_account_idx
  ON marketplace_supply_items (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_supply_items_storage_location_idx
  ON marketplace_supply_items (storage_location_id);

CREATE INDEX IF NOT EXISTS marketplace_supply_items_catalog_version_idx
  ON marketplace_supply_items (product_id);

CREATE INDEX IF NOT EXISTS marketplace_supply_holds_item_idx
  ON marketplace_supply_holds (item_id, status);

ALTER TABLE marketplace_supply_locations
  ADD COLUMN IF NOT EXISTS ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb;
`;
