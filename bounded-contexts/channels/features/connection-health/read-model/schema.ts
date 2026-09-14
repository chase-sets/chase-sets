import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const tables = [
  `CREATE TABLE IF NOT EXISTS channel_connection_health (
    connection_id text PRIMARY KEY,
    account_id text NOT NULL,
    policy_revision text NOT NULL,
    evaluation_generation bigint NOT NULL CHECK (evaluation_generation > 0),
    state text NOT NULL CHECK (state IN ('unknown', 'healthy', 'degraded', 'failing')),
    reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) <= 8),
    observed_at text NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channel_health_observations (
    source_kind text NOT NULL,
    source_work_id text NOT NULL,
    source_attempt bigint NOT NULL CHECK (source_attempt > 0),
    result_ordinal bigint NOT NULL CHECK (result_ordinal > 0),
    connection_id text NOT NULL,
    reason_code text NOT NULL,
    reason_generation bigint NOT NULL CHECK (reason_generation > 0),
    fingerprint text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
    occurred_at timestamptz NOT NULL,
    observation jsonb NOT NULL,
    PRIMARY KEY (source_kind, source_work_id, source_attempt, result_ordinal)
  )`,
];
const indexes = [
  "CREATE UNIQUE INDEX IF NOT EXISTS channel_health_observations_attempt_outcome_idx ON channel_health_observations (source_kind, source_work_id, source_attempt, outcome)",
  "CREATE INDEX IF NOT EXISTS channel_health_observations_window_idx ON channel_health_observations (connection_id, occurred_at, reason_code, reason_generation)",
  "CREATE INDEX IF NOT EXISTS channel_health_observations_fingerprint_idx ON channel_health_observations (connection_id, reason_code, fingerprint)",
];
export const channelHealthSchemaSql = [...tables, ...indexes].join(";\n") + ";";
export const channelHealthSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260912_channels_connection_health_v1",
    description: "Create connection health and its immutable observation attempt ledger.",
    statements: [...tables, ...indexes.map((sql) => sql.replace("INDEX IF", "INDEX CONCURRENTLY IF"))],
  },
];
