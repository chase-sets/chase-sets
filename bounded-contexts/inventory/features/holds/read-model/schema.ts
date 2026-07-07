export const inventoryHoldSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_holds (
  hold_id text PRIMARY KEY,
  account_id text NOT NULL,
  item_id text NOT NULL REFERENCES inventory_items(item_id),
  quantity integer NOT NULL CHECK (quantity > 0),
  reason text NOT NULL,
  notes text NULL,
  purpose text NOT NULL DEFAULT 'manual',
  source_ref jsonb NULL,
  expires_at timestamptz NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz NULL,
  release_reason text NULL,
  last_stream_version bigint NOT NULL DEFAULT 0
);

ALTER TABLE inventory_holds
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_ref jsonb NULL,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS release_reason text NULL;

CREATE INDEX IF NOT EXISTS inventory_holds_account_idx
  ON inventory_holds (account_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_holds_item_idx
  ON inventory_holds (item_id, status);
`;
