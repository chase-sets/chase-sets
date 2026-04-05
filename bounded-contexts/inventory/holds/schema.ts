export const inventoryHoldSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_holds (
  hold_id text PRIMARY KEY,
  account_id text NOT NULL,
  record_id text NOT NULL REFERENCES inventory_records(record_id),
  quantity integer NOT NULL CHECK (quantity > 0),
  reason text NOT NULL,
  notes text NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS inventory_holds_account_idx
  ON inventory_holds (account_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_holds_record_idx
  ON inventory_holds (record_id, status);
`;
