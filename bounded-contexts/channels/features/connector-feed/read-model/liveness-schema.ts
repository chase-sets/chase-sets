import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const statements = [
  `CREATE TABLE IF NOT EXISTS channel_connector_liveness_authority (
    connection_id text PRIMARY KEY,
    authority_generation bigint NOT NULL CHECK (authority_generation BETWEEN 1 AND 9007199254740991),
    live_pairing_id text,
    heartbeat_revision bigint NOT NULL CHECK (heartbeat_revision BETWEEN 0 AND 9007199254740991),
    last_seen_at timestamptz,
    served_poll_window_seconds integer CHECK (served_poll_window_seconds BETWEEN 1 AND 3600),
    served_policy_identity text CHECK (served_policy_identity ~ '^[0-9a-f]{64}$'),
    heartbeat_due_at timestamptz,
    CHECK (num_nonnulls(last_seen_at, served_poll_window_seconds, served_policy_identity, heartbeat_due_at) IN (0,4)),
    CHECK (live_pairing_id IS NOT NULL OR last_seen_at IS NULL),
    CHECK (last_seen_at IS NULL OR heartbeat_revision > 0),
    CHECK (heartbeat_due_at = last_seen_at + served_poll_window_seconds * interval '1 second')
  )`,
  `CREATE INDEX IF NOT EXISTS channel_connector_liveness_due_idx
    ON channel_connector_liveness_authority (heartbeat_due_at, connection_id) WHERE live_pairing_id IS NOT NULL`,
  `INSERT INTO channel_connector_liveness_authority
    (connection_id, authority_generation, live_pairing_id, heartbeat_revision)
    SELECT DISTINCT ON (connection_id) connection_id, 1,
      CASE WHEN state <> 'closed' THEN pairing_id ELSE NULL END, 0
    FROM channel_connector_pairings ORDER BY connection_id, created_sequence DESC
    ON CONFLICT (connection_id) DO NOTHING`,
] as const;

export const connectorLivenessSchemaSql = statements.join(";\n") + ";";
export const connectorLivenessSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261008_channels_connector_liveness_authority",
    description: "Lockable admitted connector heartbeat and policy snapshot, including pre-existing pairings.",
    statements,
  },
];
