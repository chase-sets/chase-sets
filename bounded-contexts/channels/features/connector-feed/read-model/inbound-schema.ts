import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const tables = [
  `CREATE TABLE IF NOT EXISTS channel_connector_inbound_events (
    provider_event_id text PRIMARY KEY,
    provider_name text NOT NULL,
    event_kind text NOT NULL CHECK (event_kind IN ('order','export')),
    provider_object_reference text NOT NULL,
    received_at timestamptz NOT NULL,
    admitted_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    connection_id text GENERATED ALWAYS AS ((provider_event_id::jsonb)->>0) STORED,
    CHECK (jsonb_array_length(provider_event_id::jsonb) = 3),
    CHECK ((provider_event_id::jsonb)->>1 = event_kind),
    CHECK ((provider_event_id::jsonb)->>2 = provider_object_reference)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_connector_inbound_payloads (
    provider_event_id text PRIMARY KEY REFERENCES channel_connector_inbound_events(provider_event_id),
    inbound_kind text NOT NULL CHECK (inbound_kind IN ('order','export')),
    received_at timestamptz NOT NULL,
    payload jsonb NOT NULL
  )`,
  `ALTER TABLE channel_connector_pairings ADD COLUMN IF NOT EXISTS served_poll_window_seconds integer`,
] as const;
const indexes = [
  `CREATE INDEX IF NOT EXISTS channel_connector_inbound_order_idx
    ON channel_connector_inbound_events (connection_id, event_kind, admitted_sequence)`,
  `CREATE INDEX IF NOT EXISTS channel_connector_inbound_payload_retention_idx
    ON channel_connector_inbound_payloads (inbound_kind, received_at, provider_event_id)`,
] as const;
export const connectorInboundSchemaSql = [...tables, ...indexes].join(";\n") + ";";
export const connectorInboundSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261007_channels_connector_transport",
    description: "Durable connector inbound identity and separate payload, ordered handoff and served poll window.",
    statements: [
      ...tables,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_connector_inbound_order_idx
    ON channel_connector_inbound_events (connection_id, event_kind, admitted_sequence)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_connector_inbound_payload_retention_idx
    ON channel_connector_inbound_payloads (inbound_kind, received_at, provider_event_id)`,
    ],
  },
];
