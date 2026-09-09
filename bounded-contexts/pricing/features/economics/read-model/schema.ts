import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const pricingInventoryAcquisitionLotsTableSql = `CREATE TABLE IF NOT EXISTS pricing_inventory_acquisition_lots (
  account_id text NOT NULL,
  inventory_item_id text NOT NULL,
  event_stream_version integer NOT NULL CHECK (event_stream_version >= 1),
  quantity integer NOT NULL CHECK (quantity > 0),
  occurrence_kind text NOT NULL CHECK (occurrence_kind IN ('occurred', 'unknown')),
  acquired_at timestamptz NULL,
  occurrence_source text NULL CHECK (occurrence_source IN ('seller-supplied', 'import-supplied')),
  last_source_event_id text NOT NULL,
  last_source_event_recorded_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, inventory_item_id, event_stream_version),
  CHECK (
    (occurrence_kind = 'occurred' AND acquired_at IS NOT NULL AND occurrence_source IS NOT NULL) OR
    (occurrence_kind = 'unknown' AND acquired_at IS NULL AND occurrence_source IS NULL)
  )
)`;

const pricingInventoryAcquisitionLotsLookupIndexSql = `CREATE INDEX IF NOT EXISTS pricing_inventory_acquisition_lots_lookup_idx
  ON pricing_inventory_acquisition_lots (account_id, inventory_item_id, acquired_at, event_stream_version)`;
const pricingInventoryAcquisitionLotsLookupConcurrentIndexSql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS pricing_inventory_acquisition_lots_lookup_idx
  ON pricing_inventory_acquisition_lots (account_id, inventory_item_id, acquired_at, event_stream_version)`;

const pricingEconomicsOverridesTableSql = `CREATE TABLE IF NOT EXISTS pricing_economics_overrides (
  account_id text NOT NULL,
  scope_key text NOT NULL,
  currency_code text NOT NULL CHECK (currency_code ~ '^[a-z]{3}$'),
  fact_name text NOT NULL CHECK (fact_name IN (
    'platformFeeRelativeBps',
    'platformFeeFixedPerUnitAmount',
    'platformFeeCapPerUnitAmount',
    'sellerHandlingRelativeBps',
    'sellerHandlingFixedPerUnitAmount',
    'sellerHandlingCapPerUnitAmount',
    'shippingAllowanceBps',
    'costBasisShareOfMarketBps',
    'costBasisCoverageBps',
    'costBasisDiscountPerUnitAmount',
    'turnaroundDays',
    'dailyReturnHurdle'
  )),
  override_state text NOT NULL CHECK (override_state IN ('active', 'cleared')),
  override_value jsonb NULL,
  set_at timestamptz NULL,
  cleared_at timestamptz NULL,
  last_stream_version integer NOT NULL CHECK (last_stream_version >= 1),
  last_source_event_id text NOT NULL,
  last_source_event_recorded_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, scope_key, currency_code, fact_name),
  CHECK (
    (override_state = 'active' AND set_at IS NOT NULL AND cleared_at IS NULL) OR
    (override_state = 'cleared' AND override_value IS NULL AND set_at IS NULL AND cleared_at IS NOT NULL)
  )
)`;

const pricingEconomicsOverridesStreamIndexSql = `CREATE UNIQUE INDEX IF NOT EXISTS pricing_economics_overrides_stream_idx
  ON pricing_economics_overrides (account_id, scope_key, currency_code, last_stream_version)`;
const pricingEconomicsOverridesStreamConcurrentIndexSql = `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pricing_economics_overrides_stream_idx
  ON pricing_economics_overrides (account_id, scope_key, currency_code, last_stream_version)`;

export const pricingEconomicsSchemaSql = [
  pricingInventoryAcquisitionLotsTableSql,
  pricingInventoryAcquisitionLotsLookupIndexSql,
  pricingEconomicsOverridesTableSql,
  pricingEconomicsOverridesStreamIndexSql,
]
  .map((statement) => `${statement};`)
  .join("\n\n");

/**
 * Clean boot creates indexes alongside empty tables. Upgrade migrations use
 * PostgreSQL's concurrent form so an existing Pricing database stays writable.
 */
export const pricingEconomicsSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260907_pricing_economics_acquisition_lots",
    description: "Project explicit known and unknown Inventory acquisition occurrences for Economics history.",
    statements: [pricingInventoryAcquisitionLotsTableSql, pricingInventoryAcquisitionLotsLookupConcurrentIndexSql],
  },
  {
    migrationId: "20260907_pricing_economics_overrides",
    description: "Persist the current tombstone-preserving Economics override projection.",
    statements: [pricingEconomicsOverridesTableSql, pricingEconomicsOverridesStreamConcurrentIndexSql],
  },
];
