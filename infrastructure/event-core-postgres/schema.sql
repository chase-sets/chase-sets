CREATE TABLE IF NOT EXISTS event_store_streams (
  stream_id text PRIMARY KEY,
  current_version bigint NOT NULL CHECK (current_version >= 0),
  updated_at timestamptz NOT NULL
);

-- configuration-epoch-schema:start
CREATE TABLE IF NOT EXISTS event_configuration_store_identity (
  singleton boolean PRIMARY KEY CHECK (singleton),
  store_id text NOT NULL,
  incarnation text NOT NULL
);

-- These heads are canonical journal anchors, not projections or snapshots.
CREATE TABLE IF NOT EXISTS event_configuration_journal_heads (
  role text NOT NULL CHECK (role IN ('source', 'consumer')),
  key text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  digest text NOT NULL CHECK (length(digest) = 64),
  PRIMARY KEY (role, key)
);

CREATE TABLE IF NOT EXISTS event_configuration_guard_history (
  role text NOT NULL CHECK (role IN ('source', 'consumer')),
  key text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  record json NOT NULL,
  digest text NOT NULL CHECK (length(digest) = 64),
  PRIMARY KEY (role, key, sequence)
);
-- configuration-epoch-schema:end

-- owner-stream-reservation-schema:start
CREATE TABLE IF NOT EXISTS event_owner_stream_reservations (
  reservation_id text PRIMARY KEY,
  operation_id text NOT NULL,
  owner_stream_id text NOT NULL,
  purpose text NOT NULL,
  resource_key text NOT NULL,
  consumer_store_id text NOT NULL,
  consumer_incarnation text NOT NULL,
  request_id text NOT NULL,
  seal_version bigint NOT NULL CHECK (seal_version >= 0),
  store_incarnation text NOT NULL,
  target jsonb NOT NULL,
  command_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'RELEASED')),
  release_status text NULL CHECK (release_status IS NULL OR release_status IN ('COMMITTED', 'ABORTED')),
  created_at timestamptz NOT NULL,
  released_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS event_owner_stream_reservations_resource_open_idx
  ON event_owner_stream_reservations (resource_key, status)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS event_owner_stream_reservations_owner_open_idx
  ON event_owner_stream_reservations (owner_stream_id, status)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS event_owner_stream_reservations_operation_open_idx
  ON event_owner_stream_reservations (operation_id, purpose, resource_key)
  WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS event_owner_stream_invalidations (
  owner_stream_id text PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation >= 1),
  status text NOT NULL CHECK (status IN ('PENDING', 'ABORT-REQUESTED', 'APPLIED')),
  affected_reservation_ids text[] NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS event_request_terminals (
  consumer_store_id text NOT NULL,
  request_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'COMMITTED', 'ABORTED')),
  binding jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (consumer_store_id, request_id)
);

CREATE TABLE IF NOT EXISTS event_owner_stream_inbound_evidence (
  evidence_id text PRIMARY KEY,
  resource_key text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'BLOCKED', 'APPLIED')),
  recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS event_owner_stream_inbound_evidence_resource_idx
  ON event_owner_stream_inbound_evidence (resource_key, status);
-- owner-stream-reservation-schema:end

CREATE TABLE IF NOT EXISTS event_store_events (
  global_position bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  stream_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  tenant_id text NOT NULL,
  stream_context_name text NOT NULL,
  stream_category text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  performed_by_user_id text NOT NULL,
  for_account_id text NOT NULL,
  trace_id text NULL,
  span_id text NULL,
  parent_span_id text NULL,
  trace_state text NULL,
  CONSTRAINT event_store_events_stream_version_uk UNIQUE (
    stream_id,
    stream_version
  ),
  CONSTRAINT event_store_events_stream_fk
    FOREIGN KEY (stream_id)
    REFERENCES event_store_streams (stream_id)
    ON DELETE CASCADE
);

-- Gap-safe catch-up horizons read the sequence's last allocated position after
-- fencing concurrent append transactions. CACHE 1 is part of that invariant:
-- a larger cache could issue a future position below the captured last_value.
ALTER SEQUENCE event_store_events_global_position_seq CACHE 1;

ALTER TABLE event_store_events
  ADD COLUMN IF NOT EXISTS stream_context_name text NULL,
  ADD COLUMN IF NOT EXISTS stream_category text NULL,
  ADD COLUMN IF NOT EXISTS trace_id text NULL,
  ADD COLUMN IF NOT EXISTS span_id text NULL,
  ADD COLUMN IF NOT EXISTS parent_span_id text NULL,
  ADD COLUMN IF NOT EXISTS trace_state text NULL,
  DROP COLUMN IF EXISTS correlation_id,
  DROP COLUMN IF EXISTS causation_id,
  DROP COLUMN IF EXISTS command_id;

CREATE INDEX IF NOT EXISTS event_store_events_stream_idx
  ON event_store_events (stream_id, stream_version ASC);

CREATE INDEX IF NOT EXISTS event_store_events_global_idx
  ON event_store_events (global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_tenant_global_idx
  ON event_store_events (tenant_id, global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_type_idx
  ON event_store_events (event_type);

CREATE INDEX IF NOT EXISTS event_store_events_type_global_idx
  ON event_store_events (event_type, global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_tenant_type_global_idx
  ON event_store_events (tenant_id, event_type, global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_stream_prefix_global_idx
  ON event_store_events (stream_id text_pattern_ops, global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_context_category_type_global_idx
  ON event_store_events (stream_context_name, stream_category, event_type, global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_context_category_global_idx
  ON event_store_events (stream_context_name, stream_category, global_position ASC);

-- Load-time cache, never a source of truth: the event stream
-- above stays canonical, and this table must always be safe to truncate or
-- fully rebuild from events. `schema_version` lets the aggregate repository
-- detect a stale snapshot after an evolver change and fall back to full
-- replay instead of misapplying it. See contracts/event-core/README.md.
CREATE TABLE IF NOT EXISTS event_store_aggregate_snapshots (
  stream_id text PRIMARY KEY,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT event_store_aggregate_snapshots_stream_fk
    FOREIGN KEY (stream_id)
    REFERENCES event_store_streams (stream_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_projection_checkpoints (
  projector_name text PRIMARY KEY,
  last_global_position bigint NOT NULL CHECK (last_global_position >= 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS event_projection_measure_publication_parts (
  checkpoint_key text NOT NULL,
  stream_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  payload jsonb NOT NULL,
  PRIMARY KEY (checkpoint_key, stream_id, stream_version)
);

CREATE INDEX IF NOT EXISTS event_projection_measure_publication_parts_checkpoint_idx
  ON event_projection_measure_publication_parts (checkpoint_key);

CREATE UNLOGGED TABLE IF NOT EXISTS event_projection_recovery_markers (
  projection_kind text NOT NULL CHECK (projection_kind IN ('projector', 'subscription')),
  projection_key text NOT NULL,
  last_global_position bigint NOT NULL CHECK (last_global_position >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (projection_kind, projection_key)
);

CREATE TABLE IF NOT EXISTS event_projection_poison_events (
  projection_key text NOT NULL,
  event_id text NOT NULL,
  projection_name text NOT NULL,
  projection_kind text NOT NULL CHECK (projection_kind IN ('projector', 'subscription')),
  target_context_name text NULL,
  source_context_name text NULL,
  projection_revision integer NULL CHECK (projection_revision IS NULL OR projection_revision >= 1),
  subscription_version integer NULL CHECK (subscription_version IS NULL OR subscription_version >= 1),
  stream_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  event_type text NOT NULL,
  global_position bigint NOT NULL CHECK (global_position >= 0),
  failure_kind text NOT NULL CHECK (failure_kind IN ('poison', 'transient')),
  error_message text NOT NULL,
  error_stack text NULL,
  state text NOT NULL CHECK (state IN ('blocked', 'retrying', 'resolved', 'ignored')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  resolved_at timestamptz NULL,
  PRIMARY KEY (projection_key, event_id)
);

CREATE INDEX IF NOT EXISTS event_projection_poison_events_active_idx
  ON event_projection_poison_events (projection_key, state, global_position)
  WHERE state IN ('blocked', 'retrying');

CREATE TABLE IF NOT EXISTS event_projection_blocked_streams (
  projection_key text NOT NULL,
  stream_id text NOT NULL,
  first_blocked_global_position bigint NOT NULL CHECK (first_blocked_global_position >= 0),
  first_blocked_stream_version bigint NOT NULL CHECK (first_blocked_stream_version > 0),
  last_seen_global_position bigint NOT NULL CHECK (last_seen_global_position >= 0),
  deferred_event_count integer NOT NULL DEFAULT 0 CHECK (deferred_event_count >= 0),
  state text NOT NULL CHECK (state IN ('blocked', 'retrying', 'resolved')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (projection_key, stream_id)
);

CREATE INDEX IF NOT EXISTS event_projection_blocked_streams_active_idx
  ON event_projection_blocked_streams (projection_key, state, first_blocked_global_position)
  WHERE state IN ('blocked', 'retrying');

-- Ledgered migrations: one-time reshapes below are removed from additive boot SQL
-- and applied once by infrastructure/bounded-context-runtime/schema.ts.

-- 20260710_event_store_write_hot_fillfactor
SET lock_timeout = '5s';

ALTER TABLE event_store_streams
  SET (fillfactor = 90);

ALTER TABLE event_projection_checkpoints
  SET (fillfactor = 90);
