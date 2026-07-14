export const marketplaceOfferSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_offer_pages (
  offer_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_amount numeric(12,2) NOT NULL,
  quantity_requested integer NOT NULL CHECK (quantity_requested > 0),
  status text NOT NULL DEFAULT 'submitted',
  accepted_seller_account_id text NULL,
  accepted_listing_id text NULL,
  accepted_inventory_item_id text NULL,
  listing_evidence_policy_hash text NULL,
  listing_evidence_snapshot_hash text NULL,
  accepted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_offer_pages_buyer_account_idx
  ON marketplace_offer_pages (buyer_account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_offer_pages_catalog_catalog_item_idx
  ON marketplace_offer_pages (catalog_catalog_item_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_offer_pages_catalog_version_idx
  ON marketplace_offer_pages (product_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_offer_pages_selected_options_idx
  ON marketplace_offer_pages USING gin (selected_options);

ALTER TABLE marketplace_offer_pages
  ADD COLUMN IF NOT EXISTS shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE marketplace_offer_pages
  ADD COLUMN IF NOT EXISTS accepted_listing_id text NULL,
  ADD COLUMN IF NOT EXISTS accepted_inventory_item_id text NULL,
  ADD COLUMN IF NOT EXISTS listing_evidence_policy_hash text NULL,
  ADD COLUMN IF NOT EXISTS listing_evidence_snapshot_hash text NULL;

CREATE TABLE IF NOT EXISTS marketplace_offer_seller_controls (
  seller_account_id text NOT NULL,
  buyer_account_id text NOT NULL,
  listing_id text NOT NULL,
  product_id text NOT NULL,
  muted_at timestamptz NULL,
  declined_offer_count integer NOT NULL DEFAULT 0,
  lowball_decline_count integer NOT NULL DEFAULT 0,
  last_lowball_declined_amount numeric(12,2) NULL,
  lowball_cooldown_until timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_account_id, buyer_account_id, listing_id)
);

CREATE INDEX IF NOT EXISTS marketplace_offer_seller_controls_buyer_idx
  ON marketplace_offer_seller_controls (buyer_account_id, product_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_offer_seller_declines (
  seller_account_id text NOT NULL,
  buyer_account_id text NOT NULL,
  listing_id text NOT NULL,
  product_id text NOT NULL,
  offer_id text NOT NULL,
  offer_price_amount numeric(12,2) NOT NULL,
  listing_price_amount numeric(12,2) NOT NULL,
  declined_at timestamptz NOT NULL,
  lowball_cooldown_until timestamptz NULL,
  PRIMARY KEY (seller_account_id, listing_id, offer_id)
);

CREATE INDEX IF NOT EXISTS marketplace_offer_seller_declines_buyer_listing_idx
  ON marketplace_offer_seller_declines (buyer_account_id, listing_id, declined_at DESC);
`;
