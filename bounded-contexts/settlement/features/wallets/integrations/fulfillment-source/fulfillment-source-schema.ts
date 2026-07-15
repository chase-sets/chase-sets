export const settlementFulfillmentSourceSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_order_fulfillment_sources (
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
  exception_raised_at timestamptz NULL,
  last_stream_version integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_order_fulfillment_sources_order_idx
  ON settlement_order_fulfillment_sources (order_id, seller_account_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS settlement_order_fulfillment_sources_seller_idx
  ON settlement_order_fulfillment_sources (seller_account_id, updated_at DESC);

CREATE UNLOGGED TABLE IF NOT EXISTS settlement_return_label_sources (
  return_shipment_id text PRIMARY KEY,
  support_request_id text NOT NULL,
  order_id text NOT NULL,
  seller_account_id text NOT NULL,
  cost_payer text NOT NULL,
  postage_amount numeric(12, 2) NOT NULL DEFAULT 0,
  currency_code text NULL,
  label_status text NOT NULL DEFAULT 'requested',
  updated_at timestamptz NOT NULL
);
`;
