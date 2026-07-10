import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const fulfillmentUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_fulfillment_unlogged_projections",
    description: "Store replayable Fulfillment projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE fulfillment_label_address_override_audit_pages DROP CONSTRAINT IF EXISTS fulfillment_label_address_override_audit_pages_shipment_id_fkey;",
      "ALTER TABLE fulfillment_order_source_lines DROP CONSTRAINT IF EXISTS fulfillment_order_source_lines_order_id_fkey;",
      "ALTER TABLE fulfillment_shipment_exception_pages DROP CONSTRAINT IF EXISTS fulfillment_shipment_exception_pages_shipment_id_fkey;",
      "ALTER TABLE fulfillment_shipment_line_pages DROP CONSTRAINT IF EXISTS fulfillment_shipment_line_pages_shipment_id_fkey;",
      "ALTER TABLE fulfillment_account_pages SET UNLOGGED;",
      "ALTER TABLE fulfillment_label_address_override_audit_pages SET UNLOGGED;",
      "ALTER TABLE fulfillment_order_source_lines SET UNLOGGED;",
      "ALTER TABLE fulfillment_order_sources SET UNLOGGED;",
      "ALTER TABLE fulfillment_payment_fraud_review_holds SET UNLOGGED;",
      "ALTER TABLE fulfillment_shipment_exception_pages SET UNLOGGED;",
      "ALTER TABLE fulfillment_shipment_line_pages SET UNLOGGED;",
      "ALTER TABLE fulfillment_shipment_pages SET UNLOGGED;",
      "ALTER TABLE fulfillment_label_address_override_audit_pages ADD CONSTRAINT fulfillment_label_address_override_audit_pages_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES fulfillment_shipment_pages (shipment_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE fulfillment_label_address_override_audit_pages VALIDATE CONSTRAINT fulfillment_label_address_override_audit_pages_shipment_id_fkey;",
      "ALTER TABLE fulfillment_order_source_lines ADD CONSTRAINT fulfillment_order_source_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES fulfillment_order_sources (order_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE fulfillment_order_source_lines VALIDATE CONSTRAINT fulfillment_order_source_lines_order_id_fkey;",
      "ALTER TABLE fulfillment_shipment_exception_pages ADD CONSTRAINT fulfillment_shipment_exception_pages_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES fulfillment_shipment_pages (shipment_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE fulfillment_shipment_exception_pages VALIDATE CONSTRAINT fulfillment_shipment_exception_pages_shipment_id_fkey;",
      "ALTER TABLE fulfillment_shipment_line_pages ADD CONSTRAINT fulfillment_shipment_line_pages_shipment_id_fkey FOREIGN KEY (shipment_id) REFERENCES fulfillment_shipment_pages (shipment_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE fulfillment_shipment_line_pages VALIDATE CONSTRAINT fulfillment_shipment_line_pages_shipment_id_fkey;",
    ],
  },
];
