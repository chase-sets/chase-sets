import { describe, expect, it } from "vitest";
import { fulfillmentReturnShipmentSchemaMigrations } from "./schema";

describe("Return Shipment schema", () => {
  it("converges existing customer and operator pages on label and postage columns", () => {
    const migration = fulfillmentReturnShipmentSchemaMigrations.find(
      (entry) => entry.migrationId === "20260718_fulfillment_return_shipment_label_columns",
    );
    const statements = migration?.statements.join("\n") ?? "";

    for (const column of ["label_status", "label_document_url", "label_failure_reason"]) {
      expect(statements).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const column of [
      "postage_provider_name",
      "postage_provider_mode",
      "postage_provider_shipment_id",
      "postage_provider_label_id",
      "postage_amount_cents",
      "estimated_postage_amount_cents",
      "postage_currency",
      "label_failure_detail",
      "label_refund_status",
      "label_refund_reference",
      "label_failed_at",
      "label_voided_at",
    ]) {
      expect(statements).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
  });
});
