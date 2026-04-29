export const inventoryReservationSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_reservation_pages (
  reservation_request_id text PRIMARY KEY,
  order_id text NOT NULL,
  seller_account_id text NOT NULL,
  inventory_item_id text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  hold_id text NULL,
  status text NOT NULL,
  rejection_reason text NULL,
  released_at timestamptz NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS inventory_reservation_pages_order_idx
  ON inventory_reservation_pages (order_id, updated_at DESC);
`;
