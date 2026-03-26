export const discoveryCategorySchemaSql = `CREATE TABLE IF NOT EXISTS discovery_category_catalog_categories (
  category_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  parent_category_id text NULL,
  display_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_category_catalog_categories_parent_idx ON discovery_category_catalog_categories (parent_category_id);
CREATE INDEX IF NOT EXISTS discovery_category_catalog_categories_status_idx ON discovery_category_catalog_categories (status);

CREATE TABLE IF NOT EXISTS discovery_category_catalog_items (
  item_id text PRIMARY KEY,
  category_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_category_catalog_items_category_ids_idx ON discovery_category_catalog_items USING gin (category_ids);
CREATE INDEX IF NOT EXISTS discovery_category_catalog_items_status_idx ON discovery_category_catalog_items (status);

CREATE TABLE IF NOT EXISTS discovery_categories (
  category_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  parent_category_id text NULL,
  parent_category jsonb NULL,
  display_order integer NOT NULL DEFAULT 0,
  item_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_categories_status_idx ON discovery_categories (status);
CREATE INDEX IF NOT EXISTS discovery_categories_parent_idx ON discovery_categories (parent_category_id);`;

