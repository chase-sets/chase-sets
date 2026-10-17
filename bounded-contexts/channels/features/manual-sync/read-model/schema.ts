import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const createManualSyncClampStatusSql = `CREATE TABLE IF NOT EXISTS channels_manual_sync_clamp_status (
  run_id text PRIMARY KEY,
  connection_id text NOT NULL,
  account_id text NOT NULL,
  run_revision bigint NOT NULL CHECK (run_revision >= 0),
  state text NOT NULL CHECK (state IN ('engaged','recovery','released')),
  requested_listing_count integer NOT NULL CHECK (requested_listing_count >= 0),
  affected_listing_count integer NOT NULL CHECK (affected_listing_count >= 0),
  updated_at timestamptz NOT NULL
)`;

export const manualSyncSchemaSql = `
${createManualSyncClampStatusSql};
CREATE INDEX IF NOT EXISTS channels_manual_sync_clamp_attention_idx
  ON channels_manual_sync_clamp_status (account_id, state, updated_at, connection_id);
`;

export const manualSyncSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260910_channels_manual_sync_clamp_status",
    description: "Record the Marketplace clamp result that drives the Manual Sync Panel and channel attention.",
    statements: [
      createManualSyncClampStatusSql,
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS channels_manual_sync_clamp_attention_idx ON channels_manual_sync_clamp_status (account_id, state, updated_at, connection_id);",
    ],
  },
];
