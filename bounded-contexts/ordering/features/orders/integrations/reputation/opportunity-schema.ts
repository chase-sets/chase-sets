import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const orderingOpportunitySchemaSql = `
CREATE TABLE IF NOT EXISTS ordering_order_review_opportunity_pages (
  order_id text PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation >= 0),
  source_position bigint NOT NULL,
  fact jsonb NULL,
  valid boolean NOT NULL
);
CREATE TABLE IF NOT EXISTS ordering_order_review_opportunity_sources (
  order_id text NOT NULL,
  source_context_name text NOT NULL,
  source_position bigint NOT NULL,
  PRIMARY KEY (order_id, source_context_name)
);
`;

export const orderingOpportunitySchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261006_ordering_canonical_review_opportunities",
    description: "Project canonical directional snapshots and local source provenance, including absence tombstones.",
    statements: [orderingOpportunitySchemaSql],
  },
];
