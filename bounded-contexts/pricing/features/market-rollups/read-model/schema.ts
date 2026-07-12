/**
 * Daily product rollups, market-state snapshots, and the denormalized
 * product market aggregate: computed SNAPSHOTS of the Trades Tape
 * (`pricing_market_trades`) and the existing listing/offer input
 * tables -- never estimates. See bounded-contexts/pricing/GLOSSARY.md
 * "Daily Product Rollup" / "Market-State Snapshot" / "Product Market
 * Aggregate" for the shipped definitions, and "Market Price Snapshot" /
 * "Market-Value Estimate" for the distinct estimate concept these rollups
 * are never confused with (m122 snapshot-vs-estimate delineation).
 *
 * All three tables are maintained by the market-rollups closer job
 * (../read-model/rollup-maintenance.ts), a scheduled worker job -- not a
 * checkpointed event-sourced projection. See that file's header for why:
 * daily rollups are pure, recompute-safe aggregations over the already-
 * correct Trades Tape (safe to run on any schedule, from any worker,
 * without a projection checkpoint), and market-state snapshots are
 * explicitly an end-of-day point-in-time read of already-projected current
 * state (`pricing_market_listing_inputs` / `pricing_buyer_offer_inputs`),
 * which a raw-event projection cannot reconstruct for an arbitrary past day
 * any more accurately than reading that state when the job runs.
 *
 * Retention: forever, like the Trades Tape itself -- product data, exempt
 * from the platform's age-based retention sweeps by omission (pricing has no
 * retention-policy.ts; these tables are never registered as a sweep target).
 *
 * `median_price_amount` on the daily rollup is stored UNCONDITIONALLY, even
 * on days below the minimum-sample threshold (the row still "carries
 * counts"). Minimum-sample suppression is enforced exactly once, in the
 * query layer (../read-model/queries.ts), so every consumer sees the same
 * suppression rule without re-implementing it. `median_price_30d` /
 * `median_price_90d` on the denormalized aggregate ARE pre-gated at write
 * time instead -- that table exists specifically for cheap, no-further-logic
 * reads (its own "denormalized for cheap surface reads" purpose).
 */
export const pricingMarketRollupsSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_daily_product_rollups (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  day date NOT NULL,
  first_price_amount numeric(12, 2) NULL,
  last_price_amount numeric(12, 2) NULL,
  min_price_amount numeric(12, 2) NULL,
  max_price_amount numeric(12, 2) NULL,
  median_price_amount numeric(12, 2) NULL,
  unit_volume integer NOT NULL DEFAULT 0,
  trade_count integer NOT NULL DEFAULT 0,
  verified_trade_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_catalog_item_id, product_id, day)
);

CREATE INDEX IF NOT EXISTS pricing_daily_product_rollups_series_idx
  ON pricing_daily_product_rollups (catalog_catalog_item_id, product_id, day DESC);

CREATE TABLE IF NOT EXISTS pricing_market_state_snapshots (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  day date NOT NULL,
  active_listing_count integer NOT NULL DEFAULT 0,
  min_ask_amount numeric(12, 2) NULL,
  open_offer_count integer NOT NULL DEFAULT 0,
  max_bid_amount numeric(12, 2) NULL,
  spread_amount numeric(12, 2) NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_catalog_item_id, product_id, day)
);

CREATE INDEX IF NOT EXISTS pricing_market_state_snapshots_series_idx
  ON pricing_market_state_snapshots (catalog_catalog_item_id, product_id, day DESC);

CREATE TABLE IF NOT EXISTS pricing_product_market_aggregates (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  last_sold_at timestamptz NULL,
  last_sold_price_amount numeric(12, 2) NULL,
  median_price_30d numeric(12, 2) NULL,
  volume_30d integer NOT NULL DEFAULT 0,
  trade_count_30d integer NOT NULL DEFAULT 0,
  median_price_90d numeric(12, 2) NULL,
  volume_90d integer NOT NULL DEFAULT 0,
  trade_count_90d integer NOT NULL DEFAULT 0,
  sell_through_rate numeric(6, 4) NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_catalog_item_id, product_id)
);

/**
 * Platform Daily Rollup: the platform-wide sibling of the daily
 * PRODUCT rollup above -- one row per calendar day, summed across every
 * product, instead of one row per (product, day). Only additive fields
 * live here (GMV amount, trade/order/unit counts): additive columns can be
 * safely re-summed across a wider date_trunc bucket at query time (see
 * platform-queries.ts) without a double-counting risk. Distinct-count KPIs
 * (active buyer/seller counts) are NOT stored here, deliberately -- summing
 * daily distinct-account counts across a week/month would double-count a
 * buyer or seller active on more than one day in the window. Those are
 * computed directly off the Trades Tape for the exact requested range
 * instead (getPlatformKpiSummary in platform-queries.ts).
 *
 * Maintained by the same recompute-safe daily closer job as the per-product
 * rollup (see rollup-maintenance.ts); same retention-forever, same
 * excluded-trade omission convention.
 */
CREATE TABLE IF NOT EXISTS pricing_platform_daily_rollups (
  day date PRIMARY KEY,
  gmv_amount numeric(14, 2) NOT NULL DEFAULT 0,
  trade_count integer NOT NULL DEFAULT 0,
  unit_volume integer NOT NULL DEFAULT 0,
  order_count integer NOT NULL DEFAULT 0,
  verified_trade_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);
`;
