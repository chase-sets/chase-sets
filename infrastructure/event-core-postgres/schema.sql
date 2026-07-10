CREATE TABLE IF NOT EXISTS event_store_streams (
  stream_id text PRIMARY KEY,
  current_version bigint NOT NULL CHECK (current_version >= 0),
  updated_at timestamptz NOT NULL
);

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

CREATE TABLE IF NOT EXISTS event_projection_checkpoints (
  projector_name text PRIMARY KEY,
  last_global_position bigint NOT NULL CHECK (last_global_position >= 0),
  updated_at timestamptz NOT NULL
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
