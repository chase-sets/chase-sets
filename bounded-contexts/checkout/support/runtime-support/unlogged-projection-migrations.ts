import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const checkoutUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_checkout_unlogged_projections",
    description: "Store replayable Checkout projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE checkout_cart_line_pages SET UNLOGGED;",
      "ALTER TABLE checkout_catalog_blueprints SET UNLOGGED;",
      "ALTER TABLE checkout_catalog_dimension_options SET UNLOGGED;",
      "ALTER TABLE checkout_catalog_dimensions SET UNLOGGED;",
      "ALTER TABLE checkout_catalog_items SET UNLOGGED;",
      "ALTER TABLE checkout_marketplace_seller_options SET UNLOGGED;",
      "ALTER TABLE checkout_payment_affordance_account_snapshots SET UNLOGGED;",
      "ALTER TABLE checkout_payment_affordance_pages SET UNLOGGED;",
      "ALTER TABLE checkout_payment_summary_pages SET UNLOGGED;",
      "ALTER TABLE checkout_sell_list_confirmation_pages SET UNLOGGED;",
      "ALTER TABLE checkout_sell_list_line_pages SET UNLOGGED;",
      "ALTER TABLE checkout_sell_offer_pages SET UNLOGGED;",
      "ALTER TABLE checkout_sell_payout_readiness_pages SET UNLOGGED;",
      "ALTER TABLE checkout_seller_account_reviews SET UNLOGGED;",
      "ALTER TABLE checkout_seller_accounts SET UNLOGGED;",
      "ALTER TABLE checkout_session_pages SET UNLOGGED;",
      "ALTER TABLE checkout_ship_from_addresses SET UNLOGGED;",
      "ALTER TABLE checkout_supply_holds SET UNLOGGED;",
      "ALTER TABLE checkout_supply_items SET UNLOGGED;",
      "ALTER TABLE checkout_supply_locations SET UNLOGGED;",
    ],
  },
];
