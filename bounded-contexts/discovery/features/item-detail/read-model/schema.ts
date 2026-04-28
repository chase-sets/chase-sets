export const discoveryItemDetailSchemaSql = `CREATE TABLE IF NOT EXISTS discovery_item_detail_catalog_items (
  catalog_item_id text PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  subtitle text NULL,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  status text NOT NULL DEFAULT 'draft',
  field_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  category_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_item_detail_catalog_items_blueprint_idx ON discovery_item_detail_catalog_items (blueprint_id);
CREATE INDEX IF NOT EXISTS discovery_item_detail_catalog_items_category_ids_idx ON discovery_item_detail_catalog_items USING gin (category_ids);

CREATE TABLE IF NOT EXISTS discovery_item_detail_catalog_blueprints (
  blueprint_id text PRIMARY KEY,
  name text NOT NULL,
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonical_dimension_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_item_detail_catalog_categories (
  category_id text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_item_detail_catalog_fields (
  field_id text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_item_detail_catalog_dimensions (
  dimension_id text PRIMARY KEY,
  name text NOT NULL,
  value_kind text NOT NULL DEFAULT 'unordered',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_item_detail_catalog_dimensions
  ADD COLUMN IF NOT EXISTS value_kind text NOT NULL DEFAULT 'unordered';

CREATE TABLE IF NOT EXISTS discovery_item_detail_catalog_dimension_options (
  option_id text PRIMARY KEY,
  dimension_id text NOT NULL,
  code text NOT NULL,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  display_order integer NOT NULL DEFAULT 0,
  numeric_value numeric NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_item_detail_catalog_dimension_options
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0;

ALTER TABLE discovery_item_detail_catalog_dimension_options
  ADD COLUMN IF NOT EXISTS numeric_value numeric NULL;

CREATE INDEX IF NOT EXISTS discovery_item_detail_catalog_dimension_options_dimension_idx ON discovery_item_detail_catalog_dimension_options (dimension_id);

CREATE TABLE IF NOT EXISTS discovery_item_detail_pages (
  catalog_item_id text PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  subtitle text NULL,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  blueprint jsonb NULL,
  status text NOT NULL DEFAULT 'draft',
  field_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_schema jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;
