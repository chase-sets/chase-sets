export const savedListValuationSchemaSql = `
CREATE TABLE IF NOT EXISTS collections_saved_list_valuation_lists (
  list_id text PRIMARY KEY,
  owner_account_id text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
  lifecycle text NOT NULL CHECK (lifecycle IN ('active', 'archived')),
  source_version integer NOT NULL,
  changed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS collections_saved_list_valuation_lists_owner_idx
  ON collections_saved_list_valuation_lists (owner_account_id, list_id);

CREATE TABLE IF NOT EXISTS collections_saved_list_valuation_lines (
  list_id text NOT NULL,
  line_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  tracked_quantity integer NOT NULL CHECK (tracked_quantity > 0),
  active boolean NOT NULL,
  source_version integer NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (list_id, line_id)
);

CREATE INDEX IF NOT EXISTS collections_saved_list_valuation_lines_product_idx
  ON collections_saved_list_valuation_lines (catalog_catalog_item_id, product_id, list_id)
  WHERE active;

CREATE INDEX IF NOT EXISTS collections_saved_list_valuation_lines_list_idx
  ON collections_saved_list_valuation_lines (list_id, line_id)
  WHERE active;

CREATE TABLE IF NOT EXISTS collections_saved_list_market_estimates (
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  estimate_version text NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_ended_at timestamptz NOT NULL,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  band_low_amount numeric(12, 2) NULL,
  band_high_amount numeric(12, 2) NULL,
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  estimated_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  disclosure text NOT NULL CHECK (disclosure IN ('internal', 'account', 'public')),
  source_global_position numeric(30, 0) NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_catalog_item_id, product_id)
);

CREATE INDEX IF NOT EXISTS collections_saved_list_market_estimates_freshness_idx
  ON collections_saved_list_market_estimates (fresh_until, confidence);
`;
