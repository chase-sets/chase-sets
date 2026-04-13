export const catalogCatalogItemSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_items (
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

CREATE TABLE IF NOT EXISTS catalog_admin_catalog_item_list_pages (
  item_id text PRIMARY KEY REFERENCES catalog_items(item_id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  subtitle text NULL,
  blueprint_id text NULL,
  blueprint jsonb NULL,
  status text NOT NULL DEFAULT 'draft',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_admin_catalog_item_detail_pages (
  item_id text PRIMARY KEY REFERENCES catalog_items(item_id) ON DELETE CASCADE,
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
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_status_idx
  ON catalog_admin_catalog_item_list_pages (status);
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_blueprint_idx
  ON catalog_admin_catalog_item_list_pages (blueprint_id);
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_title_idx
  ON catalog_admin_catalog_item_list_pages USING gin (to_tsvector('simple', title || ' ' || COALESCE(subtitle, '')));
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_tags_idx
  ON catalog_admin_catalog_item_list_pages USING gin (tags);`;

