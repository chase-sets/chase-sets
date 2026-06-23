import { describe, expect, it } from "vitest";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import { getImportBatch, listImportBatches, type InventoryImportBatch } from "./queries";

const rejectedBatch: InventoryImportBatch = {
  batch_id: "imb_rejected",
  account_id: "acc_1",
  status: "committed",
  source_key: "native-csv",
  adapter_version: 1,
  quantity_mode: "add",
  default_storage_location_id: "loc_1",
  source_filename: "stock.csv",
  total_count: 1,
  accepted_count: 0,
  rejected_count: 1,
  committed_count: 0,
  created_at: "2026-06-23T11:35:30.237Z",
  updated_at: "2026-06-23T11:35:30.310Z",
};

class ImportBatchReadModelDb implements PgQueryable {
  public async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("COUNT(*)")) {
      return { rows: [{ count: "1" } as Row], rowCount: 1 };
    }

    if (sql.includes("FROM inventory_import_batch_rows")) {
      return {
        rows: [
          {
            row_id: "imr_rejected",
            batch_id: "imb_rejected",
            row_number: 2,
            status: "rejected",
            raw_row: {},
            external_reference: null,
            row_fingerprint: "native-csv|2||cat_1|loc_1|2|",
            quantity_mode: "add",
            quantity_delta: 2,
            set_quantity: null,
            source_price_amount: null,
            resolution_status: "native",
            catalog_item_id: "cat_1",
            product_id: null,
            selected_options: [],
            storage_location_id: "loc_1",
            total_quantity: 2,
            acquisition_cost_amount: null,
            seller_sku: null,
            listing_price_amount: null,
            listing_quantity_cap: null,
            row_note: null,
            validation_errors: ["Selected options must include Form."],
            committed_inventory_item_id: null,
            committed_listing_id: null,
            committed_at: null,
            created_at: rejectedBatch.created_at,
            updated_at: rejectedBatch.updated_at,
          } as Row,
        ],
        rowCount: 1,
      };
    }

    if (sql.includes("FROM inventory_import_batches")) {
      const queryNormalizesRejectedRows = sql.includes("rejected_count = 0");
      const batch = {
        ...rejectedBatch,
        status: queryNormalizesRejectedRows ? "uploaded" : rejectedBatch.status,
      };
      const rows = values[0] === rejectedBatch.account_id || values[0] === rejectedBatch.batch_id ? [batch] : [];
      return { rows: rows as Row[], rowCount: rows.length };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

describe("inventory import batch read model queries", () => {
  it("normalizes rejected-only persisted batches back to reviewable status", async () => {
    const db = new ImportBatchReadModelDb();

    const list = await listImportBatches(db, { accountId: "acc_1" });
    const detail = await getImportBatch(db, "imb_rejected", "acc_1");

    expect(list.items[0]).toMatchObject({
      batch_id: "imb_rejected",
      status: "uploaded",
      accepted_count: 0,
      rejected_count: 1,
      committed_count: 0,
    });
    expect(detail).toMatchObject({
      batch_id: "imb_rejected",
      status: "uploaded",
      rows: [
        expect.objectContaining({
          status: "rejected",
          validation_errors: ["Selected options must include Form."],
        }),
      ],
    });
  });
});
