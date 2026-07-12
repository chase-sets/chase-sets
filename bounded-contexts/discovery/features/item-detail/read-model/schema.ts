import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const discoveryItemDetailSchemaSql = `CREATE TABLE IF NOT EXISTS discovery_item_detail_catalog_items (
  catalog_item_id text PRIMARY KEY,
  slug text NOT NULL DEFAULT '',
  language_code text NOT NULL DEFAULT 'en',
  title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  title text NOT NULL DEFAULT '',
  subtitle_i18n jsonb NULL,
  subtitle text NULL,
  display_badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  status text NOT NULL DEFAULT 'draft',
  field_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  category_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_fallback jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_item_detail_catalog_items
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '';

ALTER TABLE discovery_item_detail_catalog_items
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS display_badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS image_fallback jsonb NULL;

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

CREATE TABLE IF NOT EXISTS discovery_item_detail_product_contents (
  line_id text PRIMARY KEY,
  container_catalog_item_id text NOT NULL,
  container_selected_options jsonb NULL,
  container_product_id text NULL,
  contained_catalog_item_id text NULL,
  contained_selected_options jsonb NULL,
  contained_product_id text NULL,
  quantity integer NULL,
  content_type_id text NOT NULL,
  content_type_display_name jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  inclusion_policy_id text NULL,
  inclusion_policy_display_name jsonb NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution_status text NOT NULL DEFAULT 'resolved',
  target_lifecycle_status text NULL,
  resolved_fact_hash text NOT NULL,
  resolver_version integer NOT NULL DEFAULT 1,
  resolved_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_item_detail_product_contents
  ADD COLUMN IF NOT EXISTS content_type_display_name jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS inclusion_policy_display_name jsonb NULL;

CREATE INDEX IF NOT EXISTS discovery_item_detail_product_contents_container_idx
  ON discovery_item_detail_product_contents (container_catalog_item_id, container_product_id, content_type_id);

CREATE INDEX IF NOT EXISTS discovery_item_detail_product_contents_contained_idx
  ON discovery_item_detail_product_contents (contained_catalog_item_id, contained_product_id, content_type_id)
  WHERE contained_catalog_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS discovery_item_detail_pages (
  catalog_item_id text PRIMARY KEY,
  slug text NOT NULL DEFAULT '',
  language_code text NOT NULL DEFAULT 'en',
  title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  title text NOT NULL DEFAULT '',
  subtitle_i18n jsonb NULL,
  subtitle text NULL,
  display_badges jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  image_fallback jsonb NULL,
  product_schema jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE discovery_item_detail_pages
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '';

ALTER TABLE discovery_item_detail_pages
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS title_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS subtitle_i18n jsonb NULL,
  ADD COLUMN IF NOT EXISTS display_badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS product_asset_sets jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS image_fallback jsonb NULL;

`;

export const discoveryItemDetailSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260712_discovery_item_detail_slug_language_indexes",
    description:
      "Move slug and language indexes on migration-added Discovery item-detail columns into the concurrent migration ledger.",
    statements: [
      `SET lock_timeout = '5s';`,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discovery_item_detail_catalog_items_slug_idx
  ON discovery_item_detail_catalog_items (slug) WHERE slug <> '';`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS discovery_item_detail_catalog_items_language_idx
  ON discovery_item_detail_catalog_items (language_code);`,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discovery_item_detail_catalog_categories_slug_idx
  ON discovery_item_detail_catalog_categories (slug) WHERE slug <> '';`,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discovery_item_detail_pages_slug_idx
  ON discovery_item_detail_pages (slug) WHERE slug <> '';`,
    ],
  },
];
