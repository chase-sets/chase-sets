import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const checkoutMarketplaceSellerOptionsSchemaSql = `
CREATE TABLE IF NOT EXISTS checkout_marketplace_seller_options (
  listing_id text PRIMARY KEY,
  seller_account_id text NOT NULL,
  product_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  price_amount numeric(12, 2) NOT NULL,
  listing_quantity_cap integer NOT NULL,
  product_summary text NULL,
  product_measure_snapshot jsonb NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL,
  seller_slug text NULL,
  seller_display_name text NULL,
  seller_average_rating numeric NULL,
  seller_review_count integer NULL,
  supply_total_quantity integer NULL,
  active_held_quantity integer NULL,
  inventory_item_id text NULL,
  evidence_requirements jsonb NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS checkout_marketplace_seller_options_product_idx
  ON checkout_marketplace_seller_options (product_id, status, price_amount);

ALTER TABLE checkout_marketplace_seller_options
  ADD COLUMN IF NOT EXISTS product_measure_snapshot jsonb NULL;

-- At-capacity buyer signal (m127 #4883, producer: ordering's #4882 open-order
-- enforcement). Orthogonal to status: a seller can be away AND at capacity
-- at once, and each clears independently, so this is tracked as its own
-- column rather than a third status value that would lose information on
-- overlap. Candidate/readiness queries additionally require
-- at_capacity = false alongside status = 'active'.
ALTER TABLE checkout_marketplace_seller_options
  ADD COLUMN IF NOT EXISTS at_capacity boolean NOT NULL DEFAULT false;

ALTER TABLE checkout_marketplace_seller_options
  ADD COLUMN IF NOT EXISTS evidence_requirements jsonb NULL;

ALTER TABLE checkout_marketplace_seller_options
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb;
`;

export const checkoutMarketplaceSellerOptionsSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260714_checkout_seller_options_listing_evidence",
    description: "Mirror Marketplace listing evidence into Checkout seller options for local Sell List review.",
    statements: [
      `ALTER TABLE checkout_marketplace_seller_options
  ADD COLUMN IF NOT EXISTS evidence_requirements jsonb NULL`,
      `ALTER TABLE checkout_marketplace_seller_options
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb`,
    ],
  },
  {
    migrationId: "20260703_checkout_seller_options_hot_update_indexes",
    description: "Create checkout seller-option indexes for hot projection update predicates.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS checkout_marketplace_seller_options_inventory_item_idx
  ON checkout_marketplace_seller_options (inventory_item_id)
  WHERE inventory_item_id IS NOT NULL;`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS checkout_marketplace_seller_options_catalog_item_idx
  ON checkout_marketplace_seller_options (catalog_catalog_item_id);`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS checkout_marketplace_seller_options_seller_availability_idx
  ON checkout_marketplace_seller_options (seller_account_id, status)
  WHERE status IN ('active', 'seller-unavailable');`,
    ],
  },
];
