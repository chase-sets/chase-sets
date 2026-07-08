import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

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
  consumed_at timestamptz NULL,
  expired_at timestamptz NULL,
  extension_count integer NOT NULL DEFAULT 0,
  last_stream_version bigint NOT NULL DEFAULT 0
);

ALTER TABLE inventory_holds
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_ref jsonb NULL,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS release_reason text NULL,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS inventory_holds_account_idx
  ON inventory_holds (account_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_holds_item_idx
  ON inventory_holds (item_id, status);
`;

export const inventoryHoldSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260707_inventory_hold_checkout_lifecycle",
    description: "Add checkout hold expiry and extension read-model columns.",
    // Metadata-only ADD COLUMN changes (PostgreSQL 11+) that hold ACCESS EXCLUSIVE only for
    // an instant. The earlier ADD (nullable) -> UPDATE -> SET DEFAULT -> SET NOT NULL sequence
    // held ACCESS EXCLUSIVE across a full-table validation scan and hung the bootstrap under
    // live read traffic. See #4638.
    statements: [
      `ALTER TABLE inventory_holds
  ADD COLUMN IF NOT EXISTS expired_at timestamptz NULL;`,
      `ALTER TABLE inventory_holds
  ADD COLUMN IF NOT EXISTS extension_count integer NOT NULL DEFAULT 0;`,
    ],
  },
];
