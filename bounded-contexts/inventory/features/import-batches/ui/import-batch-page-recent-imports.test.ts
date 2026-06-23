import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InventoryImportBatch } from "../read-model/queries";
import { InventoryImportBatchPage } from "./import-batch-page";

const timestamp = "2026-05-09T00:00:00.000Z";

function batch(overrides: Partial<InventoryImportBatch> = {}): InventoryImportBatch {
  return {
    batch_id: "imb_1",
    account_id: "acc_1",
    status: "uploaded",
    source_key: "native-csv",
    adapter_version: 1,
    quantity_mode: "add",
    default_storage_location_id: "loc_1",
    source_filename: "stock.csv",
    total_count: 1,
    accepted_count: 0,
    rejected_count: 1,
    committed_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

describe("InventoryImportBatchPage recent imports", () => {
  it("renders a rejected batch in the recent imports list", () => {
    const html = renderToString(
      createElement(InventoryImportBatchPage, {
        batches: [batch()],
        storageLocations: [],
        detail: null,
      }),
    );

    expect(html).toContain("Recent imports");
    expect(html).toContain("stock.csv");
    expect(html).toContain("uploaded");
    expect(html).toContain("Rejected");
    expect(html).toContain("/account/inventory/imports/imb_1");
  });
});
