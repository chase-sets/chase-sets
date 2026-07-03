export const catalogScopeRegistrySchemaSql = `CREATE TABLE IF NOT EXISTS catalog_scope_records (
  scope_record_id text PRIMARY KEY,
  product_domain text NOT NULL,
  scope_kind text NOT NULL,
  reference_type_key text NOT NULL,
  reference_record_id text NOT NULL UNIQUE,
  reference_record_key text NOT NULL,
  name_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  name text NOT NULL,
  parent_scope_record_id text NULL,
  product_line_scope_record_id text NULL,
  series_scope_record_id text NULL,
  release_date date NULL,
  official_set_code text NULL,
  language_editions jsonb NOT NULL DEFAULT '[]'::jsonb,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  relationships jsonb NOT NULL DEFAULT '[]'::jsonb,
  lifecycle_status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (product_domain IN ('pokemon', 'magic', 'yugioh', 'one-piece', 'lorcana')),
  CHECK (scope_kind IN ('product-line', 'series', 'expansion', 'set'))
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_scope_records_domain_kind_key_idx
  ON catalog_scope_records (product_domain, scope_kind, reference_record_key);

CREATE INDEX IF NOT EXISTS catalog_scope_records_product_domain_idx
  ON catalog_scope_records (product_domain);

CREATE INDEX IF NOT EXISTS catalog_scope_records_scope_kind_idx
  ON catalog_scope_records (scope_kind);

CREATE INDEX IF NOT EXISTS catalog_scope_records_lifecycle_status_idx
  ON catalog_scope_records (lifecycle_status);

CREATE INDEX IF NOT EXISTS catalog_scope_records_parent_idx
  ON catalog_scope_records (parent_scope_record_id);

CREATE INDEX IF NOT EXISTS catalog_scope_records_product_line_idx
  ON catalog_scope_records (product_line_scope_record_id);

CREATE INDEX IF NOT EXISTS catalog_scope_records_series_idx
  ON catalog_scope_records (series_scope_record_id);

CREATE INDEX IF NOT EXISTS catalog_scope_records_name_idx
  ON catalog_scope_records USING gin (to_tsvector('simple', reference_record_key || ' ' || name || ' ' || COALESCE(official_set_code, '')));`;
