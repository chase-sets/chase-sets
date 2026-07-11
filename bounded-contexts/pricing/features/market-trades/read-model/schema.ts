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
  -- Always false until the m109 authenticity-check integration wires
  -- verified-sale markers onto this seam.
  verified boolean NOT NULL DEFAULT false,
  -- Fraud/self-dealing exclusion wiring is a later slice; this table only
  -- wires the refund/cancel reasons already available from order and
  -- shipment facts, leaving the remaining reasons as a seam.
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
`;
