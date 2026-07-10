import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const marketplaceUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_marketplace_unlogged_projections",
    description: "Store replayable Marketplace projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE marketplace_account_pages SET UNLOGGED;",
      "ALTER TABLE marketplace_account_reviews SET UNLOGGED;",
      "ALTER TABLE marketplace_catalog_blueprints SET UNLOGGED;",
      "ALTER TABLE marketplace_catalog_dimension_options SET UNLOGGED;",
      "ALTER TABLE marketplace_catalog_dimensions SET UNLOGGED;",
      "ALTER TABLE marketplace_catalog_items SET UNLOGGED;",
      "ALTER TABLE marketplace_listing_pages SET UNLOGGED;",
      "ALTER TABLE marketplace_offer_pages SET UNLOGGED;",
      "ALTER TABLE marketplace_offer_seller_controls SET UNLOGGED;",
      "ALTER TABLE marketplace_offer_seller_declines SET UNLOGGED;",
      "ALTER TABLE marketplace_review_account_sources SET UNLOGGED;",
      "ALTER TABLE marketplace_review_eligibility_pages SET UNLOGGED;",
      "ALTER TABLE marketplace_review_order_sources SET UNLOGGED;",
      "ALTER TABLE marketplace_review_pages SET UNLOGGED;",
      "ALTER TABLE marketplace_review_shipment_sources SET UNLOGGED;",
      "ALTER TABLE marketplace_review_summary_pages SET UNLOGGED;",
      "ALTER TABLE marketplace_seller_listing_availability_pages SET UNLOGGED;",
      "ALTER TABLE marketplace_supply_holds SET UNLOGGED;",
      "ALTER TABLE marketplace_supply_items SET UNLOGGED;",
      "ALTER TABLE marketplace_supply_locations SET UNLOGGED;",
    ],
  },
];
