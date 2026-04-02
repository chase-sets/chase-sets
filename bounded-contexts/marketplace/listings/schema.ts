export const marketplaceListingSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_listing_pages (
  listing_id text PRIMARY KEY,
  account_id text NOT NULL,
  inventory_record_id text NOT NULL,
  catalog_item_id text NOT NULL,
  catalog_version_key text NOT NULL,
  item_title text NULL,
  item_subtitle text NULL,
  version_selection jsonb NOT NULL DEFAULT '[]'::jsonb,
  version_summary text NULL,
  storage_location_name text NULL,
  ship_from_code text NULL,
  price_amount numeric(12,2) NOT NULL,
  quantity_cap integer NOT NULL CHECK (quantity_cap > 0),
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_account_idx
  ON marketplace_listing_pages (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_item_idx
  ON marketplace_listing_pages (catalog_item_id, status, price_amount);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_catalog_version_idx
  ON marketplace_listing_pages (catalog_version_key, status, price_amount);

CREATE INDEX IF NOT EXISTS marketplace_listing_pages_inventory_record_idx
  ON marketplace_listing_pages (inventory_record_id, status, updated_at DESC);
`;
