export const catalogReferenceDataSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_reference_types (
  reference_type_id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  name_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  name text NOT NULL,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  attribute_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_reference_records (
  reference_record_id text PRIMARY KEY,
  type_key text NOT NULL,
  key text NOT NULL,
  name_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  name text NOT NULL,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  relationships jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type_key, key)
);

CREATE INDEX IF NOT EXISTS catalog_reference_records_type_key_idx
  ON catalog_reference_records (type_key);

CREATE INDEX IF NOT EXISTS catalog_reference_records_status_idx
  ON catalog_reference_records (status);

CREATE INDEX IF NOT EXISTS catalog_reference_records_name_idx
  ON catalog_reference_records USING gin (to_tsvector('simple', key || ' ' || name));`;
