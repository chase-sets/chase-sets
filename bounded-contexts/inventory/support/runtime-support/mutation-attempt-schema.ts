import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const inventoryMutationAttemptTableSql = `
CREATE TABLE IF NOT EXISTS inventory_mutation_attempts (
  attempt_key text PRIMARY KEY CHECK (attempt_key ~ '^[a-f0-9]{64}$'),
  tenant_id text NOT NULL,
  actor_user_id text NOT NULL,
  account_id text NOT NULL,
  requesting_account_id text,
  family text NOT NULL,
  target_id text NOT NULL,
  fingerprint_version integer NOT NULL CHECK (fingerprint_version > 0),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  receipt_version integer NOT NULL CHECK (receipt_version > 0),
  status text NOT NULL CHECK (status IN ('accepted', 'succeeded')),
  result jsonb,
  result_hash text,
  completed_at timestamptz,
  CHECK ((status = 'accepted' AND result IS NULL AND result_hash IS NULL AND completed_at IS NULL)
    OR (status = 'succeeded' AND result IS NOT NULL AND result_hash IS NOT NULL AND result_hash ~ '^[a-f0-9]{64}$' AND completed_at IS NOT NULL))
);
ALTER TABLE inventory_mutation_attempts ADD COLUMN IF NOT EXISTS requesting_account_id text;
`;
export const inventoryMutationAttemptSchemaSql = `${inventoryMutationAttemptTableSql}
CREATE INDEX IF NOT EXISTS inventory_mutation_attempts_account_idx
  ON inventory_mutation_attempts (tenant_id, actor_user_id, account_id, completed_at);
`;

export const inventoryMutationAttemptSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261013_inventory_mutation_attempt_receipts",
    description:
      "Install versioned Inventory attempt readers and immutable terminal receipt storage before writer cutover.",
    statements: [
      inventoryMutationAttemptTableSql,
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_mutation_attempts_account_idx ON inventory_mutation_attempts (tenant_id, actor_user_id, account_id, completed_at)",
    ],
  },
];
