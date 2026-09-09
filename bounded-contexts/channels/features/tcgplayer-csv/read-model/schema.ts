import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const createChannelExportSchemaPinsSql = `CREATE TABLE IF NOT EXISTS channel_export_schema_pins (
  connection_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key = 'tcgplayer'),
  surface text NOT NULL CHECK (surface IN ('live', 'staged')),
  header jsonb NOT NULL CHECK (jsonb_typeof(header) = 'array' AND jsonb_array_length(header) > 0),
  condition_column text NOT NULL CHECK (condition_column IN ('present', 'absent')),
  pinned_from_snapshot_id text NOT NULL,
  pinned_at timestamptz NOT NULL,
  PRIMARY KEY (connection_id, provider_key, surface)
)`;

const createChannelInventorySnapshotsSql = `CREATE TABLE IF NOT EXISTS channel_inventory_snapshots (
  snapshot_id text PRIMARY KEY,
  snapshot_generation bigint NOT NULL CHECK (snapshot_generation > 0),
  connection_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key = 'tcgplayer'),
  surface text NOT NULL CHECK (surface IN ('live', 'staged')),
  parsed_row_count integer NOT NULL CHECK (parsed_row_count > 0 AND parsed_row_count <= 1000000),
  completeness text NOT NULL CHECK (completeness = 'unverified'),
  ingested_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  captured_at_source text NOT NULL CHECK (captured_at_source IN ('operator-declared', 'ingest')),
  UNIQUE (connection_id, surface, snapshot_generation),
  UNIQUE (snapshot_id, connection_id, surface, snapshot_generation)
)`;

const createChannelInventorySnapshotRowsSql = `CREATE TABLE IF NOT EXISTS channel_inventory_snapshot_rows (
  snapshot_id text NOT NULL,
  snapshot_generation bigint NOT NULL CHECK (snapshot_generation > 0),
  connection_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key = 'tcgplayer'),
  surface text NOT NULL CHECK (surface IN ('live', 'staged')),
  external_key text NOT NULL,
  condition_text text NULL,
  condition_identity text GENERATED ALWAYS AS (coalesce(condition_text, '')) STORED,
  total_quantity integer NOT NULL CHECK (total_quantity BETWEEN 0 AND 1000000),
  pending_quantity_delta integer NOT NULL CHECK (pending_quantity_delta BETWEEN -1000000 AND 1000000),
  price_amount_text text NOT NULL,
  price_amount_minor bigint NULL CHECK (price_amount_minor IS NULL OR price_amount_minor BETWEEN 0 AND 9007199254740991),
  currency text NOT NULL CHECK (currency = 'USD'),
  reference_columns jsonb NOT NULL CHECK (jsonb_typeof(reference_columns) = 'object'),
  row_number integer NOT NULL CHECK (row_number >= 2),
  ingested_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  captured_at_source text NOT NULL CHECK (captured_at_source IN ('operator-declared', 'ingest')),
  PRIMARY KEY (snapshot_id, external_key, condition_identity),
  FOREIGN KEY (snapshot_id, connection_id, surface, snapshot_generation)
    REFERENCES channel_inventory_snapshots (snapshot_id, connection_id, surface, snapshot_generation) ON DELETE RESTRICT
)`;

const createChannelSyncRunsSql = `CREATE TABLE IF NOT EXISTS channel_sync_runs (
  run_id text PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision >= 0),
  sequence bigint NOT NULL CHECK (sequence > 0),
  connection_id text NOT NULL,
  provider_key text NOT NULL CHECK (provider_key = 'tcgplayer'),
  reservation_id text NOT NULL UNIQUE,
  claimant_kind text NOT NULL CHECK (claimant_kind IN ('connector', 'manual')),
  claimant_id text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  manual_claim_lease_policy_snapshot jsonb NULL,
  state text NOT NULL CHECK (state IN ('composed','claimed','awaiting-verification','applied','validation-rejected','application-unknown','superseded','stale-basis','abandoned')),
  basis_snapshot_id text NOT NULL,
  basis_snapshot_generation bigint NOT NULL CHECK (basis_snapshot_generation > 0),
  verification_snapshot_id text NULL,
  verification_snapshot_generation bigint NULL,
  upload_attempted_at timestamptz NULL,
  upload_file_name text NULL,
  import_summary jsonb NULL,
  csv_header jsonb NOT NULL CHECK (jsonb_typeof(csv_header) = 'array'),
  member_count integer NOT NULL CHECK (member_count > 0 AND member_count <= 1000000),
  member_digest text NOT NULL CHECK (member_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((claimant_kind = 'manual') = (manual_claim_lease_policy_snapshot IS NOT NULL)),
  CHECK ((verification_snapshot_id IS NULL) = (verification_snapshot_generation IS NULL)),
  CHECK ((upload_attempted_at IS NULL) = (upload_file_name IS NULL)),
  CHECK (import_summary IS NULL OR state IN ('applied','application-unknown')),
  CHECK ((state = 'awaiting-verification' OR state = 'applied' OR state = 'application-unknown') OR upload_attempted_at IS NULL)
)`;

const createChannelSyncRunRowsSql = `CREATE TABLE IF NOT EXISTS channel_sync_run_rows (
  run_id text NOT NULL REFERENCES channel_sync_runs (run_id) ON DELETE RESTRICT,
  operation_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  reservation_id text NOT NULL,
  attempt_id text NOT NULL,
  claim_generation bigint NOT NULL CHECK (claim_generation > 0),
  channel_listing_id text NOT NULL,
  listing_id text NOT NULL,
  desired_state_sequence bigint NOT NULL CHECK (desired_state_sequence >= 0),
  listing_revision bigint NOT NULL CHECK (listing_revision >= 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  member_kind text NOT NULL CHECK (member_kind IN ('composed','already-satisfied','refused')),
  external_key text NULL,
  condition_text text NULL,
  basis_snapshot_id text NULL,
  basis_snapshot_generation bigint NULL,
  basis_total_quantity integer NULL,
  basis_price_amount_minor bigint NULL,
  target_quantity integer NULL,
  target_price_amount_minor bigint NULL,
  csv_row_json jsonb NULL,
  refusal_reason text NULL,
  mapping_dimension text NULL CHECK (mapping_dimension IS NULL OR mapping_dimension IN ('category','condition','attribute')),
  mapping_source_key text NULL,
  provider_action text NULL CHECK (provider_action IS NULL OR provider_action = 'not-attempted-already-satisfied'),
  PRIMARY KEY (run_id, operation_id),
  UNIQUE (run_id, ordinal),
  CHECK ((mapping_dimension IS NULL) = (mapping_source_key IS NULL)),
  CHECK (
    (member_kind = 'composed' AND external_key IS NOT NULL AND basis_snapshot_id IS NOT NULL AND basis_snapshot_generation IS NOT NULL
      AND basis_total_quantity IS NOT NULL AND basis_price_amount_minor IS NOT NULL AND target_quantity IS NOT NULL
      AND target_price_amount_minor IS NOT NULL AND csv_row_json IS NOT NULL AND refusal_reason IS NULL AND provider_action IS NULL)
    OR
    (member_kind = 'already-satisfied' AND external_key IS NOT NULL AND basis_snapshot_id IS NOT NULL AND basis_snapshot_generation IS NOT NULL
      AND basis_total_quantity = target_quantity AND basis_price_amount_minor = target_price_amount_minor
      AND csv_row_json IS NULL AND refusal_reason IS NULL AND provider_action = 'not-attempted-already-satisfied')
    OR
    (member_kind = 'refused' AND csv_row_json IS NULL AND refusal_reason IS NOT NULL AND provider_action IS NULL)
  )
)`;

export const tcgplayerCsvSchemaSql = `
${createChannelExportSchemaPinsSql};
${createChannelInventorySnapshotsSql};
${createChannelInventorySnapshotRowsSql};
${createChannelSyncRunsSql};
${createChannelSyncRunRowsSql};

CREATE INDEX IF NOT EXISTS channel_inventory_snapshot_rows_latest_idx
  ON channel_inventory_snapshot_rows (connection_id, surface, snapshot_generation DESC, snapshot_id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS channel_sync_runs_one_non_terminal_per_connection_idx
  ON channel_sync_runs (connection_id)
  WHERE state IN ('composed','claimed','awaiting-verification');
`;

export const tcgplayerCsvSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260909_channels_tcgplayer_csv",
    description: "Create TCGplayer schema pins, inventory snapshots, Channel Sync Runs, and immutable run members.",
    statements: [
      createChannelExportSchemaPinsSql,
      createChannelInventorySnapshotsSql,
      createChannelInventorySnapshotRowsSql,
      createChannelSyncRunsSql,
      createChannelSyncRunRowsSql,
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_inventory_snapshot_rows_latest_idx ON channel_inventory_snapshot_rows (connection_id, surface, snapshot_generation DESC, snapshot_id DESC);",
      "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS channel_sync_runs_one_non_terminal_per_connection_idx ON channel_sync_runs (connection_id) WHERE state IN ('composed','claimed','awaiting-verification');",
    ],
  },
];
