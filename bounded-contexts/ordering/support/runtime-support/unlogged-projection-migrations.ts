import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const orderingUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_ordering_unlogged_projections",
    description: "Store replayable Ordering projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE ordering_account_pages SET UNLOGGED;",
      "ALTER TABLE ordering_fulfillment_cancellation_inputs SET UNLOGGED;",
      "ALTER TABLE ordering_inventory_hold_inputs SET UNLOGGED;",
      "ALTER TABLE ordering_inventory_item_inputs SET UNLOGGED;",
      "ALTER TABLE ordering_market_listing_inputs SET UNLOGGED;",
      "ALTER TABLE ordering_order_hold_pages SET UNLOGGED;",
      "ALTER TABLE ordering_order_line_pages SET UNLOGGED;",
      "ALTER TABLE ordering_order_pages SET UNLOGGED;",
      "ALTER TABLE ordering_order_review_eligibility_pages SET UNLOGGED;",
      "ALTER TABLE ordering_order_review_pages SET UNLOGGED;",
      "ALTER TABLE ordering_order_review_shipment_sources SET UNLOGGED;",
      "ALTER TABLE ordering_order_review_support_request_sources SET UNLOGGED;",
      "ALTER TABLE ordering_postage_policy_history SET UNLOGGED;",
      "ALTER TABLE ordering_postage_policy_pages SET UNLOGGED;",
    ],
  },
];
