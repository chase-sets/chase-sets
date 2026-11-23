import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const savedListRecoverySchemaSql = `CREATE TABLE IF NOT EXISTS collections_saved_list_operations (
  operation_id text PRIMARY KEY,
  account_id text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  send_revision integer NULL CHECK (send_revision IS NULL OR send_revision >= 0),
  status text NOT NULL CHECK (status IN ('prepared', 'confirmed', 'possible-send', 'applied', 'rejected', 'expired')),
  draft jsonb NOT NULL,
  request jsonb NULL,
  fingerprint text NULL,
  rejection_code text NULL CHECK (rejection_code IS NULL OR rejection_code IN ('duplicate-operation', 'invalid-line',
    'invalid-product', 'product-not-found', 'product-retired', 'catalog-unavailable', 'line-not-found',
    'line-limit-reached', 'quantity-limit-exceeded', 'list-archived')),
  add_command_id text NOT NULL,
  line_id text NOT NULL,
  intent_id text NULL UNIQUE,
  intent_revision integer NULL,
  created_at timestamptz NOT NULL,
  terminal_at timestamptz NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (account_id, add_command_id)
);
CREATE INDEX IF NOT EXISTS collections_saved_list_operations_account_page_idx
  ON collections_saved_list_operations (account_id, created_at, operation_id);
CREATE INDEX IF NOT EXISTS collections_saved_list_operations_account_pending_idx
  ON collections_saved_list_operations (account_id, status, created_at, operation_id);
CREATE INDEX IF NOT EXISTS collections_saved_list_operations_expiry_idx
  ON collections_saved_list_operations (expires_at, status, operation_id);`;

export const savedListRecoveryMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261013_collections_saved_list_operations",
    description: "Reserve canonical account-bound Saved List work without retiring compatible anonymous writers.",
    statements: [savedListRecoverySchemaSql],
  },
];
