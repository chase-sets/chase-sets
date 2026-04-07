export const reputationSourceProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS reputation_account_pages (
  account_id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS reputation_account_pages_status_idx
  ON reputation_account_pages (status, updated_at DESC, account_id ASC);

CREATE TABLE IF NOT EXISTS reputation_order_sources (
  order_id text PRIMARY KEY,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cancelled_at timestamptz NULL,
  ready_for_fulfillment_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS reputation_order_sources_buyer_idx
  ON reputation_order_sources (buyer_account_id, updated_at DESC, order_id DESC);

CREATE INDEX IF NOT EXISTS reputation_order_sources_seller_idx
  ON reputation_order_sources (seller_account_id, updated_at DESC, order_id DESC);

CREATE TABLE IF NOT EXISTS reputation_shipment_sources (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  dispatched_at timestamptz NULL,
  delivered_at timestamptz NULL,
  returned_at timestamptz NULL,
  exception_raised_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS reputation_shipment_sources_order_idx
  ON reputation_shipment_sources (order_id, updated_at DESC, shipment_id DESC);
`;
