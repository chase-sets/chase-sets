export const catalogCategorySchemaSql = `CREATE TABLE IF NOT EXISTS catalog_categories (
  category_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  parent_category_id text NULL,
  display_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_admin_category_list_pages (
  category_id text PRIMARY KEY REFERENCES catalog_categories(category_id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  parent_category_id text NULL,
  parent_category jsonb NULL,
  display_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_admin_category_detail_pages (
  category_id text PRIMARY KEY REFERENCES catalog_categories(category_id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  parent_category_id text NULL,
  parent_category jsonb NULL,
  display_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_admin_category_list_pages_status_idx
  ON catalog_admin_category_list_pages (status);
CREATE INDEX IF NOT EXISTS catalog_admin_category_list_pages_parent_idx
  ON catalog_admin_category_list_pages (parent_category_id);
CREATE INDEX IF NOT EXISTS catalog_admin_category_list_pages_key_name_idx
  ON catalog_admin_category_list_pages USING gin (to_tsvector('simple', key || ' ' || name));`;
