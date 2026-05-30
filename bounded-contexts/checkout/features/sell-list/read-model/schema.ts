export const checkoutSellListSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_sell_list_line_pages (
  seller_account_id text NOT NULL,
  line_id text NOT NULL,
  line_type text NOT NULL,
  offer_id text NULL,
  buyer_account_id text NULL,
  buyer_display_name text NULL,
  offer_price_amount text NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  fallback_mode text NOT NULL DEFAULT 'none',
  minimum_listing_price_amount text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_account_id, line_id)
);

CREATE INDEX IF NOT EXISTS checkout_sell_list_line_pages_seller_idx
  ON checkout_sell_list_line_pages (seller_account_id, updated_at DESC, line_id ASC);

CREATE UNIQUE INDEX IF NOT EXISTS checkout_sell_list_line_pages_offer_unique_idx
  ON checkout_sell_list_line_pages (seller_account_id, offer_id)
  WHERE offer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS checkout_sell_list_receipt_pages (
  seller_account_id text PRIMARY KEY,
  checked_out_at timestamptz NOT NULL,
  execution_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
