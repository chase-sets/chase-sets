export const catalogComponentSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_components (
  component_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  field_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  dimension_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
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
);`;
