import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const createMarketplaceChannelInboundClampsSql = `CREATE TABLE IF NOT EXISTS marketplace_channel_inbound_clamps (
  account_id text NOT NULL,
  connection_id text NOT NULL,
  run_id text NOT NULL,
  listing_id text NOT NULL,
  inventory_item_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','engaged','released','recovery')),
  observed_stream_version bigint NOT NULL CHECK (observed_stream_version > 0),
  paused_stream_version bigint NULL CHECK (paused_stream_version IS NULL OR paused_stream_version > observed_stream_version),
  observed_updated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (connection_id, run_id, listing_id),
  CHECK ((state = 'engaged') = (paused_stream_version IS NOT NULL))
)`;

export const marketplaceChannelInboundClampSchemaSql = `
${createMarketplaceChannelInboundClampsSql};

CREATE INDEX IF NOT EXISTS marketplace_channel_inbound_clamps_listing_active_idx
  ON marketplace_channel_inbound_clamps (listing_id, state, connection_id, run_id);
`;

export const marketplaceChannelInboundClampSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260910_marketplace_channel_inbound_clamps",
    description: "Record revision-fenced Marketplace Listing pauses owned by a dark Channel inbound-coverage run.",
    statements: [
      createMarketplaceChannelInboundClampsSql,
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS marketplace_channel_inbound_clamps_listing_active_idx ON marketplace_channel_inbound_clamps (listing_id, state, connection_id, run_id);",
    ],
  },
];
