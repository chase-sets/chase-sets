import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  InventoryImportBatch,
  InventoryImportBatchDetail,
  InventoryImportBatchRow,
} from "../read-model/queries";
import { InventoryImportBatchPage } from "./import-batch-page";

const timestamp = "2026-05-09T00:00:00.000Z";

function batch(overrides: Partial<InventoryImportBatch> = {}): InventoryImportBatch {
  return {
    batch_id: "imb_1",
    account_id: "acc_1",
    status: "uploaded",
    source_filename: "stock.csv",
    total_count: 1,
    accepted_count: 1,
    rejected_count: 0,
    committed_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function row(overrides: Partial<InventoryImportBatchRow> = {}): InventoryImportBatchRow {
  return {
    row_id: "imr_1",
    batch_id: "imb_1",
    row_number: 2,
    status: "accepted",
    raw_row: {},
    catalog_item_id: "cat_1",
    product_id: "cat_1::condition:near_mint",
    selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    storage_location_id: "loc_1",
    total_quantity: 3,
    acquisition_cost_amount: "1.00",
    seller_sku: "SKU-1",
    listing_price_amount: "5.00",
    listing_quantity_cap: 2,
    row_note: null,
    validation_errors: [],
    committed_inventory_item_id: null,
    committed_listing_id: null,
    committed_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function detail(rows: readonly InventoryImportBatchRow[]): InventoryImportBatchDetail {
  const acceptedCount = rows.filter((entry) =>
    entry.status === "accepted" || entry.status === "committed",
  ).length;
  const committedCount = rows.filter((entry) => entry.status === "committed").length;
  return {
    ...batch({
      total_count: rows.length,
      accepted_count: acceptedCount,
      rejected_count: rows.filter((entry) => entry.status === "rejected").length,
      committed_count: committedCount,
      status: rows.length > 0 && acceptedCount === committedCount ? "committed" : "uploaded",
    }),
    rows,
  };
}

describe("InventoryImportBatchPage", () => {
  it("renders the empty upload and recent import state", () => {
    const html = renderToString(
      <InventoryImportBatchPage batches={[]} detail={null} />,
    );

    expect(html).toContain("Inventory import");
    expect(html).toContain("Upload CSV");
    expect(html).toContain("No imports yet");
  });

  it("renders accepted, rejected, and committed row outcomes", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[batch()]}
        detail={detail([
          row(),
          row({
            row_id: "imr_2",
            row_number: 3,
            status: "rejected",
            validation_errors: ["Catalog item was not found."],
            catalog_item_id: "cat_unknown",
            product_id: null,
          }),
          row({
            row_id: "imr_3",
            row_number: 4,
            status: "committed",
            committed_inventory_item_id: "inv_3",
            committed_listing_id: "lst_3",
            committed_at: timestamp,
          }),
        ])}
      />,
    );

    expect(html).toContain("Commit accepted rows");
    expect(html).toContain("Catalog item was not found.");
    expect(html).toContain("Inventory item inv_3 created.");
    expect(html).toContain("Draft listing lst_3 created.");
    expect(html).toContain("Cap: 2");
  });

  it("renders the all-rejected and fully committed states without commit controls", () => {
    const allRejected = renderToString(
      <InventoryImportBatchPage
        batches={[batch()]}
        detail={detail([
          row({
            status: "rejected",
            validation_errors: ["Storage location is archived."],
          }),
        ])}
      />,
    );
    const committed = renderToString(
      <InventoryImportBatchPage
        batches={[batch({ status: "committed" })]}
        detail={detail([
          row({
            status: "committed",
            committed_inventory_item_id: "inv_1",
            committed_at: timestamp,
          }),
        ])}
      />,
    );

    expect(allRejected).toContain("Storage location is archived.");
    expect(allRejected).not.toContain("Commit accepted rows");
    expect(committed).toContain("Inventory item inv_1 created.");
    expect(committed).not.toContain("Commit accepted rows");
  });
});
