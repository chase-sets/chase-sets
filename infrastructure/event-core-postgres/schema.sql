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
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  performed_by_user_id text NOT NULL,
  for_account_id text NOT NULL,
  correlation_id text NULL,
  causation_id text NULL,
  command_id text NULL,
  CONSTRAINT event_store_events_stream_version_uk UNIQUE (
    stream_id,
    stream_version
  ),
  CONSTRAINT event_store_events_stream_fk
    FOREIGN KEY (stream_id)
    REFERENCES event_store_streams (stream_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS event_store_events_stream_idx
  ON event_store_events (stream_id, stream_version ASC);

CREATE INDEX IF NOT EXISTS event_store_events_global_idx
  ON event_store_events (global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_tenant_global_idx
  ON event_store_events (tenant_id, global_position ASC);

CREATE INDEX IF NOT EXISTS event_store_events_type_idx
  ON event_store_events (event_type);

CREATE TABLE IF NOT EXISTS event_projection_checkpoints (
  projector_name text PRIMARY KEY,
  last_global_position bigint NOT NULL CHECK (last_global_position >= 0),
  updated_at timestamptz NOT NULL
);
