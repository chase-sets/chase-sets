export const orderingCartSchemaSql = `
CREATE TABLE IF NOT EXISTS ordering_cart_line_pages (
  buyer_account_id text NOT NULL,
  line_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (buyer_account_id, line_id)
);

CREATE INDEX IF NOT EXISTS ordering_cart_line_pages_buyer_idx
  ON ordering_cart_line_pages (buyer_account_id, updated_at DESC, line_id ASC);

CREATE INDEX IF NOT EXISTS ordering_cart_line_pages_catalog_version_idx
  ON ordering_cart_line_pages (product_id);
`;
