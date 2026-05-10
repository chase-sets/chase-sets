export const checkoutCatalogProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_catalog_items (
  catalog_item_id text PRIMARY KEY,
  language_code text NOT NULL DEFAULT 'en',
  title text NOT NULL,
  subtitle text NULL,
  blueprint_id text NULL,
  status text NOT NULL,
  product_schema jsonb NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS checkout_catalog_items_blueprint_idx
  ON checkout_catalog_items (blueprint_id);

CREATE INDEX IF NOT EXISTS checkout_catalog_items_language_idx
  ON checkout_catalog_items (language_code);

CREATE INDEX IF NOT EXISTS checkout_catalog_items_status_idx
  ON checkout_catalog_items (status);

ALTER TABLE checkout_catalog_items
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en';

CREATE TABLE IF NOT EXISTS checkout_catalog_blueprints (
  blueprint_id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonical_dimension_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS checkout_catalog_dimensions (
  dimension_id text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS checkout_catalog_dimension_options (
  option_id text PRIMARY KEY,
  dimension_id text NOT NULL,
  code text NOT NULL,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS checkout_catalog_dimension_options_dimension_idx
  ON checkout_catalog_dimension_options (dimension_id);
`;
