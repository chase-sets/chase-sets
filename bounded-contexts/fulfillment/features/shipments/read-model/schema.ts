export const fulfillmentShipmentSchemaSql = `
CREATE TABLE IF NOT EXISTS fulfillment_shipment_pages (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  shipping_option text NOT NULL,
  shipping_method text NULL,
  carrier_name text NULL,
  label_reference text NULL,
  tracking_identifier text NULL,
  status text NOT NULL,
  package_status text NOT NULL,
  package_count integer NULL,
  current_exception_type text NULL,
  current_exception_notes text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  package_prepared_at timestamptz NULL,
  label_attached_at timestamptz NULL,
  dispatched_at timestamptz NULL,
  delivered_at timestamptz NULL,
  returned_at timestamptz NULL,
  exception_raised_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS fulfillment_shipment_pages_order_idx
  ON fulfillment_shipment_pages (order_id);

CREATE INDEX IF NOT EXISTS fulfillment_shipment_pages_buyer_idx
  ON fulfillment_shipment_pages (buyer_account_id, updated_at DESC, shipment_id DESC);

CREATE INDEX IF NOT EXISTS fulfillment_shipment_pages_seller_idx
  ON fulfillment_shipment_pages (seller_account_id, updated_at DESC, shipment_id DESC);

CREATE TABLE IF NOT EXISTS fulfillment_shipment_line_pages (
  shipment_id text NOT NULL REFERENCES fulfillment_shipment_pages (shipment_id) ON DELETE CASCADE,
  line_id text NOT NULL,
  line_index integer NOT NULL,
  order_line_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  item_title text NOT NULL,
  item_subtitle text NULL,
  product_summary text NULL,
  quantity integer NOT NULL,
  PRIMARY KEY (shipment_id, line_id)
);

CREATE TABLE IF NOT EXISTS fulfillment_shipment_exception_pages (
  shipment_id text NOT NULL REFERENCES fulfillment_shipment_pages (shipment_id) ON DELETE CASCADE,
  raised_at timestamptz NOT NULL,
  exception_type text NOT NULL,
  notes text NULL,
  PRIMARY KEY (shipment_id, raised_at)
);
`;
