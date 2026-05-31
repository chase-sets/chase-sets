export const fulfillmentShipmentSchemaSql = `
CREATE TABLE IF NOT EXISTS fulfillment_shipment_pages (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  shipping_option text NOT NULL,
  shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_origin_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_method text NULL,
  carrier_name text NULL,
  label_reference text NULL,
  label_document_url text NULL,
  tracking_identifier text NULL,
  postage_provider_name text NULL,
  postage_provider_mode text NULL,
  postage_provider_shipment_id text NULL,
  postage_provider_label_id text NULL,
  postage_rate_id text NULL,
  postage_service_level text NULL,
  postage_amount_cents integer NULL,
  postage_currency text NULL,
  label_status text NOT NULL DEFAULT 'not-purchased',
  label_error_code text NULL,
  label_error_message text NULL,
  label_refund_status text NULL,
  label_refund_reference text NULL,
  status text NOT NULL,
  package_status text NOT NULL,
  package_count integer NULL,
  current_exception_type text NULL,
  current_exception_notes text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  packing_started_at timestamptz NULL,
  package_prepared_at timestamptz NULL,
  label_attached_at timestamptz NULL,
  label_voided_at timestamptz NULL,
  cancelled_at timestamptz NULL,
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
  packing_confirmed_quantity integer NOT NULL DEFAULT 0,
  packing_confirmed_at timestamptz NULL,
  PRIMARY KEY (shipment_id, line_id)
);

CREATE TABLE IF NOT EXISTS fulfillment_shipment_exception_pages (
  shipment_id text NOT NULL REFERENCES fulfillment_shipment_pages (shipment_id) ON DELETE CASCADE,
  raised_at timestamptz NOT NULL,
  exception_type text NOT NULL,
  notes text NULL,
  PRIMARY KEY (shipment_id, raised_at)
);

ALTER TABLE IF EXISTS fulfillment_shipment_pages
  ADD COLUMN IF NOT EXISTS shipping_destination_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS shipping_origin_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS shipping_plan_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS label_document_url text NULL,
  ADD COLUMN IF NOT EXISTS postage_provider_name text NULL,
  ADD COLUMN IF NOT EXISTS postage_provider_mode text NULL,
  ADD COLUMN IF NOT EXISTS postage_provider_shipment_id text NULL,
  ADD COLUMN IF NOT EXISTS postage_provider_label_id text NULL,
  ADD COLUMN IF NOT EXISTS postage_rate_id text NULL,
  ADD COLUMN IF NOT EXISTS postage_service_level text NULL,
  ADD COLUMN IF NOT EXISTS postage_amount_cents integer NULL,
  ADD COLUMN IF NOT EXISTS postage_currency text NULL,
  ADD COLUMN IF NOT EXISTS label_status text NOT NULL DEFAULT 'not-purchased',
  ADD COLUMN IF NOT EXISTS label_error_code text NULL,
  ADD COLUMN IF NOT EXISTS label_error_message text NULL,
  ADD COLUMN IF NOT EXISTS label_refund_status text NULL,
  ADD COLUMN IF NOT EXISTS label_refund_reference text NULL,
  ADD COLUMN IF NOT EXISTS packing_started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS label_voided_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL;

ALTER TABLE IF EXISTS fulfillment_shipment_line_pages
  ADD COLUMN IF NOT EXISTS packing_confirmed_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS packing_confirmed_at timestamptz NULL;

UPDATE fulfillment_shipment_line_pages
SET packing_confirmed_quantity = quantity
WHERE packing_confirmed_quantity = 0
  AND packing_confirmed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS fulfillment_label_address_override_audit_pages (
  shipment_id text NOT NULL REFERENCES fulfillment_shipment_pages (shipment_id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL,
  changed_side text NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL,
  original_sender_snapshot jsonb NOT NULL,
  submitted_sender_address jsonb NOT NULL,
  original_recipient_snapshot jsonb NOT NULL,
  submitted_recipient_address jsonb NOT NULL,
  PRIMARY KEY (shipment_id, recorded_at)
);

CREATE TABLE IF NOT EXISTS fulfillment_postage_label_operations (
  operation_key text PRIMARY KEY,
  operation_kind text NOT NULL CHECK (operation_kind IN ('purchase-usps-label', 'void-label')),
  shipment_id text NOT NULL,
  provider_name text NOT NULL,
  provider_mode text NOT NULL,
  idempotency_key text NOT NULL,
  request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_shipment_id text NULL,
  provider_label_id text NULL,
  tracking_identifier text NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS fulfillment_postage_label_operations_status_idx
  ON fulfillment_postage_label_operations (status, updated_at);
`;
