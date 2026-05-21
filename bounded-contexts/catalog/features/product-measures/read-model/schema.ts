export const catalogProductMeasureSchemaSql = `
CREATE TABLE IF NOT EXISTS catalog_product_measure_profiles (
  profile_id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  match_blueprint_id text NULL,
  match_category_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  match_selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  measure_snapshot jsonb NOT NULL,
  precedence integer NOT NULL DEFAULT 100,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_product_measure_profiles_status_idx
  ON catalog_product_measure_profiles (status, precedence, key);

CREATE TABLE IF NOT EXISTS catalog_resolved_product_measures (
  product_id text PRIMARY KEY,
  catalog_item_id text NOT NULL REFERENCES catalog_items(catalog_item_id) ON DELETE CASCADE,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  measure_snapshot jsonb NULL,
  missing_reason text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_resolved_product_measures_item_idx
  ON catalog_resolved_product_measures (catalog_item_id, updated_at DESC);
`;
