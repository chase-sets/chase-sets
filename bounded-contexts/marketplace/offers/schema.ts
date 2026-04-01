export const marketplaceOfferSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_offer_pages (
  offer_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  catalog_item_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  version_selection jsonb NOT NULL DEFAULT '[]'::jsonb,
  version_summary text NULL,
  price_amount numeric(12,2) NOT NULL,
  quantity_requested integer NOT NULL CHECK (quantity_requested > 0),
  status text NOT NULL DEFAULT 'submitted',
  accepted_seller_account_id text NULL,
  accepted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_offer_pages_buyer_account_idx
  ON marketplace_offer_pages (buyer_account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_offer_pages_catalog_item_idx
  ON marketplace_offer_pages (catalog_item_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS marketplace_offer_pages_version_selection_idx
  ON marketplace_offer_pages USING gin (version_selection);
`;
