import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const pricingUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_pricing_unlogged_projections",
    description: "Store replayable Pricing projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE pricing_buyer_offer_inputs SET UNLOGGED;",
      "ALTER TABLE pricing_catalog_item_inputs SET UNLOGGED;",
      "ALTER TABLE pricing_external_product_reference_inputs SET UNLOGGED;",
      "ALTER TABLE pricing_fulfillment_signal_lines SET UNLOGGED;",
      "ALTER TABLE pricing_inventory_hold_inputs SET UNLOGGED;",
      "ALTER TABLE pricing_inventory_item_inputs SET UNLOGGED;",
      "ALTER TABLE pricing_market_listing_inputs SET UNLOGGED;",
      "ALTER TABLE pricing_order_signal_lines SET UNLOGGED;",
      "ALTER TABLE pricing_recommendation_pages SET UNLOGGED;",
      "ALTER TABLE pricing_tcgplayer_price_signals SET UNLOGGED;",
    ],
  },
  {
    migrationId: "20260711_pricing_repricing_policies_unlogged",
    description: "Store the replayable RepricingPolicy read-model projection as an unlogged table.",
    statements: ["SET lock_timeout = '5s';", "ALTER TABLE pricing_repricing_policies SET UNLOGGED;"],
  },
];
