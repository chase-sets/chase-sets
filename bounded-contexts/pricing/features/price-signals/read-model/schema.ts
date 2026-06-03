export const pricingPriceSignalSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_external_product_reference_inputs (
  provider_key text NOT NULL,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL,
  catalog_product_key text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider_key, external_key)
);

CREATE INDEX IF NOT EXISTS pricing_external_product_reference_inputs_catalog_idx
  ON pricing_external_product_reference_inputs (catalog_item_id, catalog_product_key);

CREATE TABLE IF NOT EXISTS pricing_tcgplayer_price_signals (
  signal_id text PRIMARY KEY,
  external_key text NOT NULL,
  catalog_item_id text NOT NULL,
  catalog_product_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('current', 'stale', 'missing-price')),
  market_price_amount numeric(12, 2) NULL,
  lowest_price_amount numeric(12, 2) NULL,
  highest_price_amount numeric(12, 2) NULL,
  price_count integer NULL CHECK (price_count IS NULL OR price_count >= 0),
  calculated_at timestamptz NULL,
  observed_at timestamptz NOT NULL,
  stale_after timestamptz NOT NULL,
  source_payload jsonb NOT NULL,
  recommendation_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pricing_tcgplayer_price_signals_product_idx
  ON pricing_tcgplayer_price_signals (catalog_item_id, catalog_product_key, observed_at DESC);

CREATE INDEX IF NOT EXISTS pricing_tcgplayer_price_signals_external_idx
  ON pricing_tcgplayer_price_signals (external_key, observed_at DESC);
`;
