export const pricingOwnSaleObservationsSchemaSql = `
CREATE TABLE IF NOT EXISTS pricing_own_sale_observations (
  sale_event_id text PRIMARY KEY,
  seller_account_id text NOT NULL CHECK (seller_account_id <> ''),
  inventory_item_id text NOT NULL,
  catalog_catalog_item_id text NULL,
  product_id text NULL,
  source text NOT NULL CHECK (source IN ('external-channel', 'offline')),
  provider_key text NULL,
  offline_channel text NULL CHECK (offline_channel IS NULL OR offline_channel IN ('in-store', 'card-show', 'other')),
  requested_quantity integer NULL CHECK (requested_quantity IS NULL OR requested_quantity > 0),
  applied_quantity integer NOT NULL CHECK (applied_quantity >= 0),
  unit_price_amount numeric(12, 2) NULL,
  currency_code text NULL,
  shipping_collected_amount numeric(12, 2) NULL,
  channel_fee_amount numeric(12, 2) NULL,
  sold_at timestamptz NULL,
  recorded_at timestamptz NOT NULL,
  sale_at timestamptz GENERATED ALWAYS AS (COALESCE(sold_at, recorded_at)) STORED,
  updated_at timestamptz NOT NULL,
  CHECK ((catalog_catalog_item_id IS NULL) = (product_id IS NULL)),
  CHECK (
    (source = 'external-channel'
      AND provider_key IS NOT NULL
      AND offline_channel IS NULL
      AND requested_quantity IS NOT NULL)
    OR
    (source = 'offline'
      AND provider_key IS NULL
      AND offline_channel IS NOT NULL
      AND requested_quantity IS NULL
      AND currency_code IS NULL
      AND shipping_collected_amount IS NULL
      AND channel_fee_amount IS NULL
      AND sold_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS pricing_own_sale_observations_list_idx
  ON pricing_own_sale_observations (
    seller_account_id,
    catalog_catalog_item_id,
    product_id,
    sale_at DESC,
    sale_event_id
  );

CREATE INDEX IF NOT EXISTS pricing_own_sale_observations_low_idx
  ON pricing_own_sale_observations (
    seller_account_id,
    currency_code,
    catalog_catalog_item_id,
    product_id,
    sale_at,
    unit_price_amount
  )
  WHERE applied_quantity > 0
    AND product_id IS NOT NULL
    AND unit_price_amount IS NOT NULL
    AND currency_code IS NOT NULL;
`;
