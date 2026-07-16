export const supportSourceProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS support_order_sources (
  order_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  buyer_email text NULL,
  seller_account_id text NOT NULL,
  status text NOT NULL,
  total_amount numeric(12,2) NOT NULL DEFAULT 0,
  return_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz NULL,
  ready_for_fulfillment_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS support_order_sources_buyer_idx
  ON support_order_sources (buyer_account_id, updated_at DESC);

ALTER TABLE support_order_sources
  ADD COLUMN IF NOT EXISTS buyer_email text NULL;

ALTER TABLE support_order_sources
  ADD COLUMN IF NOT EXISTS return_context jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS support_order_sources_seller_idx
  ON support_order_sources (seller_account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS support_order_affected_line_amounts (
  order_id text NOT NULL,
  line_id text NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency_code text NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, line_id)
);

CREATE TABLE IF NOT EXISTS support_order_payment_currencies (
  order_id text PRIMARY KEY,
  currency_code text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_shipment_sources (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  status text NOT NULL,
  tracking_identifier text NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  dispatched_at timestamptz NULL,
  delivered_at timestamptz NULL,
  returned_at timestamptz NULL,
  exception_type text NULL,
  exception_notes text NULL
);

CREATE INDEX IF NOT EXISTS support_shipment_sources_order_idx
  ON support_shipment_sources (order_id, updated_at DESC);

CREATE UNLOGGED TABLE IF NOT EXISTS support_return_label_sources (
  support_request_id text PRIMARY KEY,
  return_shipment_id text NOT NULL UNIQUE,
  status text NOT NULL,
  label_status text NOT NULL,
  cost_payer text NOT NULL,
  tracking_identifier text NULL,
  label_document_url text NULL,
  postage_amount_cents integer NULL,
  postage_currency text NULL,
  failure_reason text NULL,
  ship_by_deadline_at timestamptz NOT NULL,
  return_by_deadline_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
`;
