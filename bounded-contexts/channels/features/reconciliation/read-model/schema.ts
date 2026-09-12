import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const tables = [
  `CREATE TABLE IF NOT EXISTS channel_reconciliation_state (
    connection_id text PRIMARY KEY, account_id text NOT NULL, provider_key text NOT NULL,
    environment text NOT NULL CHECK (environment IN ('sandbox','production')),
    state text NOT NULL CHECK (state IN ('idle','due','running','completed','bounded-unknown','held')),
    generation bigint NOT NULL CHECK (generation >= 0), revision bigint NOT NULL CHECK (revision >= 1),
    run_fingerprint text NULL CHECK (run_fingerprint IS NULL OR run_fingerprint ~ '^[a-f0-9]{64}$'),
    cadence_policy_revision bigint NOT NULL CHECK (cadence_policy_revision >= 0),
    next_due_at timestamptz NOT NULL, last_clean_run_at timestamptz NULL,
    counts jsonb NOT NULL, updated_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channel_drift_decisions (
    connection_id text NOT NULL, channel_listing_id text NOT NULL,
    revision bigint NOT NULL CHECK (revision >= 0), accepted_observed_fingerprint text NULL,
    accepted_expected_material_fingerprint text NULL, accepted_at_run_generation bigint NULL,
    repush_requested boolean NOT NULL DEFAULT false, last_operation_id text NULL, updated_at timestamptz NOT NULL,
    PRIMARY KEY (connection_id, channel_listing_id),
    CHECK ((accepted_observed_fingerprint IS NULL) = (accepted_expected_material_fingerprint IS NULL)),
    CHECK ((accepted_observed_fingerprint IS NULL) = (accepted_at_run_generation IS NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS channel_drift_decision_operations (
    operation_id text PRIMARY KEY, connection_id text NOT NULL, channel_listing_id text NOT NULL,
    command_kind text NOT NULL CHECK (command_kind IN ('accept','repush')),
    command_fingerprint text NOT NULL CHECK (command_fingerprint ~ '^[a-f0-9]{64}$'),
    resulting_revision bigint NOT NULL CHECK (resulting_revision >= 1), recorded_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channel_reconciliation_items (
    connection_id text NOT NULL, channel_listing_id text NOT NULL, listing_id text NOT NULL,
    run_generation bigint NOT NULL CHECK (run_generation >= 1),
    classification text NOT NULL CHECK (classification IN ('in-sync','repairable','foreign-edit','structural','source-unavailable')),
    observed_fingerprint text NULL, expected_material_fingerprint text NOT NULL,
    settled boolean NOT NULL, updated_at timestamptz NOT NULL, revision bigint NOT NULL CHECK (revision >= 1),
    PRIMARY KEY (connection_id, channel_listing_id)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_missed_sale_gaps (
    connection_id text NOT NULL, sale_key_fingerprint text NOT NULL CHECK (sale_key_fingerprint ~ '^[a-f0-9]{64}$'),
    first_seen_generation bigint NOT NULL CHECK (first_seen_generation >= 1),
    last_seen_generation bigint NOT NULL CHECK (last_seen_generation >= first_seen_generation),
    open boolean NOT NULL, safe_reason text NULL, updated_at timestamptz NOT NULL, revision bigint NOT NULL CHECK (revision >= 1),
    PRIMARY KEY (connection_id, sale_key_fingerprint)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_reconciliation_findings (
    connection_id text NOT NULL, finding_id text NOT NULL, run_generation bigint NOT NULL CHECK (run_generation >= 1),
    kind text NOT NULL CHECK (kind IN ('unmappable-sale','backdated-sale','unmapped-channel-state','persistent-sale-gap')),
    channel_listing_id text NULL, fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    open boolean NOT NULL, safe_reason text NOT NULL, updated_at timestamptz NOT NULL,
    revision bigint NOT NULL CHECK (revision >= 1), PRIMARY KEY (connection_id,finding_id)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_recorded_sale_receipts (
    connection_id text NOT NULL, sale_key_fingerprint text NOT NULL CHECK (sale_key_fingerprint ~ '^[a-f0-9]{64}$'),
    recorded_at timestamptz NOT NULL, PRIMARY KEY (connection_id, sale_key_fingerprint)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_reconciliation_health_observations (
    source_work_id text NOT NULL, source_attempt integer NOT NULL CHECK (source_attempt >= 1),
    result_ordinal integer NOT NULL CHECK (result_ordinal >= 1), payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL, consumed_at timestamptz NULL,
    PRIMARY KEY (source_work_id, source_attempt, result_ordinal)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_reconciliation_attention_resolutions (
    connection_id text NOT NULL, run_generation bigint NOT NULL CHECK (run_generation >= 1),
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    resolution text NOT NULL CHECK (resolution IN ('handled-on-channel','recovered-automatically')),
    resolved_at timestamptz NOT NULL, PRIMARY KEY (connection_id,run_generation)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_reconciliation_metrics (
    connection_id text NOT NULL, account_id text NOT NULL, run_generation bigint NOT NULL CHECK (run_generation >= 1),
    completed_at timestamptz NOT NULL, run_state text NOT NULL CHECK (run_state IN ('completed','bounded-unknown','held')),
    clean boolean NOT NULL, counts jsonb NOT NULL,
    PRIMARY KEY (connection_id, run_generation)
  )`,
] as const;

const indexes = [
  "CREATE INDEX IF NOT EXISTS channel_reconciliation_due_idx ON channel_reconciliation_state (next_due_at, connection_id) WHERE state IN ('idle','due','completed','bounded-unknown','held')",
  "CREATE INDEX IF NOT EXISTS channel_reconciliation_items_attention_idx ON channel_reconciliation_items (connection_id, run_generation, channel_listing_id) WHERE classification IN ('foreign-edit','structural') AND settled = false",
  "CREATE INDEX IF NOT EXISTS channel_reconciliation_findings_attention_idx ON channel_reconciliation_findings (connection_id,run_generation,finding_id) WHERE open",
  "CREATE INDEX IF NOT EXISTS channel_reconciliation_metrics_window_idx ON channel_reconciliation_metrics (account_id, connection_id, completed_at)",
  "CREATE INDEX IF NOT EXISTS channel_reconciliation_health_pending_idx ON channel_reconciliation_health_observations (occurred_at, source_work_id) WHERE consumed_at IS NULL",
] as const;

const migrationIndexes = indexes.map((statement) => statement.replace("CREATE INDEX ", "CREATE INDEX CONCURRENTLY "));

export const channelReconciliationSchemaSql = `${tables.join(";\n")};\n${indexes.join(";\n")};`;

export const channelReconciliationSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260912_channels_reconciliation",
    description: "Create guarded Channel Reconciliation runs, decisions, gaps, health producer outbox, and metrics.",
    statements: [...tables, ...migrationIndexes],
  },
];

export const channelReconciliationTableNames = [
  "channel_reconciliation_state",
  "channel_drift_decisions",
  "channel_drift_decision_operations",
  "channel_reconciliation_items",
  "channel_missed_sale_gaps",
  "channel_reconciliation_findings",
  "channel_recorded_sale_receipts",
  "channel_reconciliation_health_observations",
  "channel_reconciliation_attention_resolutions",
  "channel_reconciliation_metrics",
] as const;
