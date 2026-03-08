CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS marketplace_search_items (
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

CREATE INDEX IF NOT EXISTS marketplace_search_items_search_text_idx ON marketplace_search_items USING gin (search_text);
CREATE INDEX IF NOT EXISTS marketplace_search_items_search_text_simple_idx ON marketplace_search_items USING gin (search_text_simple);
CREATE INDEX IF NOT EXISTS marketplace_search_items_status_idx ON marketplace_search_items (status);
CREATE INDEX IF NOT EXISTS marketplace_search_items_blueprint_idx ON marketplace_search_items (blueprint_id);
CREATE INDEX IF NOT EXISTS marketplace_search_items_tags_idx ON marketplace_search_items USING gin (tags);
CREATE INDEX IF NOT EXISTS marketplace_search_items_category_names_idx ON marketplace_search_items USING gin (category_names);

CREATE TABLE IF NOT EXISTS marketplace_item_detail_pages (
  item_id text PRIMARY KEY,
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
  version_schema jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_categories (
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

CREATE INDEX IF NOT EXISTS marketplace_categories_status_idx ON marketplace_categories (status);
CREATE INDEX IF NOT EXISTS marketplace_categories_parent_idx ON marketplace_categories (parent_category_id);
