import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const settlementSupportSourceSchemaSql = `
CREATE TABLE IF NOT EXISTS settlement_support_holds (
  support_request_id text PRIMARY KEY,
  hold_id text NOT NULL,
  order_id text NOT NULL,
  buyer_account_id text NOT NULL,
  seller_account_id text NOT NULL,
  flow_type text NOT NULL,
  status text NOT NULL,
  resolution_type text NULL,
  active boolean NOT NULL,
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  released_at timestamptz NULL,
  release_reason text NULL,
  last_stream_version integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS settlement_support_holds_seller_active_idx
  ON settlement_support_holds (seller_account_id, active, updated_at DESC);

CREATE INDEX IF NOT EXISTS settlement_support_holds_order_active_idx
  ON settlement_support_holds (order_id, active, updated_at DESC);
`;

export const settlementSupportSourceSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260718_settlement_support_holds_hold_id_convergence",
    description: "Converge support holds on their stable Hold identity outside boot-time schema SQL.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE settlement_support_holds ADD COLUMN IF NOT EXISTS hold_id text NULL",
      `UPDATE settlement_support_holds
SET hold_id = 'hold_' || regexp_replace(support_request_id, '^sup_', '')
WHERE hold_id IS NULL`,
      "ALTER TABLE settlement_support_holds DROP CONSTRAINT IF EXISTS settlement_support_holds_hold_id_not_null",
      `ALTER TABLE settlement_support_holds
  ADD CONSTRAINT settlement_support_holds_hold_id_not_null CHECK (hold_id IS NOT NULL) NOT VALID`,
      "ALTER TABLE settlement_support_holds VALIDATE CONSTRAINT settlement_support_holds_hold_id_not_null",
      "ALTER TABLE settlement_support_holds ALTER COLUMN hold_id SET NOT NULL",
      "ALTER TABLE settlement_support_holds DROP CONSTRAINT IF EXISTS settlement_support_holds_hold_id_not_null",
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS settlement_support_holds_hold_id_idx
  ON settlement_support_holds (hold_id)`,
    ],
  },
];
