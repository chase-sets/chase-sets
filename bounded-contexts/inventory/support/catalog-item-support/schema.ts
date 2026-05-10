export const inventoryCatalogItemSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_catalog_items (
  catalog_item_id text PRIMARY KEY,
  language_code text NOT NULL DEFAULT 'en',
  title text NOT NULL DEFAULT '',
  subtitle text NULL,
  blueprint_id text NULL,
  status text NOT NULL DEFAULT 'draft',
  product_schema jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory_catalog_items
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en';

CREATE INDEX IF NOT EXISTS inventory_catalog_items_blueprint_idx
  ON inventory_catalog_items (blueprint_id);

CREATE INDEX IF NOT EXISTS inventory_catalog_items_language_idx
  ON inventory_catalog_items (language_code);

CREATE INDEX IF NOT EXISTS inventory_catalog_items_status_idx
  ON inventory_catalog_items (status);

CREATE TABLE IF NOT EXISTS inventory_catalog_blueprints (
  blueprint_id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonical_dimension_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_catalog_dimensions (
  dimension_id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_catalog_dimension_options (
  option_id text PRIMARY KEY,
  dimension_id text NOT NULL,
  code text NOT NULL DEFAULT '',
  label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  label text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory_catalog_dimension_options
  ADD COLUMN IF NOT EXISTS label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS inventory_catalog_dimension_options_dimension_idx
  ON inventory_catalog_dimension_options (dimension_id);

CREATE TABLE IF NOT EXISTS inventory_catalog_external_product_references (
  provider_key text NOT NULL,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, external_key)
);

CREATE INDEX IF NOT EXISTS inventory_catalog_external_product_references_catalog_item_idx
  ON inventory_catalog_external_product_references (catalog_item_id);
`;
