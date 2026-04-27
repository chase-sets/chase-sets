export const catalogDimensionSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_dimensions (
  dimension_id text PRIMARY KEY,
  key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_dimension_options (
  option_id text NOT NULL,
  dimension_id text NOT NULL REFERENCES catalog_dimensions(dimension_id) ON DELETE CASCADE,
  code text NOT NULL,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  display_order integer NOT NULL DEFAULT 0,
  numeric_value numeric NULL,
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (dimension_id, option_id)
);`;

