export const orderingOrderSchemaSql = `
CREATE TABLE IF NOT EXISTS ordering_order_pages (
  order_id text PRIMARY KEY,
  source_type text NOT NULL,
  source_reference_id text NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  shipping_option text NOT NULL,
  item_subtotal_amount numeric(12,2) NOT NULL,
  shipping_base_amount numeric(12,2) NOT NULL,
  shipping_discount_amount numeric(12,2) NOT NULL,
  shipping_charge_amount numeric(12,2) NOT NULL,
  total_amount numeric(12,2) NOT NULL,
  marketplace_fee_amount numeric(12,2) NOT NULL,
  payment_fee_amount numeric(12,2) NOT NULL,
  seller_net_amount numeric(12,2) NOT NULL,
  terms_schedule_id text NULL,
  terms_agreement_id text NULL,
  terms_resolved_at timestamptz NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz NULL,
  cancellation_reason text NULL,
  ready_for_fulfillment_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS ordering_order_pages_buyer_idx
  ON ordering_order_pages (buyer_account_id, updated_at DESC, order_id DESC);

CREATE INDEX IF NOT EXISTS ordering_order_pages_seller_idx
  ON ordering_order_pages (seller_account_id, updated_at DESC, order_id DESC);

CREATE TABLE IF NOT EXISTS ordering_order_line_pages (
  order_id text NOT NULL,
  line_id text NOT NULL,
  line_index integer NOT NULL,
  listing_id text NOT NULL,
  inventory_item_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  product_summary text NULL,
  unit_price_amount numeric(12,2) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  line_total_amount numeric(12,2) NOT NULL,
  PRIMARY KEY (order_id, line_id)
);

CREATE INDEX IF NOT EXISTS ordering_order_line_pages_order_idx
  ON ordering_order_line_pages (order_id, line_index ASC);

CREATE INDEX IF NOT EXISTS ordering_order_line_pages_catalog_version_idx
  ON ordering_order_line_pages (product_id);

CREATE TABLE IF NOT EXISTS ordering_order_hold_pages (
  hold_id text PRIMARY KEY,
  order_id text NOT NULL,
  seller_account_id text NOT NULL,
  inventory_item_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS ordering_order_hold_pages_order_idx
  ON ordering_order_hold_pages (order_id, created_at ASC);
`;
