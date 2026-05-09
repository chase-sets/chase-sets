export const fulfillmentSourceProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS fulfillment_account_pages (
  account_id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS fulfillment_account_pages_status_idx
  ON fulfillment_account_pages (status, updated_at DESC, account_id ASC);

CREATE TABLE IF NOT EXISTS fulfillment_order_sources (
  order_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  shipping_option text NOT NULL,
  shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_origin_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  ready_for_fulfillment_at timestamptz NULL,
  cancelled_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS fulfillment_order_sources_status_idx
  ON fulfillment_order_sources (status, updated_at DESC, order_id DESC);

ALTER TABLE fulfillment_order_sources
  ADD COLUMN IF NOT EXISTS shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS shipping_origin_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS fulfillment_order_source_lines (
  order_id text NOT NULL REFERENCES fulfillment_order_sources (order_id) ON DELETE CASCADE,
  line_id text NOT NULL,
  line_index integer NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  product_summary text NULL,
  quantity integer NOT NULL,
  PRIMARY KEY (order_id, line_id)
);

CREATE INDEX IF NOT EXISTS fulfillment_order_source_lines_order_idx
  ON fulfillment_order_source_lines (order_id, line_index ASC, line_id ASC);
`;
