import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const pricingDemandCurveSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_demand_curve_versions (
  catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  provider_condition text NOT NULL,
  provider_variant text NOT NULL,
  provider_language text NOT NULL,
  fingerprint text NOT NULL,
  model_version text NOT NULL,
  policy_revision_id text NOT NULL,
  ladder_method text NOT NULL,
  anchor_condition text NULL,
  exposure_start_reason text NOT NULL,
  sales_coverage text NOT NULL,
  supply_status text NOT NULL CHECK (supply_status IN ('observed','truncated','unavailable','disabled')),
  own_seller_exclusion_applied boolean NULL,
  built_at timestamptz NOT NULL,
  superseded_at timestamptz NULL,
  PRIMARY KEY (catalog_item_id, product_id, version)
);

CREATE INDEX IF NOT EXISTS pricing_demand_curve_versions_served_idx
  ON pricing_demand_curve_versions (catalog_item_id, product_id, version DESC)
  WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS pricing_demand_curve_points (
  catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  version bigint NOT NULL,
  percentile integer NOT NULL CHECK (percentile BETWEEN 1 AND 99),
  price_amount numeric(12,2) NOT NULL,
  buyer_arrival_interval_days numeric(20,8) NULL,
  competing_seller_count integer NULL,
  store_win_share numeric(12,10) NULL,
  median_sell_days numeric(20,8) NULL,
  qualifying_sale_count integer NOT NULL,
  history_capped boolean NOT NULL,
  hopeless boolean NOT NULL,
  supply_status text NOT NULL,
  PRIMARY KEY (catalog_item_id, product_id, version, percentile),
  FOREIGN KEY (catalog_item_id, product_id, version)
    REFERENCES pricing_demand_curve_versions(catalog_item_id, product_id, version)
);

CREATE TABLE IF NOT EXISTS pricing_demand_curve_closer_cursors (
  closer_name text PRIMARY KEY,
  after_priority integer NOT NULL,
  after_catalog_item_id text NOT NULL,
  after_product_id text NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL
);
`;

const statements = pricingDemandCurveSchemaSql
  .split(";\n")
  .map((statement) => statement.trim())
  .filter(Boolean);
export const pricingDemandCurveSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260929_pricing_demand_curve_versions",
    description: "Persist immutable curve versions, ordered points, and a generation-fenced closer cursor.",
    statements: statements.map((statement) => `${statement};`),
  },
];
