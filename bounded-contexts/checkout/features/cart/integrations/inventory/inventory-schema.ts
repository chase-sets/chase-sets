export const checkoutInventorySupplySchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_supply_items (
  item_id text PRIMARY KEY,
  total_quantity integer NOT NULL,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checkout_supply_holds (
  hold_id text PRIMARY KEY,
  item_id text NOT NULL,
  quantity integer NOT NULL,
  status text NOT NULL,
  released_at timestamptz NULL,
  last_stream_version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkout_supply_holds_item_idx
  ON checkout_supply_holds (item_id, status);
`;
