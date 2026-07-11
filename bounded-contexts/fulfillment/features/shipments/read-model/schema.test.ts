import { describe, expect, it } from "vitest";
import { fulfillmentShipmentSchemaMigrations, fulfillmentShipmentSchemaSql } from "./schema";

describe("fulfillment shipment schema", () => {
  it("keeps one-time shipment read-model reshapes out of boot schema SQL", () => {
    expect(fulfillmentShipmentSchemaSql).toContain("CREATE TABLE IF NOT EXISTS fulfillment_shipment_pages");
    expect(fulfillmentShipmentSchemaSql).toContain("CREATE TABLE IF NOT EXISTS fulfillment_shipment_line_pages");
    expect(fulfillmentShipmentSchemaSql).not.toContain("UPDATE fulfillment_shipment_line_pages");
    expect(fulfillmentShipmentSchemaSql).not.toContain("UPDATE fulfillment_postage_label_operations");
    expect(fulfillmentShipmentSchemaSql).not.toContain("DROP CONSTRAINT IF EXISTS");
    expect(fulfillmentShipmentSchemaSql).not.toContain("fulfillment_postage_label_operations_active_kind_idx");
    expect(fulfillmentShipmentSchemaSql).not.toContain("fulfillment_shipment_pages_postage_label_idx");
  });

  it("ledgers shipment backfills and active postage-operation uniqueness", () => {
    expect(fulfillmentShipmentSchemaMigrations).toEqual([
      expect.objectContaining({
        migrationId: "20260703_fulfillment_shipment_line_packing_confirmed_quantity",
        statements: [expect.stringContaining("UPDATE fulfillment_shipment_line_pages")],
      }),
      expect.objectContaining({
        migrationId: "20260703_fulfillment_postage_label_operation_active_fence",
        statements: [
          expect.stringContaining("SET lock_timeout"),
          expect.stringContaining("DROP CONSTRAINT IF EXISTS fulfillment_postage_label_operations_status_check"),
          expect.stringContaining("UPDATE fulfillment_postage_label_operations AS operation"),
          expect.stringContaining(
            "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_postage_label_operations_active_kind_idx",
          ),
        ],
      }),
      expect.objectContaining({
        migrationId: "20260710_fulfillment_shipment_postage_label_provider_uniqueness",
        statements: [
          expect.stringContaining("WHERE postage_provider_label_id IS NOT NULL"),
          expect.stringContaining(
            "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_shipment_pages_postage_label_idx",
          ),
        ],
      }),
      expect.objectContaining({
        migrationId: "20260711_fulfillment_shipment_display_reference_unique_idx",
        statements: [
          expect.stringContaining("SET lock_timeout"),
          expect.stringContaining(
            "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_shipment_pages_display_reference_key",
          ),
        ],
      }),
    ]);
  });

  it("scopes the purchased postage label uniqueness index by provider so ids never collide across providers", () => {
    const uniquenessMigration = fulfillmentShipmentSchemaMigrations.find(
      (migration) => migration.migrationId === "20260710_fulfillment_shipment_postage_label_provider_uniqueness",
    );
    const indexStatement = uniquenessMigration?.statements.find((statement) =>
      statement.includes("fulfillment_shipment_pages_postage_label_idx"),
    );

    expect(indexStatement).toContain(
      "ON fulfillment_shipment_pages (postage_provider_name, postage_provider_label_id)",
    );
    expect(indexStatement).toContain("WHERE postage_provider_label_id IS NOT NULL");
  });
});
