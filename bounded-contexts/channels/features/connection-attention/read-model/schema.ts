import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const table = `CREATE TABLE IF NOT EXISTS channel_connection_attention (
  connection_id text NOT NULL,
  account_id text NOT NULL,
  reason_code text NOT NULL,
  reason_generation bigint NOT NULL CHECK (reason_generation > 0),
  fingerprint text NOT NULL,
  opened_at timestamptz NOT NULL,
  resolved_at timestamptz NULL,
  resolution_reason text NULL CHECK (resolution_reason IN ('handled-on-channel','reconnected','reselected-setup','recovered-automatically','inventory-adjusted-separately','no-action-required')),
  CHECK ((resolved_at IS NULL) = (resolution_reason IS NULL)),
  PRIMARY KEY (connection_id, reason_code, reason_generation)
)`;
const index =
  "CREATE INDEX IF NOT EXISTS channel_connection_attention_account_idx ON channel_connection_attention (account_id, opened_at, connection_id) WHERE resolved_at IS NULL";
const healthAccountIndex =
  "CREATE INDEX IF NOT EXISTS channel_connection_health_account_attention_idx ON channel_connection_health (account_id, connection_id)";
export const channelAttentionSchemaSql = `${table};\n${index};\n${healthAccountIndex};`;
export const channelAttentionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260914_channels_connection_attention_v1",
    description: "Retain generation-scoped channel attention and independent resolution.",
    statements: [
      table,
      index.replace("INDEX IF", "INDEX CONCURRENTLY IF"),
      healthAccountIndex.replace("INDEX IF", "INDEX CONCURRENTLY IF"),
    ],
  },
];
