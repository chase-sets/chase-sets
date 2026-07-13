export const marketplaceListingSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_listing_pages (
  listing_id text PRIMARY KEY,
  account_id text NOT NULL,
  inventory_item_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_language_code text NULL,
  item_title text NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  product_measure_snapshot jsonb NULL,
  graded_card jsonb NULL,
  storage_location_name text NULL,
  ship_from_code text NULL,
  ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_amount numeric(12,2) NOT NULL,
  marketplace_sales_fee_unit_amount numeric(12,2) NOT NULL,
  seller_net_unit_amount numeric(12,2) NOT NULL,
  shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NULL,
  fee_quote_fingerprint text NOT NULL,
  fee_locks jsonb NOT NULL DEFAULT '[]'::jsonb,
  quantity_cap integer NOT NULL CHECK (quantity_cap > 0),
  max_units_per_order integer NULL CHECK (max_units_per_order IS NULL OR max_units_per_order > 0),
  max_units_per_day integer NULL CHECK (max_units_per_day IS NULL OR max_units_per_day > 0),
  max_units_per_customer_account integer NULL CHECK (max_units_per_customer_account IS NULL OR max_units_per_customer_account > 0),
  listing_photos jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  ADD COLUMN IF NOT EXISTS shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS ship_from_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS item_language_code text NULL,
  ADD COLUMN IF NOT EXISTS product_measure_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS max_units_per_order integer NULL,
  ADD COLUMN IF NOT EXISTS max_units_per_day integer NULL,
  ADD COLUMN IF NOT EXISTS max_units_per_customer_account integer NULL,
  ADD COLUMN IF NOT EXISTS listing_photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS fee_locks jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS marketplace_anonymous_listing_draft_intents (
  intent_id text PRIMARY KEY,
  anonymous_owner_id text NOT NULL,
  source_path text NOT NULL,
  catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  price_amount numeric(12,2) NOT NULL,
  quantity_cap integer NOT NULL CHECK (quantity_cap > 0),
  max_units_per_order integer NULL CHECK (max_units_per_order IS NULL OR max_units_per_order > 0),
  max_units_per_day integer NULL CHECK (max_units_per_day IS NULL OR max_units_per_day > 0),
  max_units_per_customer_account integer NULL CHECK (
    max_units_per_customer_account IS NULL OR max_units_per_customer_account > 0
  ),
  status text NOT NULL DEFAULT 'active',
  claimed_account_id text NULL,
  claimed_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_anonymous_listing_draft_owner_idx
  ON marketplace_anonymous_listing_draft_intents (anonymous_owner_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_anonymous_listing_draft_expiry_idx
  ON marketplace_anonymous_listing_draft_intents (status, expires_at);

CREATE TABLE IF NOT EXISTS marketplace_seller_listing_availability_pages (
  account_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'available',
  disabled_reason_category text NULL,
  available_again_on date NULL,
  available_again_at timestamptz NULL,
  disabled_at timestamptz NULL,
  enabled_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_seller_listing_availability_status_idx
  ON marketplace_seller_listing_availability_pages (status, updated_at DESC);

ALTER TABLE marketplace_seller_listing_availability_pages
  ADD COLUMN IF NOT EXISTS available_again_at timestamptz NULL;
`;
