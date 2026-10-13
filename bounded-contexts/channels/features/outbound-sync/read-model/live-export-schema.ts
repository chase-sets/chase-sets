export const liveExportSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS channel_live_export_operations (
    operation_id text PRIMARY KEY CHECK (operation_id ~ '^cxp_[a-f0-9]{40}$'),
    connection_id text NOT NULL,
    operation_kind text NOT NULL CHECK (operation_kind = 'tcgplayer-live-export'),
    export_id text NOT NULL UNIQUE CHECK (export_id ~ '^cxpl_[a-f0-9]{40}$'),
    schedule_generation bigint NOT NULL CHECK (schedule_generation >= 1),
    payload jsonb NOT NULL,
    payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
    status text NOT NULL CHECK (status IN ('pending', 'in-flight', 'succeeded', 'failed')),
    revision bigint NOT NULL CHECK (revision >= 1),
    attempt_id text NULL,
    claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
    claimant_kind text NULL CHECK (claimant_kind IS NULL OR claimant_kind = 'connector'),
    claim_owner_id text NULL,
    reservation_id text NULL,
    claimed_until timestamptz NULL,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    outcome jsonb NULL,
    enqueued_at timestamptz NOT NULL,
    first_claimed_at timestamptz NULL,
    terminal_at timestamptz NULL,
    UNIQUE (connection_id, schedule_generation),
    CHECK (status <> 'in-flight' OR (attempt_id IS NOT NULL AND claimant_kind IS NOT NULL
      AND claim_owner_id IS NOT NULL AND reservation_id IS NOT NULL AND claimed_until IS NOT NULL)),
    CHECK ((status IN ('succeeded', 'failed')) = (terminal_at IS NOT NULL AND outcome IS NOT NULL))
  )`,
  `CREATE TABLE IF NOT EXISTS channel_live_export_schedules (
    connection_id text PRIMARY KEY,
    generation bigint NOT NULL CHECK (generation >= 1),
    next_due_at timestamptz NOT NULL,
    last_scheduled_at timestamptz NOT NULL,
    revision bigint NOT NULL CHECK (revision >= 1),
    updated_at timestamptz NOT NULL,
    CHECK (next_due_at > last_scheduled_at)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS channel_live_export_operations_one_live_uidx
    ON channel_live_export_operations (connection_id) WHERE status IN ('pending', 'in-flight')`,
  `CREATE INDEX IF NOT EXISTS channel_live_export_operations_reservation_idx
    ON channel_live_export_operations (reservation_id, operation_id) WHERE status = 'in-flight'`,
  `CREATE INDEX IF NOT EXISTS channel_live_export_operations_expiry_idx
    ON channel_live_export_operations (claimed_until, operation_id) WHERE status = 'in-flight'`,
  `CREATE INDEX IF NOT EXISTS channel_live_export_schedules_due_idx
    ON channel_live_export_schedules (next_due_at, connection_id)`,
] as const;
