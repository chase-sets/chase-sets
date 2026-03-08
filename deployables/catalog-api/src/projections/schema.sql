CREATE TABLE IF NOT EXISTS catalog_dimensions (
  dimension_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_dimension_choices (
  choice_id text NOT NULL,
  dimension_id text NOT NULL REFERENCES catalog_dimensions(dimension_id) ON DELETE CASCADE,
  code text NOT NULL,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  display_order integer NOT NULL DEFAULT 0,
  numeric_value numeric NULL,
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (dimension_id, choice_id)
);

CREATE TABLE IF NOT EXISTS catalog_fields (
  field_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  value_type text NOT NULL DEFAULT 'string',
  filterable boolean NOT NULL DEFAULT false,
  searchable boolean NOT NULL DEFAULT false,
  sortable boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_components (
  component_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  field_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_blueprints (
  blueprint_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  component_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonical_dimension_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_categories (
  category_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  parent_category_id text NULL,
  display_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_items (
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

CREATE TABLE IF NOT EXISTS catalog_admin_component_detail_pages (
  component_id text PRIMARY KEY REFERENCES catalog_components(component_id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  field_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_admin_blueprint_detail_pages (
  blueprint_id text PRIMARY KEY REFERENCES catalog_blueprints(blueprint_id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  components jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonical_dimension_order jsonb NOT NULL DEFAULT '[]'::jsonb,
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

CREATE INDEX IF NOT EXISTS catalog_admin_category_list_pages_status_idx
  ON catalog_admin_category_list_pages (status);
CREATE INDEX IF NOT EXISTS catalog_admin_category_list_pages_parent_idx
  ON catalog_admin_category_list_pages (parent_category_id);
CREATE INDEX IF NOT EXISTS catalog_admin_category_list_pages_key_name_idx
  ON catalog_admin_category_list_pages USING gin (to_tsvector('simple', key || ' ' || name));

CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_status_idx
  ON catalog_admin_catalog_item_list_pages (status);
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_blueprint_idx
  ON catalog_admin_catalog_item_list_pages (blueprint_id);
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_title_idx
  ON catalog_admin_catalog_item_list_pages USING gin (to_tsvector('simple', title || ' ' || COALESCE(subtitle, '')));
CREATE INDEX IF NOT EXISTS catalog_admin_catalog_item_list_pages_tags_idx
  ON catalog_admin_catalog_item_list_pages USING gin (tags);
