export const inventoryHoldCollisionSchemaSql = `
CREATE UNLOGGED TABLE IF NOT EXISTS inventory_hold_collisions (
  collision_id text PRIMARY KEY,
  account_id text NOT NULL,
  item_id text NOT NULL,
  storage_location_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('protect-orders', 'honor-offline')),
  reason text NOT NULL,
  requested_quantity integer NOT NULL CHECK (requested_quantity > 0),
  applied_quantity integer NOT NULL CHECK (applied_quantity >= 0),
  refused_quantity integer NOT NULL CHECK (refused_quantity >= 0),
  held_quantity integer NOT NULL CHECK (held_quantity >= 0),
  available_quantity integer NOT NULL CHECK (available_quantity >= 0),
  released_hold_quantity integer NOT NULL CHECK (released_hold_quantity >= 0),
  affected_orders jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded_at timestamptz NOT NULL,
  last_stream_version bigint NOT NULL CHECK (last_stream_version >= 1)
);

CREATE INDEX IF NOT EXISTS inventory_hold_collisions_account_recorded_idx
  ON inventory_hold_collisions (account_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS inventory_hold_collisions_item_recorded_idx
  ON inventory_hold_collisions (item_id, recorded_at DESC);
`;
