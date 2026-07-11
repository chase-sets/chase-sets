/**
 * The Trades Tape: one normalized row per order line that reaches a sale,
 * backfilled entirely by projection replay over Ordering and Fulfillment
 * events (no cold-start era -- see bounded-contexts/pricing/GLOSSARY.md
 * "Trades Tape").
 *
 * `pricing_market_trades` is a brand-new table, so its indexes are created
 * directly in boot schema SQL alongside `CREATE TABLE` -- the
 * migration-ledger + `CREATE INDEX CONCURRENTLY` discipline applies to
 * indexes added against columns on already-populated tables, not to indexes
 * declared with the table itself.
 */
export const pricingMarketTradesSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_market_trades (
  order_id text NOT NULL,
  line_id text NOT NULL,
  seller_account_id text NOT NULL,
  buyer_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  unit_price_amount numeric(12, 2) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  sale_channel text NOT NULL CHECK (sale_channel IN ('listing', 'offer-accepted', 'buy-now')),
  shipment_id text NULL,
  -- Payment capture (order.ready-for-fulfillment-recorded). NULL means the
  -- order line has not yet printed on the tape.
  sold_at timestamptz NULL,
  -- Delivery (fulfillment.shipment.delivered). NULL until the shipment
  -- carrying this line is marked delivered.
  settled_at timestamptz NULL,
  -- Set true by an m109 authenticity-case 'passed' verdict on the trade's
  -- order (see integrations/integrity/integrity-projection.ts).
  verified boolean NOT NULL DEFAULT false,
  -- 'fraud-flagged' is wired by m107 risk-flag events (identity
  -- manual-payout-review badge assignment, Stripe early-fraud-warning
  -- receipt) retroactively excluding a flagged account's/order's historical
  -- trades. 'self-dealing' stays declared but has no writer -- an m107 hard
  -- block rejects same-account orders at creation, so a self-dealing trade
  -- never reaches the tape to begin with.
  excluded boolean NOT NULL DEFAULT false,
  exclusion_reason text NULL CHECK (exclusion_reason IN ('refunded', 'cancelled', 'fraud-flagged', 'self-dealing')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (order_id, line_id),
  CHECK (
    (excluded = false AND exclusion_reason IS NULL) OR
    (excluded = true AND exclusion_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS pricing_market_trades_time_series_idx
  ON pricing_market_trades (catalog_catalog_item_id, product_id, sold_at DESC);

CREATE INDEX IF NOT EXISTS pricing_market_trades_included_time_series_idx
  ON pricing_market_trades (catalog_catalog_item_id, product_id, sold_at DESC)
  WHERE excluded = false;

CREATE INDEX IF NOT EXISTS pricing_market_trades_shipment_idx
  ON pricing_market_trades (shipment_id)
  WHERE shipment_id IS NOT NULL;

-- Tape-integrity correlation seam: m109 authenticity verdicts carry only
-- caseId, not orderId/lineId, so this small side table remembers the
-- caseId -> orderId link recorded when the case opens (which does carry
-- orderId) for the verdict-recorded reaction to join back through. Owned by
-- the same pricing-market-trades-projection group as pricing_market_trades
-- itself -- it exists purely to serve that projection's own reactions, never
-- queried by another projection or route.
CREATE TABLE IF NOT EXISTS pricing_market_trade_authenticity_cases (
  case_id text PRIMARY KEY,
  order_id text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_market_trade_authenticity_cases_order_idx
  ON pricing_market_trade_authenticity_cases (order_id);
`;
