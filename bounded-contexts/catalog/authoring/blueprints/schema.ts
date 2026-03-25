export const catalogBlueprintSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_blueprints (
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
);`;
