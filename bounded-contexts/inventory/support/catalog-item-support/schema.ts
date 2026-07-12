import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

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

-- inventory_catalog_items_language_idx moved to the schemaMigrations ledger
-- (boot-time indexes on migration-added columns are forbidden by the structure gate).

CREATE INDEX IF NOT EXISTS inventory_catalog_items_status_idx
  ON inventory_catalog_items (status);

CREATE INDEX IF NOT EXISTS inventory_catalog_items_picker_idx
  ON inventory_catalog_items (status, title, catalog_item_id);

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

CREATE TABLE IF NOT EXISTS inventory_catalog_external_catalog_item_references (
  provider_key text NOT NULL,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, external_key)
);

CREATE INDEX IF NOT EXISTS inventory_catalog_external_catalog_item_references_catalog_item_idx
  ON inventory_catalog_external_catalog_item_references (catalog_item_id);

CREATE TABLE IF NOT EXISTS inventory_catalog_gtins (
  gtin text PRIMARY KEY,
  catalog_item_id text NOT NULL,
  product_form text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_catalog_gtins_catalog_item_idx
  ON inventory_catalog_gtins (catalog_item_id);
`;

export const inventoryCatalogItemSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260711_inventory_catalog_items_language_idx",
    description: "Recreate the catalog-item mirror language filter index through the ledger.",
    statements: [
      "SET lock_timeout = '5s';",
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_catalog_items_language_idx
  ON inventory_catalog_items (language_code)`,
    ],
  },
];
