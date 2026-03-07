CREATE TABLE IF NOT EXISTS catalog_dimensions (
  dimension_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
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
  status text NOT NULL DEFAULT 'draft',
  field_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_blueprints (
  blueprint_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
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
  status text NOT NULL DEFAULT 'draft',
  parent_category_id text NULL,
  display_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_items (
  item_id text PRIMARY KEY,
  title text NOT NULL DEFAULT '',
  subtitle text NULL,
  blueprint_id text NULL,
  status text NOT NULL DEFAULT 'draft',
  field_values jsonb NOT NULL DEFAULT '[]'::jsonb,
  category_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
