import type { BcSchemaMigration, BcRetentionSweep, BcRetentionExemption } from "@chase-sets/bounded-context-module";

const tables = [
  `CREATE TABLE IF NOT EXISTS channel_fulfillment_item_facts (
    item_id text PRIMARY KEY, account_id text NOT NULL, product_id text NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channel_fulfillment_observations (
    provider_event_id text PRIMARY KEY, connection_id text NOT NULL, account_id text NOT NULL,
    order_reference text NOT NULL, digest text NOT NULL, sequence bigint NOT NULL,
    state text NOT NULL CHECK (state IN ('awaiting-sale','sale-absent','accepted','refused','expired')),
    reason text, received_at timestamptz NOT NULL, changed_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS channel_fulfillment_orders (
    connection_id text NOT NULL, order_reference text NOT NULL, account_id text NOT NULL,
    status text NOT NULL, content_digest text, last_sequence bigint NOT NULL,
    accepted_at timestamptz, revision bigint NOT NULL DEFAULT 1,
    PRIMARY KEY (connection_id,order_reference)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_fulfillment_consumer (
    connection_id text PRIMARY KEY, cursor text
  )`,
] as const;
const indexes = [
  `CREATE INDEX IF NOT EXISTS channel_fulfillment_waiting_idx ON channel_fulfillment_observations
    (connection_id,order_reference,received_at) WHERE state IN ('awaiting-sale','sale-absent')`,
  `CREATE INDEX IF NOT EXISTS channel_fulfillment_retention_idx ON channel_fulfillment_observations
    (received_at,provider_event_id)`,
  `CREATE INDEX IF NOT EXISTS channel_order_committed_identity_idx ON channel_order_lines
    (connection_id, (committed_sale->'saleKey'->>'providerKey'), (committed_sale->'saleKey'->>'orderLineIdentity'))`,
] as const;
export const fulfillmentObservationSchemaSql = [...tables, ...indexes].join(";\n") + ";";
export const fulfillmentObservationSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261008_channels_fulfillment_observations",
    description: "Recoverable PII-free fulfillment interpretation and accepted order identities.",
    statements: [
      ...tables,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_fulfillment_waiting_idx ON channel_fulfillment_observations
        (connection_id,order_reference,received_at) WHERE state IN ('awaiting-sale','sale-absent')`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_fulfillment_retention_idx ON channel_fulfillment_observations
        (received_at,provider_event_id)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_order_committed_identity_idx ON channel_order_lines
        (connection_id, (committed_sale->'saleKey'->>'providerKey'), (committed_sale->'saleKey'->>'orderLineIdentity'))`,
    ],
  },
];
export const fulfillmentObservationRetentionSweeps: readonly BcRetentionSweep[] = [
  {
    name: "channel-fulfillment-observations",
    tableName: "channel_fulfillment_observations",
    predicateSql: "candidate.received_at < CURRENT_TIMESTAMP - make_interval(secs => 7776000)",
    orderBySql: "candidate.received_at ASC, candidate.provider_event_id ASC",
    intervalMs: 3600000,
    batchLimit: 100,
  },
];
export const fulfillmentObservationRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "channel_fulfillment_orders",
    owner: "channels",
    reason:
      "Non-PII accepted identity, status and content digest prevent re-publication or ship-to replacement after payload and candidate expiry.",
  },
];
