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
  inventory_item_id text NULL
);

CREATE INDEX IF NOT EXISTS checkout_marketplace_seller_options_product_idx
  ON checkout_marketplace_seller_options (product_id, status, price_amount);

ALTER TABLE checkout_marketplace_seller_options
  ADD COLUMN IF NOT EXISTS product_measure_snapshot jsonb NULL;
`;

export const checkoutMarketplaceSellerOptionsSchemaMigrations: readonly BcSchemaMigration[] = [
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
