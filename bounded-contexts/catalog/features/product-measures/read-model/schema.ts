import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const profileRevisionSql = `ALTER TABLE catalog_product_measure_profiles
  ADD COLUMN IF NOT EXISTS source_revision bigint NOT NULL DEFAULT 0;`;

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
  source_revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

${profileRevisionSql}

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

export const catalogProductMeasureSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260927_catalog_product_measure_profile_source_revision",
    description: "Fence Product Measure Profile projections by their authoritative event-stream revision.",
    statements: ["SET lock_timeout = '5s';", profileRevisionSql],
  },
];
