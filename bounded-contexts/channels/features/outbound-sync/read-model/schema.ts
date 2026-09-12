import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const createOutboundOperationsTable = `CREATE TABLE IF NOT EXISTS channel_outbound_operations (
  operation_id text PRIMARY KEY,
  connection_id text NOT NULL,
  channel_listing_id text NOT NULL,
  listing_id text NOT NULL,
  operation_kind text NOT NULL CHECK (operation_kind IN ('publish', 'update', 'delist')),
  operation_origin text NOT NULL DEFAULT 'desired-state'
    CHECK (operation_origin IN ('desired-state', 'repush', 'reconciliation-repair')),
  listing_revision bigint NOT NULL CHECK (listing_revision >= 1),
  source_desired_state_sequence bigint NOT NULL CHECK (source_desired_state_sequence >= 1),
  payload jsonb NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'in-flight', 'succeeded', 'failed')),
  revision bigint NOT NULL CHECK (revision >= 1),
  attempt_id text NULL,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  claimant_kind text NULL CHECK (claimant_kind IS NULL OR claimant_kind IN ('inline', 'connector', 'manual')),
  claim_owner_id text NULL,
  reservation_id text NULL,
  claimed_until timestamptz NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL,
  last_rejection_code text NULL,
  terminal_reason text NULL,
  link_write_state text NOT NULL DEFAULT 'pending' CHECK (link_write_state IN ('pending', 'applied', 'link-write-refused')),
  source_event_id text NOT NULL,
  source_stream_id text NOT NULL,
  source_stream_version bigint NOT NULL CHECK (source_stream_version >= 1),
  source_global_position bigint NOT NULL CHECK (source_global_position >= 0),
  source_desired_state_hash text NOT NULL CHECK (source_desired_state_hash ~ '^[a-f0-9]{64}$'),
  source_occurred_at timestamptz NOT NULL,
  enqueued_at timestamptz NOT NULL,
  first_claimed_at timestamptz NULL,
  terminal_at timestamptz NULL,
  CHECK (
    (status = 'in-flight' AND attempt_id IS NOT NULL AND claimant_kind IS NOT NULL AND claim_owner_id IS NOT NULL AND claimed_until IS NOT NULL)
    OR status <> 'in-flight'
  ),
  CHECK (
    status <> 'in-flight'
    OR (claimant_kind = 'inline' AND reservation_id IS NULL)
    OR (claimant_kind IN ('connector', 'manual') AND reservation_id IS NOT NULL)
  ),
  CHECK (source_stream_version = source_desired_state_sequence),
  CHECK ((status IN ('succeeded', 'failed') AND terminal_at IS NOT NULL) OR status NOT IN ('succeeded', 'failed'))
)`;

const createProviderRateStateTable = `CREATE TABLE IF NOT EXISTS channel_provider_rate_state (
  provider_key text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  adaptive_divisor integer NOT NULL DEFAULT 1 CHECK (adaptive_divisor BETWEEN 1 AND 64),
  throttled_until timestamptz NULL,
  consecutive_successes integer NOT NULL DEFAULT 0 CHECK (consecutive_successes >= 0),
  last_rate_limit_at timestamptz NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  PRIMARY KEY (provider_key, environment)
)`;

const createReservationSettlementsTable = `CREATE TABLE IF NOT EXISTS channel_outbound_reservation_settlements (
  reservation_id text PRIMARY KEY,
  claimant jsonb NOT NULL,
  outcomes jsonb NOT NULL,
  run_settlement jsonb NULL,
  settled_at timestamptz NOT NULL
)`;

const createOutboundLanesTable = `CREATE TABLE IF NOT EXISTS channel_outbound_lanes (
  connection_id text NOT NULL,
  channel_listing_id text NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),
  blocked_operation_id text NULL,
  blocked_reason text NULL,
  blocked_at timestamptz NULL,
  cleared_at timestamptz NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  PRIMARY KEY (connection_id, channel_listing_id),
  CHECK (
    (blocked_operation_id IS NULL AND blocked_reason IS NULL AND blocked_at IS NULL)
    OR (blocked_operation_id IS NOT NULL AND blocked_reason IS NOT NULL AND blocked_at IS NOT NULL)
  )
)`;

const createOutboundIndexes = [
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_outbound_operations_source_event_uidx
  ON channel_outbound_operations (source_event_id) WHERE operation_origin = 'desired-state'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_outbound_operations_one_pending_per_lane_uidx
  ON channel_outbound_operations (connection_id, channel_listing_id)
  WHERE status = 'pending' AND operation_origin = 'desired-state'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_outbound_operations_one_inflight_per_lane_uidx
  ON channel_outbound_operations (connection_id, channel_listing_id)
  WHERE status = 'in-flight'`,
  `CREATE INDEX IF NOT EXISTS channel_outbound_operations_claim_idx
  ON channel_outbound_operations (next_attempt_at, enqueued_at, operation_id)
  WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS channel_outbound_operations_connection_claim_idx
  ON channel_outbound_operations (connection_id, enqueued_at, operation_id)
  WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS channel_outbound_operations_connection_log_idx
  ON channel_outbound_operations (connection_id, enqueued_at DESC, operation_id DESC)`,
  `CREATE INDEX IF NOT EXISTS channel_outbound_operations_expiry_idx
  ON channel_outbound_operations (claimed_until, reservation_id)
  WHERE status = 'in-flight' AND claimant_kind IN ('connector', 'manual')`,
  `CREATE INDEX IF NOT EXISTS channel_outbound_operations_inline_expiry_idx
  ON channel_outbound_operations (claimed_until, operation_id)
  WHERE status = 'in-flight' AND claimant_kind = 'inline'`,
] as const;

const pendingLaneOrderIndexDefinition = `channel_outbound_operations_pending_lane_order_idx
  ON channel_outbound_operations (connection_id, channel_listing_id, enqueued_at,
    (CASE operation_origin WHEN 'reconciliation-repair' THEN 1 ELSE 0 END), operation_id)
  WHERE status = 'pending'`;
const createPendingLaneOrderIndex = `CREATE INDEX IF NOT EXISTS ${pendingLaneOrderIndexDefinition}`;

export const outboundSyncSchemaSql = `
${createOutboundOperationsTable};
${createReservationSettlementsTable};
${createProviderRateStateTable};
${createOutboundLanesTable};
${createOutboundIndexes.map((statement) => `${statement};`).join("\n")}
${createPendingLaneOrderIndex};
`;

export const outboundSyncSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260907_channels_outbound_sync",
    description: "Create durable latest-state outbound operations, lane isolation, and provider rate state.",
    statements: [
      createOutboundOperationsTable,
      createProviderRateStateTable,
      createOutboundLanesTable,
      ...createOutboundIndexes,
    ],
  },
  {
    migrationId: "20260910_channels_outbound_reservation_settlements",
    description: "Create durable claimed-reservation settlement receipts.",
    statements: [createReservationSettlementsTable],
  },
  {
    migrationId: "20260912_channels_reconciliation_repair_origin",
    description:
      "Give reconciliation repairs a distinct durable queue identity without weakening desired-event idempotency.",
    statements: [
      "SET LOCAL lock_timeout = '5s'",
      `ALTER TABLE channel_outbound_operations
       ADD COLUMN IF NOT EXISTS operation_origin text NOT NULL DEFAULT 'desired-state'`,
      `DO $migration$
       BEGIN
         IF NOT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conname = 'channel_outbound_operations_operation_origin_check'
             AND conrelid = 'channel_outbound_operations'::regclass
         ) THEN
           ALTER TABLE channel_outbound_operations
             ADD CONSTRAINT channel_outbound_operations_operation_origin_check
             CHECK (operation_origin IN ('desired-state', 'repush', 'reconciliation-repair')) NOT VALID;
         END IF;
       END
       $migration$`,
      `ALTER TABLE channel_outbound_operations
       VALIDATE CONSTRAINT channel_outbound_operations_operation_origin_check`,
      "DROP INDEX CONCURRENTLY IF EXISTS channel_outbound_operations_source_event_uidx",
      "DROP INDEX CONCURRENTLY IF EXISTS channel_outbound_operations_one_pending_per_lane_uidx",
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS channel_outbound_operations_source_event_uidx
       ON channel_outbound_operations (source_event_id) WHERE operation_origin = 'desired-state'`,
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS channel_outbound_operations_one_pending_per_lane_uidx
       ON channel_outbound_operations (connection_id, channel_listing_id)
       WHERE status = 'pending' AND operation_origin = 'desired-state'`,
    ],
  },
  {
    migrationId: "20260912_channels_outbound_pending_lane_order",
    description: "Index pending operations across every origin in their per-lane execution order.",
    statements: [`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${pendingLaneOrderIndexDefinition}`],
  },
];
