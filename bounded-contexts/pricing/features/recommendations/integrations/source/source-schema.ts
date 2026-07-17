export const pricingRecommendationSourceSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_catalog_item_inputs (
  catalog_item_id text PRIMARY KEY,
  language_code text NOT NULL DEFAULT 'en',
  title text NOT NULL,
  subtitle text NULL,
  status text NOT NULL,
  category_ids text[] NOT NULL DEFAULT '{}',
  slug text NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE pricing_catalog_item_inputs
  ADD COLUMN IF NOT EXISTS language_code text NOT NULL DEFAULT 'en';

ALTER TABLE pricing_catalog_item_inputs
  ADD COLUMN IF NOT EXISTS category_ids text[] NOT NULL DEFAULT '{}';
-- Public market pages address catalog items by slug. Minted locally
-- (see ../../../../support/runtime-support/slugs.ts) from title/subtitle/id
-- already carried on the events this projection already consumes -- no new
-- event subscription needed, just a subscriptionVersion bump so replay
-- backfills the column for every pre-existing row.
ALTER TABLE pricing_catalog_item_inputs
  ADD COLUMN IF NOT EXISTS slug text NULL;

CREATE TABLE IF NOT EXISTS pricing_inventory_item_inputs (
  item_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  total_quantity integer NOT NULL CHECK (total_quantity >= 0),
  acquisition_cost_amount numeric(12, 2) NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL CHECK (last_stream_version >= 1)
);

ALTER TABLE pricing_inventory_item_inputs
  ADD COLUMN IF NOT EXISTS acquisition_cost_amount numeric(12, 2) NULL;

CREATE TABLE IF NOT EXISTS pricing_inventory_hold_inputs (
  hold_id text PRIMARY KEY,
  item_id text NOT NULL,
  seller_account_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  status text NOT NULL,
  released_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL CHECK (last_stream_version >= 1)
);

CREATE INDEX IF NOT EXISTS pricing_inventory_item_inputs_lookup_idx
  ON pricing_inventory_item_inputs (seller_account_id, catalog_catalog_item_id, product_id);

CREATE INDEX IF NOT EXISTS pricing_inventory_hold_inputs_item_idx
  ON pricing_inventory_hold_inputs (item_id, status);

CREATE TABLE IF NOT EXISTS pricing_market_listing_inputs (
  listing_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  inventory_item_id text NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  price_amount numeric(12, 2) NOT NULL,
  quantity_cap integer NOT NULL CHECK (quantity_cap >= 0),
  status text NOT NULL,
  grading text NULL CHECK (grading IS NULL OR grading IN ('graded', 'raw')),
  created_at timestamptz NULL,
  pause_reason text NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL DEFAULT 0 CHECK (last_stream_version >= 0)
);

CREATE INDEX IF NOT EXISTS pricing_market_listing_inputs_lookup_idx
  ON pricing_market_listing_inputs (seller_account_id, catalog_catalog_item_id, product_id, status);

ALTER TABLE pricing_market_listing_inputs
  ADD COLUMN IF NOT EXISTS inventory_item_id text NULL;

ALTER TABLE pricing_market_listing_inputs
  ADD COLUMN IF NOT EXISTS grading text NULL;

ALTER TABLE pricing_market_listing_inputs
  ADD COLUMN IF NOT EXISTS created_at timestamptz NULL;

ALTER TABLE pricing_market_listing_inputs
  ADD COLUMN IF NOT EXISTS pause_reason text NULL;

-- Stale-input guard: the listing handlers only advance a row when the event
-- carries a newer stream version, so a redelivered old price/lifecycle event
-- can never regress a newer competitor price. Backfilled lock-safely with a
-- constant 0 default (0 = pre-versioned baseline that the next real event,
-- always version >= 1, supersedes).
ALTER TABLE pricing_market_listing_inputs
  ADD COLUMN IF NOT EXISTS last_stream_version integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS pricing_market_listing_inputs_inventory_idx
  ON pricing_market_listing_inputs (seller_account_id, inventory_item_id, status)
  WHERE inventory_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pricing_buyer_offer_inputs (
  offer_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  seller_account_id text NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  price_amount numeric(12, 2) NOT NULL,
  quantity_requested integer NOT NULL CHECK (quantity_requested > 0),
  status text NOT NULL,
  accepted_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL DEFAULT 0 CHECK (last_stream_version >= 0)
);

CREATE INDEX IF NOT EXISTS pricing_buyer_offer_inputs_lookup_idx
  ON pricing_buyer_offer_inputs (catalog_catalog_item_id, product_id, status);

-- Stale-input guard: submitted/accepted upserts only advance a row when the
-- offer-stream version is newer, so a redelivered submitted can never clobber
-- an accepted price. Backfilled lock-safely with a constant 0 default.
ALTER TABLE pricing_buyer_offer_inputs
  ADD COLUMN IF NOT EXISTS last_stream_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS pricing_order_signal_lines (
  order_id text NOT NULL,
  line_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  unit_price_amount numeric(12, 2) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL,
  ready_for_fulfillment_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (order_id, line_id)
);

CREATE INDEX IF NOT EXISTS pricing_order_signal_lines_lookup_idx
  ON pricing_order_signal_lines (seller_account_id, catalog_catalog_item_id, product_id, status);

CREATE TABLE IF NOT EXISTS pricing_fulfillment_signal_lines (
  shipment_id text NOT NULL,
  line_id text NOT NULL,
  order_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL,
  delivered_at timestamptz NULL,
  returned_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (shipment_id, line_id)
);

CREATE INDEX IF NOT EXISTS pricing_fulfillment_signal_lines_lookup_idx
  ON pricing_fulfillment_signal_lines (catalog_catalog_item_id, product_id, status);
`;
