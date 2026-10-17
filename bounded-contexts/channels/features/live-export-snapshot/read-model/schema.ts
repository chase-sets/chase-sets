import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const createChannelLiveExportConsumerSql = `CREATE TABLE IF NOT EXISTS channel_live_export_consumer (
  connection_id text PRIMARY KEY,
  cursor text NULL,
  owner text NULL,
  lease_until timestamptz NULL,
  revision bigint NOT NULL DEFAULT 0,
  last_scanned_at timestamptz NOT NULL DEFAULT '1970-01-01'
)`;

export const liveExportSnapshotSchemaSql = `${createChannelLiveExportConsumerSql};`;
export const liveExportSnapshotSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261010_channels_live_export_consumer",
    description: "Create the admitted live-export consumer checkpoint and lease.",
    statements: [createChannelLiveExportConsumerSql],
  },
];
