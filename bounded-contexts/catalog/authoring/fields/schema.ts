export const catalogFieldSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_fields (
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
);`;
