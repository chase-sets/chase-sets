export const inventoryRestockDecisionSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_restock_decisions (
  decision_id text PRIMARY KEY,
  account_id text NOT NULL,
  order_id text NOT NULL,
  item_id text NOT NULL REFERENCES inventory_items(item_id),
  quantity integer NOT NULL CHECK (quantity > 0),
  source text NOT NULL,
  source_ref jsonb NOT NULL,
  shipment_id text NULL,
  return_reason text NULL,
  status text NOT NULL CHECK (status IN ('pending', 'recorded')),
  outcome text NULL,
  damage_note text NULL,
  pending_at timestamptz NOT NULL,
  decided_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version bigint NOT NULL DEFAULT 0 CHECK (last_stream_version >= 0)
);

CREATE INDEX IF NOT EXISTS inventory_restock_decisions_account_status_idx
  ON inventory_restock_decisions (account_id, status, pending_at DESC);

CREATE INDEX IF NOT EXISTS inventory_restock_decisions_order_item_idx
  ON inventory_restock_decisions (order_id, item_id);

CREATE TABLE IF NOT EXISTS inventory_fulfillment_shipment_sources (
  shipment_id text PRIMARY KEY,
  order_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS inventory_fulfillment_shipment_sources_order_idx
  ON inventory_fulfillment_shipment_sources (order_id);
`;
