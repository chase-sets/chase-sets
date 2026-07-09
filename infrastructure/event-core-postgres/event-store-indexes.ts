export type EventStoreEventsIndexStatement = Readonly<{
  name: string;
  boot: string;
  concurrent: string;
}>;

export const eventStoreEventsReadIndexStatements = [
  {
    name: "event_store_events_stream_idx",
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_stream_idx
  ON event_store_events (stream_id, stream_version ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_stream_idx
  ON event_store_events (stream_id, stream_version ASC);`,
  },
  {
    name: "event_store_events_global_idx",
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_global_idx
  ON event_store_events (global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_global_idx
  ON event_store_events (global_position ASC);`,
  },
  {
    name: "event_store_events_tenant_global_idx",
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_tenant_global_idx
  ON event_store_events (tenant_id, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_tenant_global_idx
  ON event_store_events (tenant_id, global_position ASC);`,
  },
  // Retained in this ownership slice. #3607 owns redundant event-store index cleanup.
  {
    name: "event_store_events_type_idx",
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_type_idx
  ON event_store_events (event_type);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_type_idx
  ON event_store_events (event_type);`,
  },
  {
    name: "event_store_events_type_global_idx",
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_type_global_idx
  ON event_store_events (event_type, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_type_global_idx
  ON event_store_events (event_type, global_position ASC);`,
  },
  {
    name: "event_store_events_tenant_type_global_idx",
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_tenant_type_global_idx
  ON event_store_events (tenant_id, event_type, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_tenant_type_global_idx
  ON event_store_events (tenant_id, event_type, global_position ASC);`,
  },
  {
    name: "event_store_events_stream_prefix_global_idx",
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_stream_prefix_global_idx
  ON event_store_events (stream_id text_pattern_ops, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_stream_prefix_global_idx
  ON event_store_events (stream_id text_pattern_ops, global_position ASC);`,
  },
  {
    name: "event_store_events_context_category_type_global_idx",
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_context_category_type_global_idx
  ON event_store_events (stream_context_name, stream_category, event_type, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_context_category_type_global_idx
  ON event_store_events (stream_context_name, stream_category, event_type, global_position ASC);`,
  },
  {
    name: "event_store_events_context_category_global_idx",
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_context_category_global_idx
  ON event_store_events (stream_context_name, stream_category, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_context_category_global_idx
  ON event_store_events (stream_context_name, stream_category, global_position ASC);`,
  },
] as const satisfies readonly EventStoreEventsIndexStatement[];
