export const checkoutMarketplaceSellerOptionsSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_marketplace_seller_options (
  listing_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  product_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  price_amount numeric(12, 2) NOT NULL,
  listing_quantity_cap integer NOT NULL,
  product_summary text NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL,
  seller_slug text NULL,
  seller_display_name text NULL,
  seller_average_rating numeric NULL,
  seller_review_count integer NULL,
  supply_total_quantity integer NULL,
  active_held_quantity integer NULL,
  inventory_item_id text NULL
);

CREATE INDEX IF NOT EXISTS checkout_marketplace_seller_options_product_idx
  ON checkout_marketplace_seller_options (product_id, status, price_amount);
`;
