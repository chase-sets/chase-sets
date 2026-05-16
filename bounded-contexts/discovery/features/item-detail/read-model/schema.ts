export const discoveryItemDetailSchemaSql = `CREATE TABLE IF NOT EXISTS discovery_item_detail_catalog_items (
  catalog_item_id text PRIMARY KEY,
  slug text NOT NULL DEFAULT '',
  language_code text NOT NULL DEFAULT 'en',
  title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  title text NOT NULL DEFAULT '',
  subtitle_i18n jsonb NULL,
  subtitle text NULL,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  status text NOT NULL DEFAULT 'draft',
  field_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  category_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_item_detail_catalog_items
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '';

ALTER TABLE discovery_item_detail_catalog_items
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS discovery_item_detail_catalog_items_slug_idx ON discovery_item_detail_catalog_items (slug) WHERE slug <> '';
CREATE INDEX IF NOT EXISTS discovery_item_detail_catalog_items_language_idx ON discovery_item_detail_catalog_items (language_code);
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
  slug text NOT NULL DEFAULT '',
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_item_detail_catalog_categories
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS discovery_item_detail_catalog_categories_slug_idx ON discovery_item_detail_catalog_categories (slug) WHERE slug <> '';

CREATE TABLE IF NOT EXISTS discovery_item_detail_catalog_fields (
  field_id text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_item_detail_catalog_reference_records (
  reference_record_id text PRIMARY KEY,
  type_key text NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  relationships jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_item_detail_catalog_reference_records_type_key_idx
  ON discovery_item_detail_catalog_reference_records (type_key);

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
  label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  label text NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 0,
  numeric_value numeric NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_item_detail_catalog_dimension_options
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';

ALTER TABLE discovery_item_detail_catalog_dimension_options
  ADD COLUMN IF NOT EXISTS numeric_value numeric NULL;

CREATE INDEX IF NOT EXISTS discovery_item_detail_catalog_dimension_options_dimension_idx ON discovery_item_detail_catalog_dimension_options (dimension_id);

CREATE TABLE IF NOT EXISTS discovery_item_detail_pages (
  catalog_item_id text PRIMARY KEY,
  slug text NOT NULL DEFAULT '',
  language_code text NOT NULL DEFAULT 'en',
  title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  title text NOT NULL DEFAULT '',
  subtitle_i18n jsonb NULL,
  subtitle text NULL,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  blueprint jsonb NULL,
  status text NOT NULL DEFAULT 'draft',
  field_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_schema jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_item_detail_pages
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '';

ALTER TABLE discovery_item_detail_pages
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS discovery_item_detail_pages_slug_idx ON discovery_item_detail_pages (slug) WHERE slug <> '';`;
