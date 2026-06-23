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

const mixedCommittedBatch: InventoryImportBatch = {
  batch_id: "imb_mixed",
  account_id: "acc_1",
  status: "uploaded",
  source_key: "native-csv",
  adapter_version: 1,
  quantity_mode: "add",
  default_storage_location_id: "loc_1",
  source_filename: "mixed.csv",
  total_count: 2,
  accepted_count: 1,
  rejected_count: 1,
  committed_count: 1,
  created_at: "2026-06-23T11:35:30.237Z",
  updated_at: "2026-06-23T11:35:30.310Z",
};

function normalizedStatus(batch: InventoryImportBatch): InventoryImportBatch["status"] {
  return batch.total_count > 0 && batch.accepted_count > 0 && batch.committed_count === batch.accepted_count
    ? "committed"
    : "uploaded";
}

class ImportBatchReadModelDb implements PgQueryable {
  private readonly batches = [rejectedBatch, mixedCommittedBatch];
  private readonly rows = [
    {
      row_id: "imr_rejected",
      batch_id: rejectedBatch.batch_id,
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
    },
    {
      row_id: "imr_mixed_accepted",
      batch_id: mixedCommittedBatch.batch_id,
      row_number: 2,
      status: "committed",
      raw_row: {},
      external_reference: null,
      row_fingerprint: "native-csv|2||cat_1|loc_1|2|",
      quantity_mode: "add",
      quantity_delta: 2,
      set_quantity: null,
      source_price_amount: null,
      resolution_status: "native",
      catalog_item_id: "cat_1",
      product_id: "cat_1::form:raw",
      selected_options: [{ dimensionId: "form", optionId: "raw" }],
      storage_location_id: "loc_1",
      total_quantity: 2,
      acquisition_cost_amount: null,
      seller_sku: null,
      listing_price_amount: "4.44",
      listing_quantity_cap: 1,
      row_note: null,
      validation_errors: [],
      committed_inventory_item_id: "inv_1",
      committed_listing_id: null,
      committed_at: mixedCommittedBatch.updated_at,
      created_at: mixedCommittedBatch.created_at,
      updated_at: mixedCommittedBatch.updated_at,
    },
    {
      row_id: "imr_mixed_rejected",
      batch_id: mixedCommittedBatch.batch_id,
      row_number: 3,
      status: "rejected",
      raw_row: {},
      external_reference: null,
      row_fingerprint: "native-csv|3||cat_missing|loc_1|2|",
      quantity_mode: "add",
      quantity_delta: null,
      set_quantity: null,
      source_price_amount: null,
      resolution_status: "unresolved",
      catalog_item_id: "cat_missing",
      product_id: null,
      selected_options: [],
      storage_location_id: "loc_1",
      total_quantity: 2,
      acquisition_cost_amount: null,
      seller_sku: null,
      listing_price_amount: null,
      listing_quantity_cap: null,
      row_note: null,
      validation_errors: ["Catalog item was not found."],
      committed_inventory_item_id: null,
      committed_listing_id: null,
      committed_at: null,
      created_at: mixedCommittedBatch.created_at,
      updated_at: mixedCommittedBatch.updated_at,
    },
  ] as const;

  public async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("COUNT(*)")) {
      return { rows: [{ count: String(this.batches.length) } as Row], rowCount: 1 };
    }

    if (sql.includes("FROM inventory_import_batch_rows")) {
      const rows = this.rows.filter((row) => row.batch_id === values[0]);
      return { rows: rows as Row[], rowCount: rows.length };
    }

    if (sql.includes("FROM inventory_import_batches")) {
      const matchingBatches = sql.includes("WHERE batch_id = $1")
        ? this.batches.filter((batch) => batch.batch_id === values[0] && batch.account_id === values[1])
        : this.batches.filter((batch) => batch.account_id === values[0]);
      const rows = matchingBatches.map((batch) => ({
        ...batch,
        status: normalizedStatus(batch),
      }));
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

  it("treats mixed batches as committed once every accepted row is committed", async () => {
    const db = new ImportBatchReadModelDb();

    const list = await listImportBatches(db, { accountId: "acc_1" });
    const detail = await getImportBatch(db, "imb_mixed", "acc_1");

    expect(list.items.find((batch) => batch.batch_id === "imb_mixed")).toMatchObject({
      batch_id: "imb_mixed",
      status: "committed",
      accepted_count: 1,
      rejected_count: 1,
      committed_count: 1,
    });
    expect(detail).toMatchObject({
      batch_id: "imb_mixed",
      status: "committed",
      rows: [
        expect.objectContaining({
          status: "committed",
          committed_inventory_item_id: "inv_1",
        }),
        expect.objectContaining({
          status: "rejected",
          validation_errors: ["Catalog item was not found."],
        }),
      ],
    });
  });
});
