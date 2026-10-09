export const orderPullProgressSchemaStatements = [
  `ALTER TABLE channel_order_pull_schedules ADD COLUMN IF NOT EXISTS checkpoint jsonb NULL`,
  `ALTER TABLE channel_order_pull_schedules ADD COLUMN IF NOT EXISTS checkpoint_digest text NULL`,
  `CREATE TABLE IF NOT EXISTS channel_order_pull_chunks (
    connection_id text NOT NULL,
    burst_id text NOT NULL,
    chunk_id bigint NOT NULL CHECK (chunk_id > 0),
    cursor text NOT NULL,
    original_references jsonb NOT NULL CHECK (jsonb_typeof(original_references) = 'array' AND jsonb_array_length(original_references) <= 1000),
    remaining_references jsonb NOT NULL CHECK (jsonb_typeof(remaining_references) = 'array' AND jsonb_array_length(remaining_references) <= 1000),
    posted_references jsonb NOT NULL CHECK (jsonb_typeof(posted_references) = 'array' AND jsonb_array_length(posted_references) <= 1000),
    revision bigint NOT NULL CHECK (revision > 0),
    PRIMARY KEY (connection_id, burst_id, chunk_id),
    UNIQUE (connection_id, burst_id, cursor)
  )`,
  `CREATE INDEX IF NOT EXISTS channel_order_pull_chunks_pending_idx
    ON channel_order_pull_chunks (connection_id, burst_id, (NOT posted_references @> remaining_references) DESC, chunk_id)
    WHERE remaining_references <> '[]'::jsonb`,
  `CREATE INDEX IF NOT EXISTS channel_order_pull_chunks_references_idx
    ON channel_order_pull_chunks USING gin (original_references)`,
] as const;
