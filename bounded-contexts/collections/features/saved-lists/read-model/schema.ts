export const savedListReadModelSchemaSql = `
CREATE TABLE IF NOT EXISTS collections_saved_list_summaries (
  list_id text PRIMARY KEY,
  owner_account_id text NOT NULL,
  title text NOT NULL,
  description text NULL,
  visibility text NOT NULL,
  lifecycle text NOT NULL,
  cover_line_id text NULL,
  line_count integer NOT NULL DEFAULT 0 CHECK (line_count >= 0),
  tracked_unit_count bigint NOT NULL DEFAULT 0 CHECK (tracked_unit_count >= 0),
  created_at timestamptz NOT NULL,
  changed_at timestamptz NOT NULL,
  archived_at timestamptz NULL,
  created_global_position bigint NOT NULL,
  last_global_position bigint NOT NULL,
  last_stream_version integer NOT NULL
);

CREATE INDEX IF NOT EXISTS collections_saved_list_summaries_owner_page_idx
  ON collections_saved_list_summaries (owner_account_id, created_at DESC, list_id DESC);

CREATE INDEX IF NOT EXISTS collections_saved_list_summaries_owner_visibility_page_idx
  ON collections_saved_list_summaries (owner_account_id, visibility, lifecycle, created_at DESC, list_id DESC);

CREATE INDEX IF NOT EXISTS collections_saved_list_summaries_search_idx
  ON collections_saved_list_summaries
  USING gin (to_tsvector('simple', title || ' ' || COALESCE(description, '')));

CREATE TABLE IF NOT EXISTS collections_saved_list_lines (
  line_id text PRIMARY KEY,
  list_id text NOT NULL,
  catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  tracked_quantity integer NOT NULL CHECK (tracked_quantity > 0),
  private_notes text NULL,
  private_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  position integer NOT NULL CHECK (position >= 0),
  added_at timestamptz NOT NULL,
  changed_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL,
  CONSTRAINT collections_saved_list_lines_list_position_unique
    UNIQUE (list_id, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT collections_saved_list_lines_list_product_unique
    UNIQUE (list_id, product_id)
);

CREATE INDEX IF NOT EXISTS collections_saved_list_lines_list_order_idx
  ON collections_saved_list_lines (list_id, position, line_id);

CREATE INDEX IF NOT EXISTS collections_saved_list_lines_catalog_item_idx
  ON collections_saved_list_lines (catalog_item_id, list_id);

CREATE INDEX IF NOT EXISTS collections_saved_list_lines_selected_options_idx
  ON collections_saved_list_lines USING gin (selected_options);

CREATE TABLE IF NOT EXISTS collections_catalog_items (
  catalog_item_id text PRIMARY KEY,
  language_code text NOT NULL DEFAULT 'en',
  title text NOT NULL DEFAULT '',
  subtitle text NULL,
  blueprint_id text NULL,
  status text NOT NULL DEFAULT 'draft',
  product_schema jsonb NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collections_catalog_items_status_idx
  ON collections_catalog_items (status, catalog_item_id);

CREATE INDEX IF NOT EXISTS collections_catalog_items_search_idx
  ON collections_catalog_items
  USING gin (to_tsvector('simple', title || ' ' || COALESCE(subtitle, '')));

CREATE TABLE IF NOT EXISTS collections_catalog_blueprints (
  blueprint_id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  canonical_dimension_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collections_catalog_dimensions (
  dimension_id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS collections_catalog_dimension_options (
  option_id text PRIMARY KEY,
  dimension_id text NOT NULL,
  code text NOT NULL DEFAULT '',
  label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  label text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collections_catalog_dimension_options_dimension_idx
  ON collections_catalog_dimension_options (dimension_id, option_id);

CREATE INDEX IF NOT EXISTS collections_catalog_dimension_options_search_idx
  ON collections_catalog_dimension_options
  USING gin (to_tsvector('simple', label || ' ' || code));
`;
