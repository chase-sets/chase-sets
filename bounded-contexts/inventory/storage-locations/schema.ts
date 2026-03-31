export const inventoryStorageLocationSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_storage_locations (
  storage_location_id text PRIMARY KEY,
  account_id text NOT NULL,
  name text NOT NULL,
  description text NULL,
  ship_from_code text NOT NULL,
  is_archived boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_storage_locations_account_idx
  ON inventory_storage_locations (account_id, is_archived, name);
`;
