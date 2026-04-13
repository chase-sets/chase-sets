export const inventoryCatalogItemSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_catalog_items (
  item_id text PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  subtitle text NULL,
  blueprint_id text NULL,
  status text NOT NULL DEFAULT 'draft',
  version_schema jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_catalog_items_blueprint_idx
  ON inventory_catalog_items (blueprint_id);

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

CREATE TABLE IF NOT EXISTS inventory_catalog_dimension_choices (
  choice_id text PRIMARY KEY,
  dimension_id text NOT NULL,
  code text NOT NULL DEFAULT '',
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_catalog_dimension_choices_dimension_idx
  ON inventory_catalog_dimension_choices (dimension_id);
`;
