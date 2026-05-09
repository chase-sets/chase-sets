export const orderingSupplySourceSchemaSql = `
CREATE TABLE IF NOT EXISTS ordering_market_listing_inputs (
  listing_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  inventory_item_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  storage_location_name text NULL,
  ship_from_code text NULL,
  ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_amount numeric(12, 2) NOT NULL,
  marketplace_sales_fee_unit_amount numeric(12, 2) NOT NULL,
  seller_net_unit_amount numeric(12, 2) NOT NULL,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NOT NULL,
  quantity_cap integer NOT NULL CHECK (quantity_cap >= 0),
  status text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ordering_market_listing_inputs_lookup_idx
  ON ordering_market_listing_inputs (product_id, status, price_amount, updated_at);

CREATE INDEX IF NOT EXISTS ordering_market_listing_inputs_item_idx
  ON ordering_market_listing_inputs (inventory_item_id, status, updated_at);

CREATE TABLE IF NOT EXISTS ordering_inventory_item_inputs (
  item_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  total_quantity integer NOT NULL CHECK (total_quantity >= 0),
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL CHECK (last_stream_version >= 1)
);

CREATE INDEX IF NOT EXISTS ordering_inventory_item_inputs_lookup_idx
  ON ordering_inventory_item_inputs (seller_account_id, catalog_catalog_item_id, product_id);

CREATE TABLE IF NOT EXISTS ordering_inventory_hold_inputs (
  hold_id text PRIMARY KEY,
  item_id text NOT NULL,
  seller_account_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 0),
  status text NOT NULL,
  released_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version integer NOT NULL CHECK (last_stream_version >= 1)
);

CREATE INDEX IF NOT EXISTS ordering_inventory_hold_inputs_item_idx
  ON ordering_inventory_hold_inputs (item_id, status);

CREATE TABLE IF NOT EXISTS ordering_offer_acceptance_inputs (
  offer_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  price_amount numeric(12, 2) NOT NULL,
  marketplace_sales_fee_unit_amount numeric(12, 2) NOT NULL,
  seller_net_unit_amount numeric(12, 2) NOT NULL,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NOT NULL,
  quantity_requested integer NOT NULL CHECK (quantity_requested > 0),
  shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  accepted_at timestamptz NOT NULL,
  acceptance_batch_id text NULL,
  acceptance_batch_size integer NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE ordering_market_listing_inputs
  ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ordering_offer_acceptance_inputs
  ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500;

ALTER TABLE ordering_offer_acceptance_inputs
  ADD COLUMN IF NOT EXISTS acceptance_batch_id text NULL;

ALTER TABLE ordering_offer_acceptance_inputs
  ADD COLUMN IF NOT EXISTS acceptance_batch_size integer NULL;

ALTER TABLE ordering_offer_acceptance_inputs
  ADD COLUMN IF NOT EXISTS shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS ordering_payment_capture_inputs (
  payment_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount numeric(12, 2) NOT NULL,
  currency_code text NOT NULL,
  processor_name text NOT NULL,
  processor_payment_reference text NOT NULL,
  processor_status text NOT NULL,
  captured_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
`;
