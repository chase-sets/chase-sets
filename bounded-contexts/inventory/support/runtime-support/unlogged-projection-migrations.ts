import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const inventoryUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_inventory_unlogged_projections",
    description: "Store replayable Inventory projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE inventory_holds DROP CONSTRAINT IF EXISTS inventory_holds_item_id_fkey;",
      "ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_storage_location_id_fkey;",
      "ALTER TABLE inventory_restock_decisions DROP CONSTRAINT IF EXISTS inventory_restock_decisions_item_id_fkey;",
      "ALTER TABLE inventory_catalog_blueprints SET UNLOGGED;",
      "ALTER TABLE inventory_catalog_dimension_options SET UNLOGGED;",
      "ALTER TABLE inventory_catalog_dimensions SET UNLOGGED;",
      "ALTER TABLE inventory_catalog_external_catalog_item_references SET UNLOGGED;",
      "ALTER TABLE inventory_catalog_external_product_references SET UNLOGGED;",
      "ALTER TABLE inventory_catalog_items SET UNLOGGED;",
      "ALTER TABLE inventory_fulfillment_shipment_sources SET UNLOGGED;",
      "ALTER TABLE inventory_holds SET UNLOGGED;",
      "ALTER TABLE inventory_item_ledger SET UNLOGGED;",
      "ALTER TABLE inventory_items SET UNLOGGED;",
      "ALTER TABLE inventory_reservation_pages SET UNLOGGED;",
      "ALTER TABLE inventory_restock_decisions SET UNLOGGED;",
      "ALTER TABLE inventory_storage_locations SET UNLOGGED;",
      "ALTER TABLE inventory_holds ADD CONSTRAINT inventory_holds_item_id_fkey FOREIGN KEY (item_id) REFERENCES inventory_items (item_id) NOT VALID;",
      "ALTER TABLE inventory_holds VALIDATE CONSTRAINT inventory_holds_item_id_fkey;",
      "ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_storage_location_id_fkey FOREIGN KEY (storage_location_id) REFERENCES inventory_storage_locations (storage_location_id) NOT VALID;",
      "ALTER TABLE inventory_items VALIDATE CONSTRAINT inventory_items_storage_location_id_fkey;",
      "ALTER TABLE inventory_restock_decisions ADD CONSTRAINT inventory_restock_decisions_item_id_fkey FOREIGN KEY (item_id) REFERENCES inventory_items (item_id) NOT VALID;",
      "ALTER TABLE inventory_restock_decisions VALIDATE CONSTRAINT inventory_restock_decisions_item_id_fkey;",
    ],
  },
];
