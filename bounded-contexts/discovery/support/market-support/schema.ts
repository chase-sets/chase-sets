export const discoveryMarketSchemaSql = `CREATE TABLE IF NOT EXISTS discovery_market_accounts (
  account_id text PRIMARY KEY,
  seller_display_name text NULL,
  status text NOT NULL DEFAULT 'active',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS discovery_market_listings (
  listing_id text PRIMARY KEY,
  account_id text NOT NULL,
  inventory_item_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  storage_location_name text NULL,
  ship_from_code text NULL,
  price_amount text NOT NULL,
  quantity_cap integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_market_listings_catalog_item_idx
  ON discovery_market_listings (catalog_catalog_item_id);
CREATE INDEX IF NOT EXISTS discovery_market_listings_version_idx
  ON discovery_market_listings (product_id);
CREATE INDEX IF NOT EXISTS discovery_market_listings_account_idx
  ON discovery_market_listings (account_id);
CREATE INDEX IF NOT EXISTS discovery_market_listings_status_idx
  ON discovery_market_listings (status);

CREATE TABLE IF NOT EXISTS discovery_buyer_offer_matches (
  offer_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  price_amount text NOT NULL,
  quantity_requested integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'submitted',
  accepted_seller_account_id text NULL,
  accepted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS discovery_buyer_offer_matches_catalog_item_idx
  ON discovery_buyer_offer_matches (catalog_catalog_item_id);
CREATE INDEX IF NOT EXISTS discovery_buyer_offer_matches_product_idx
  ON discovery_buyer_offer_matches (product_id);
CREATE INDEX IF NOT EXISTS discovery_buyer_offer_matches_buyer_idx
  ON discovery_buyer_offer_matches (buyer_account_id);
CREATE INDEX IF NOT EXISTS discovery_buyer_offer_matches_status_idx
  ON discovery_buyer_offer_matches (status);`;
