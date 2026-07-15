export const inventoryRecoveredItemSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_recovered_items (
  recovered_item_id text PRIMARY KEY,
  return_shipment_id text NOT NULL UNIQUE,
  remedy_id text NOT NULL,
  custody_location_id text NOT NULL,
  custody_identifier text NOT NULL,
  evidence_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL,
  catalog_item_id text NULL,
  product_id text NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  condition_grade text NULL,
  authenticity_review_required boolean NOT NULL DEFAULT false,
  authenticity_outcome text NULL,
  disposition_authority jsonb NULL,
  disposition text NULL,
  target_account_id text NULL,
  storage_location_id text NULL,
  sellable_at timestamptz NULL,
  merged_into_recovered_item_id text NULL,
  received_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_stream_version bigint NOT NULL DEFAULT 0 CHECK (last_stream_version >= 0)
);

CREATE INDEX IF NOT EXISTS inventory_recovered_items_status_age_idx
  ON inventory_recovered_items (status, received_at, recovered_item_id);

CREATE INDEX IF NOT EXISTS inventory_recovered_items_remedy_idx
  ON inventory_recovered_items (remedy_id);

CREATE TABLE IF NOT EXISTS inventory_recovered_item_audit (
  event_id text PRIMARY KEY,
  recovered_item_id text NOT NULL,
  action text NOT NULL,
  actor_user_id text NULL,
  evidence_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  stream_version bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS inventory_recovered_item_audit_item_idx
  ON inventory_recovered_item_audit (recovered_item_id, stream_version);

CREATE TABLE IF NOT EXISTS inventory_recovered_item_values (
  recovery_id text PRIMARY KEY,
  recovered_item_id text NOT NULL,
  remedy_id text NOT NULL,
  recovery_type text NOT NULL,
  gross_amount numeric(12,2) NOT NULL CHECK (gross_amount >= 0),
  cost_amount numeric(12,2) NOT NULL CHECK (cost_amount >= 0),
  currency_code text NOT NULL,
  policy_version text NOT NULL,
  evidence_references jsonb NOT NULL,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS inventory_recovered_item_values_remedy_idx
  ON inventory_recovered_item_values (remedy_id, recorded_at);
`;
