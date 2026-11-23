import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const catalogDimensionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261121_catalog_dimension_option_matching",
    description: "Store each Dimension's Option Matching; existing rows take exact.",
    statements: [
      "SET LOCAL lock_timeout = '5s';",
      `ALTER TABLE catalog_dimensions
  ADD COLUMN IF NOT EXISTS option_matching text NOT NULL DEFAULT 'exact'`,
    ],
  },
  {
    migrationId: "20261122_catalog_dimension_option_applies_when",
    description: "Store each Option's applicability; existing rows take none, which means the Option always applies.",
    statements: [
      "SET LOCAL lock_timeout = '5s';",
      `ALTER TABLE catalog_dimension_options
  ADD COLUMN IF NOT EXISTS applies_when jsonb NOT NULL DEFAULT '[]'::jsonb`,
    ],
  },
];

export const catalogDimensionSchemaSql = `CREATE TABLE IF NOT EXISTS catalog_dimensions (
  dimension_id text PRIMARY KEY,
  key text NOT NULL,
  name_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  name text NOT NULL,
  description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  description text NOT NULL DEFAULT '',
  value_kind text NOT NULL DEFAULT 'unordered',
  option_matching text NOT NULL DEFAULT 'exact',
  status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE catalog_dimensions
  ADD COLUMN IF NOT EXISTS value_kind text NOT NULL DEFAULT 'unordered',
  ADD COLUMN IF NOT EXISTS option_matching text NOT NULL DEFAULT 'exact',
  ADD COLUMN IF NOT EXISTS name_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb;

CREATE TABLE IF NOT EXISTS catalog_dimension_options (
  option_id text NOT NULL,
  dimension_id text NOT NULL REFERENCES catalog_dimensions(dimension_id) ON DELETE CASCADE,
  code text NOT NULL,
  label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  label text NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 0,
  numeric_value numeric NULL,
  status text NOT NULL DEFAULT 'active',
  applies_when jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (dimension_id, option_id)
);

ALTER TABLE catalog_dimension_options
  ADD COLUMN IF NOT EXISTS applies_when jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS label_i18n jsonb NOT NULL DEFAULT '{"defaultLocale":"en","values":{}}'::jsonb,
  ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';`;
