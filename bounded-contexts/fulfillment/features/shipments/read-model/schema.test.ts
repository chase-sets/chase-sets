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
          expect.stringContaining("DROP CONSTRAINT IF EXISTS fulfillment_postage_label_operations_status_check"),
          expect.stringContaining("UPDATE fulfillment_postage_label_operations AS operation"),
          expect.stringContaining(
            "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS fulfillment_postage_label_operations_active_kind_idx",
          ),
        ],
      }),
    ]);
  });
});
