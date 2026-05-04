export const marketplaceListingSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_listing_pages (
  listing_id text PRIMARY KEY,
  account_id text NOT NULL,
  inventory_item_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  graded_card jsonb NULL,
  storage_location_name text NULL,
  ship_from_code text NULL,
  price_amount numeric(12,2) NOT NULL,
  marketplace_sales_fee_unit_amount numeric(12,2) NOT NULL,
  seller_net_unit_amount numeric(12,2) NOT NULL,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NULL,
  fee_quote_fingerprint text NOT NULL,
  quantity_cap integer NOT NULL CHECK (quantity_cap > 0),
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_account_idx
  ON marketplace_listing_pages (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_catalog_item_idx
  ON marketplace_listing_pages (catalog_catalog_item_id, status, price_amount);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_catalog_version_idx
  ON marketplace_listing_pages (product_id, status, price_amount);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_inventory_item_idx
  ON marketplace_listing_pages (inventory_item_id, status, updated_at DESC);

ALTER TABLE marketplace_listing_pages
  ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500;
`;
