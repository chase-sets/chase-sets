import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const inventoryItemSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_items (
  item_id text PRIMARY KEY,
  account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  graded_card jsonb NULL,
  storage_location_id text NOT NULL REFERENCES inventory_storage_locations(storage_location_id),
  total_quantity integer NOT NULL CHECK (total_quantity >= 0),
  last_stream_version bigint NOT NULL DEFAULT 0 CHECK (last_stream_version >= 0),
  acquisition_cost_amount numeric(12,2) NULL,
  acquisition_cost_currency_code text NULL CONSTRAINT inventory_items_acquisition_cost_currency_check CHECK (
    acquisition_cost_currency_code IS NULL OR
    (acquisition_cost_amount IS NOT NULL AND acquisition_cost_currency_code ~ '^[A-Z]{3}$')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS acquisition_cost_currency_code text NULL;

CREATE INDEX IF NOT EXISTS inventory_items_account_idx
  ON inventory_items (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS inventory_items_storage_location_idx
  ON inventory_items (storage_location_id);

CREATE INDEX IF NOT EXISTS inventory_items_catalog_version_idx
  ON inventory_items (product_id);

CREATE TABLE IF NOT EXISTS inventory_item_ledger (
  ledger_entry_id text PRIMARY KEY,
  item_id text NOT NULL,
  account_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL,
  quantity_delta integer NULL,
  hold_quantity integer NULL,
  purpose text NULL,
  reason text NOT NULL,
  reason_code text NULL,
  note text NULL,
  sale_price_amount numeric(12,2) NULL,
  channel text NULL,
  source_ref jsonb NULL,
  actor text NOT NULL,
  event_type text NOT NULL,
  stream_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version >= 1),
  recorded_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_item_adjustment_idempotency (
  idempotency_key text PRIMARY KEY,
  account_id text NOT NULL,
  item_id text NOT NULL,
  command_fingerprint text NOT NULL,
  claim_generation text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  result_item_id text NULL,
  result_version bigint NULL CHECK (result_version IS NULL OR result_version >= 0),
  result_collision jsonb NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS inventory_item_adjustment_idempotency_item_idx
  ON inventory_item_adjustment_idempotency (account_id, item_id, created_at DESC);
`;

export const inventoryItemSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260707_inventory_item_ledger_indexes",
    description: "Build stock-ledger read indexes outside boot-time schema SQL.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_item_ledger_item_occurred_idx
  ON inventory_item_ledger (item_id, occurred_at DESC, ledger_entry_id DESC)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_item_ledger_account_item_idx
  ON inventory_item_ledger (account_id, item_id, occurred_at DESC)`,
    ],
  },
  {
    migrationId: "20260819_inventory_item_ledger_adjustment_reason",
    description: "Add the typed adjustment reason and optional operator note to the stock ledger.",
    statements: [
      `ALTER TABLE inventory_item_ledger
  ADD COLUMN IF NOT EXISTS reason_code text`,
      `ALTER TABLE inventory_item_ledger
  ADD COLUMN IF NOT EXISTS note text`,
    ],
  },
  {
    migrationId: "20260825_inventory_offline_sale",
    description: "Persist offline-sale ledger detail and collision-aware idempotency results.",
    statements: [
      `ALTER TABLE inventory_item_ledger
  ADD COLUMN IF NOT EXISTS sale_price_amount numeric(12,2)`,
      `ALTER TABLE inventory_item_ledger
  ADD COLUMN IF NOT EXISTS channel text`,
      `ALTER TABLE inventory_item_adjustment_idempotency
  ADD COLUMN IF NOT EXISTS result_collision jsonb`,
    ],
  },
  {
    migrationId: "20260906_inventory_adjustment_claim_generation",
    description: "Fence adjustment journal completion and release to the exact claim generation.",
    statements: [
      `ALTER TABLE inventory_item_adjustment_idempotency
  ADD COLUMN IF NOT EXISTS claim_generation text`,
      `UPDATE inventory_item_adjustment_idempotency
  SET claim_generation = 'legacy:' || idempotency_key || ':' || created_at::text
  WHERE claim_generation IS NULL`,
      `DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_item_adjustment_idempotency_claim_generation_not_null'
      AND conrelid = 'inventory_item_adjustment_idempotency'::regclass
  ) THEN
    ALTER TABLE inventory_item_adjustment_idempotency
      ADD CONSTRAINT inventory_item_adjustment_idempotency_claim_generation_not_null
      CHECK (claim_generation IS NOT NULL) NOT VALID;
  END IF;
END
$migration$`,
      `ALTER TABLE inventory_item_adjustment_idempotency
  VALIDATE CONSTRAINT inventory_item_adjustment_idempotency_claim_generation_not_null`,
      `SET LOCAL lock_timeout = '5s'`,
      `ALTER TABLE inventory_item_adjustment_idempotency
  ALTER COLUMN claim_generation SET NOT NULL`,
    ],
  },
  {
    migrationId: "20260909_inventory_acquisition_cost_currency",
    description: "Preserve Inventory-authored acquisition cost denomination; retained amount-only rows stay null.",
    statements: [
      `ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS acquisition_cost_currency_code text NULL`,
      `DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_items_acquisition_cost_currency_check'
      AND conrelid = 'inventory_items'::regclass
  ) THEN
    ALTER TABLE inventory_items
      ADD CONSTRAINT inventory_items_acquisition_cost_currency_check
      CHECK (
        acquisition_cost_currency_code IS NULL OR
        (acquisition_cost_amount IS NOT NULL AND acquisition_cost_currency_code ~ '^[A-Z]{3}$')
      ) NOT VALID;
  END IF;
END
$migration$`,
      `ALTER TABLE inventory_items
  VALIDATE CONSTRAINT inventory_items_acquisition_cost_currency_check`,
    ],
  },
];
