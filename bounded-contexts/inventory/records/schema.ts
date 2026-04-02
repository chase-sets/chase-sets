export const inventoryRecordSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_records (
  record_id text PRIMARY KEY,
  account_id text NOT NULL,
  catalog_item_id text NOT NULL,
  catalog_version_key text NOT NULL,
  version_selection jsonb NOT NULL DEFAULT '[]'::jsonb,
  storage_location_id text NOT NULL REFERENCES inventory_storage_locations(storage_location_id),
  total_quantity integer NOT NULL CHECK (total_quantity >= 0),
  acquisition_cost_amount numeric(12,2) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_records_account_idx
  ON inventory_records (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS inventory_records_storage_location_idx
  ON inventory_records (storage_location_id);

CREATE INDEX IF NOT EXISTS inventory_records_catalog_version_idx
  ON inventory_records (catalog_version_key);
`;
