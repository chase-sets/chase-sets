import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const decoder = `CREATE OR REPLACE FUNCTION channel_tcgplayer_listing_sku(identity text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $fn$
DECLARE parts text[];
BEGIN
  parts := regexp_match(identity, '^tcgplayer:([0-9]+):([0-9]+):([0-9]+):(.*)$', 's');
  IF parts IS NULL OR parts[1] <> length(parts[2])::text
    OR parts[2] !~ '^[1-9][0-9]{0,19}$'
    OR parts[3] <> (length(parts[4]) + regexp_count(parts[4], U&'[\\+010000-\\+10FFFF]'))::text THEN
    RETURN NULL;
  END IF;
  RETURN parts[2];
END $fn$`;
const tables = [
  `CREATE TABLE IF NOT EXISTS channel_order_consumer (
    connection_id text PRIMARY KEY, cursor text, owner text, lease_until timestamptz,
    revision bigint NOT NULL DEFAULT 0, last_scanned_at timestamptz NOT NULL DEFAULT '1970-01-01'
  )`,
  `CREATE TABLE IF NOT EXISTS channel_order_observations (
    provider_event_id text PRIMARY KEY, connection_id text NOT NULL, account_id text NOT NULL,
    sequence bigint NOT NULL, pull_id text, order_reference text, record jsonb,
    state text NOT NULL CHECK (state IN ('pending','processing','gap','completed','expired','invalid')),
    gap_reason text, line_outcomes jsonb NOT NULL DEFAULT '[]', revision bigint NOT NULL DEFAULT 0,
    received_at timestamptz NOT NULL, attempted_at timestamptz NOT NULL DEFAULT '1970-01-01'
  )`,
  `CREATE TABLE IF NOT EXISTS channel_order_lines (
    connection_id text NOT NULL, sale_key_fingerprint text NOT NULL, facts_fingerprint text NOT NULL,
    committed_sale jsonb NOT NULL, backdated boolean NOT NULL, PRIMARY KEY (connection_id,sale_key_fingerprint)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_order_attention (
    account_id text NOT NULL, connection_id text NOT NULL, order_reference text NOT NULL, reason text NOT NULL,
    generation bigint NOT NULL, affected_lines jsonb NOT NULL, opened_at timestamptz NOT NULL, resolved_at timestamptz,
    PRIMARY KEY (connection_id,order_reference,reason)
  )`,
  `CREATE TABLE IF NOT EXISTS channel_order_pulls (
    connection_id text NOT NULL, pull_id text NOT NULL, state text NOT NULL,
    gap_reason text, order_count integer NOT NULL, line_count integer NOT NULL, sale_count integer NOT NULL,
    gap_count integer NOT NULL, revision bigint NOT NULL DEFAULT 1,
    PRIMARY KEY (connection_id,pull_id)
  )`,
] as const;
const indexes = [
  `CREATE INDEX IF NOT EXISTS channel_tcgplayer_sku_idx ON channels_channel_listing_links
    (connection_id,channel_tcgplayer_listing_sku(external_listing_id))
    WHERE NOT (last_desired_intent='delist' AND publish_state='delisted')`,
  `CREATE INDEX IF NOT EXISTS channel_order_recovery_idx ON channel_order_observations (connection_id,attempted_at,sequence)
    WHERE state IN ('pending','processing','gap')`,
  `CREATE INDEX IF NOT EXISTS channel_order_pull_idx ON channel_order_observations (connection_id,pull_id,sequence)`,
  `CREATE INDEX IF NOT EXISTS channel_order_attention_open_idx ON channel_order_attention (account_id,connection_id,order_reference,reason)
    WHERE resolved_at IS NULL`,
] as const;
export const tcgplayerOrdersSchemaSql = [decoder, ...tables, ...indexes].join(";\n") + ";";
export const tcgplayerOrdersSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261008_channels_tcgplayer_orders",
    description: "Recoverable connector sale interpretation, SKU lookup and independent order attention.",
    statements: [
      decoder,
      ...tables,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_tcgplayer_sku_idx ON channels_channel_listing_links
        (connection_id,channel_tcgplayer_listing_sku(external_listing_id))
        WHERE NOT (last_desired_intent='delist' AND publish_state='delisted')`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_order_recovery_idx ON channel_order_observations (connection_id,attempted_at,sequence)
        WHERE state IN ('pending','processing','gap')`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_order_pull_idx ON channel_order_observations (connection_id,pull_id,sequence)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS channel_order_attention_open_idx ON channel_order_attention (account_id,connection_id,order_reference,reason)
        WHERE resolved_at IS NULL`,
    ],
  },
];
