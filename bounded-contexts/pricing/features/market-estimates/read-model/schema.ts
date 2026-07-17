/**
 * The current published Market Price per resolved Product, projected from
 * `pricing.market-price.estimated` (an ordinary checkpointed projection over
 * pricing's own stream -- the estimate is event-sourced, unlike the
 * recompute-safe rollup snapshots next door). One row per product: the
 * latest estimate wins, guarded by the monotonic `estimate_version` the
 * aggregate stamps on every publication.
 *
 * Brand-new table, so its index ships in boot schema SQL alongside
 * `CREATE TABLE` (same discipline note as the Trades Tape schema).
 *
 * Retention: forever -- product market data, exempt from age-based retention
 * sweeps by omission, like every market-analytics table in this context.
 */
export const pricingMarketEstimatesSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_market_price_estimates (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  estimate_version bigint NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_ended_at timestamptz NOT NULL,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  band_low_amount numeric(12, 2) NULL,
  band_high_amount numeric(12, 2) NULL,
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  platform_verified_trade_count integer NOT NULL DEFAULT 0,
  platform_trade_count integer NOT NULL DEFAULT 0,
  external_comp_count integer NOT NULL DEFAULT 0,
  previous_amount numeric(12, 2) NULL,
  estimated_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  disclosure text NOT NULL CHECK (disclosure IN ('internal', 'account', 'public')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_catalog_item_id, product_id)
);

CREATE INDEX IF NOT EXISTS pricing_market_price_estimates_freshness_idx
  ON pricing_market_price_estimates (fresh_until);
`;
