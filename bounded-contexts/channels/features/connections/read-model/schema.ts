import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const createChannelConnectionsTableSql = `CREATE TABLE IF NOT EXISTS channel_connections (
  connection_id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_key text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  status text NOT NULL CHECK (status IN ('pending-setup', 'active', 'paused', 'disconnected')),
  created_at text NOT NULL,
  created_at_instant timestamptz NOT NULL,
  credential_reference text NULL,
  bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
  projection_updated_at timestamptz NOT NULL,
  last_stream_version bigint NOT NULL
)`;

export const channelConnectionSchemaSql = `
${createChannelConnectionsTableSql};

CREATE INDEX IF NOT EXISTS channel_connections_account_page_idx
  ON channel_connections (account_id, created_at_instant DESC, connection_id DESC);
`;

export const channelConnectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260905_channels_channel_connections",
    description: "Create the seller-owned Channel Connection projection and its account keyset index.",
    statements: [
      createChannelConnectionsTableSql,
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_connections_account_page_idx ON channel_connections (account_id, created_at_instant DESC, connection_id DESC);",
    ],
  },
];
