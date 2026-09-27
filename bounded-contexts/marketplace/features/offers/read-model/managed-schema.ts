import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

const tables = `
CREATE UNLOGGED TABLE IF NOT EXISTS marketplace_managed_offer_work (
  work_id text PRIMARY KEY, catalog_item_id text NOT NULL, product_id text NOT NULL,
  status text NOT NULL, available_at timestamptz NOT NULL, last_stream_version integer NOT NULL
);
CREATE UNLOGGED TABLE IF NOT EXISTS marketplace_managed_offer_audit (
  offer_id text PRIMARY KEY, policy_id text NOT NULL, status text NOT NULL,
  reason text NOT NULL, evidence jsonb NOT NULL, last_stream_version integer NOT NULL
);
CREATE TABLE IF NOT EXISTS marketplace_managed_offer_recovery (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), after_offer_id text NOT NULL DEFAULT '',
  generation bigint NOT NULL DEFAULT 0
);`;
export const marketplaceManagedOfferSchemaSql = `${tables}
CREATE INDEX IF NOT EXISTS marketplace_managed_offer_work_runnable_idx ON marketplace_managed_offer_work (available_at, work_id) WHERE status <> 'completed';
CREATE INDEX IF NOT EXISTS marketplace_offer_managed_product_idx ON marketplace_offer_pages (catalog_catalog_item_id, product_id, offer_id) WHERE status = 'submitted';
`;
export const marketplaceManagedOfferSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260927_marketplace_managed_offer_work",
    description: "Install managed Offer durable work, private application evidence, and bounded recovery continuation.",
    statements: [
      tables,
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS marketplace_managed_offer_work_runnable_idx ON marketplace_managed_offer_work (available_at, work_id) WHERE status <> 'completed';",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS marketplace_offer_managed_product_idx ON marketplace_offer_pages (catalog_catalog_item_id, product_id, offer_id) WHERE status = 'submitted';",
    ],
  },
];
