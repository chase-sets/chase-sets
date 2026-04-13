export const discoverySearchSchemaSql = `CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS discovery_search_catalog_items (
  item_id text PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS discovery_search_catalog_items_blueprint_idx ON discovery_search_catalog_items (blueprint_id);
CREATE INDEX IF NOT EXISTS discovery_search_catalog_items_status_idx ON discovery_search_catalog_items (status);
CREATE INDEX IF NOT EXISTS discovery_search_catalog_items_category_ids_idx ON discovery_search_catalog_items USING gin (category_ids);

CREATE TABLE IF NOT EXISTS discovery_search_catalog_blueprints (
  blueprint_id text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_search_catalog_categories (
  category_id text PRIMARY KEY,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_search_items (
  item_id text PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  subtitle text NULL,
  description text NOT NULL DEFAULT '',
  blueprint_id text NULL,
  blueprint_name text NULL,
  status text NOT NULL DEFAULT 'draft',
  category_names jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_values_text text NOT NULL DEFAULT '',
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  search_text tsvector,
  search_text_simple tsvector,
  search_embedding vector(1536),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_search_items_search_text_idx ON discovery_search_items USING gin (search_text);
CREATE INDEX IF NOT EXISTS discovery_search_items_search_text_simple_idx ON discovery_search_items USING gin (search_text_simple);
CREATE INDEX IF NOT EXISTS discovery_search_items_status_idx ON discovery_search_items (status);
CREATE INDEX IF NOT EXISTS discovery_search_items_blueprint_idx ON discovery_search_items (blueprint_id);
CREATE INDEX IF NOT EXISTS discovery_search_items_tags_idx ON discovery_search_items USING gin (tags);
CREATE INDEX IF NOT EXISTS discovery_search_items_category_names_idx ON discovery_search_items USING gin (category_names);`;

