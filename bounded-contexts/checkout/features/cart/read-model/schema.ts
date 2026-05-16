export const checkoutCartSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_cart_line_pages (
  buyer_account_id text NOT NULL,
  line_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_language_code text NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  item_image_url text NULL,
  item_image_loading_url text NULL,
  item_image_loading_alt text NULL,
  item_image_loading_srcset text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  fulfillment_mode text NOT NULL DEFAULT 'optimize',
  locked_listing_id text NULL,
  seller_preference_id text NULL,
  availability_state text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (buyer_account_id, line_id)
);

ALTER TABLE checkout_cart_line_pages
  ADD COLUMN IF NOT EXISTS item_image_url text NULL,
  ADD COLUMN IF NOT EXISTS item_image_loading_url text NULL,
  ADD COLUMN IF NOT EXISTS item_image_loading_alt text NULL,
  ADD COLUMN IF NOT EXISTS item_image_loading_srcset text NULL;

ALTER TABLE checkout_cart_line_pages
  ADD COLUMN IF NOT EXISTS fulfillment_mode text NOT NULL DEFAULT 'optimize',
  ADD COLUMN IF NOT EXISTS locked_listing_id text NULL,
  ADD COLUMN IF NOT EXISTS seller_preference_id text NULL,
  ADD COLUMN IF NOT EXISTS availability_state text NOT NULL DEFAULT 'available';

CREATE INDEX IF NOT EXISTS checkout_cart_line_pages_buyer_idx
  ON checkout_cart_line_pages (buyer_account_id, updated_at DESC, line_id ASC);

CREATE INDEX IF NOT EXISTS checkout_cart_line_pages_catalog_version_idx
  ON checkout_cart_line_pages (product_id);

ALTER TABLE checkout_cart_line_pages
  ADD COLUMN IF NOT EXISTS item_language_code text NULL;
`;
