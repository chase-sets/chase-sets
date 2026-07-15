// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { InventoryImportBatch, InventoryImportBatchDetail, InventoryImportBatchRow } from "../read-model/queries";
import type { InventoryStorageLocation } from "../../storage-locations/api/contracts";
import { InventoryImportBatchPage } from "./import-batch-page";

const timestamp = "2026-05-09T00:00:00.000Z";

const storageLocation: InventoryStorageLocation = {
  storage_location_id: "loc_active",
  account_id: "acc_1",
  name: "Active shelf",
  description: null,
  ship_from_code: "CHI",
  ship_from_address: {
    name: "Chase Sets",
    line1: "100 Market St",
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
  },
  is_archived: false,
  updated_at: timestamp,
};

function batch(overrides: Partial<InventoryImportBatch> = {}): InventoryImportBatch {
  return {
    batch_id: "imb_1",
    account_id: "acc_1",
    status: "uploaded",
    source_key: "native-csv",
    adapter_version: 1,
    quantity_mode: "add",
    default_storage_location_id: "loc_active",
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

function row(overrides: Partial<InventoryImportBatchRow> = {}): InventoryImportBatchRow {
  return {
    row_id: "imr_1",
    batch_id: "imb_1",
    row_number: 2,
    status: "rejected",
    raw_row: {},
    external_reference: null,
    row_fingerprint: "native-csv|2",
    quantity_mode: "add",
    quantity_delta: 3,
    set_quantity: null,
    source_price_amount: null,
    resolution_status: "unresolved",
    catalog_item_id: null,
    product_id: null,
    selected_options: [],
    storage_location_id: "loc_active",
    total_quantity: null,
    acquisition_cost_amount: null,
    seller_sku: "SKU-1",
    listing_price_amount: null,
    listing_quantity_cap: null,
    row_note: null,
    validation_errors: ["Seller SKU 'box-a-101' is not mapped for this account."],
    committed_inventory_item_id: null,
    committed_listing_id: null,
    committed_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function detail(rows: readonly InventoryImportBatchRow[]): InventoryImportBatchDetail {
  return { ...batch({ total_count: rows.length }), rows };
}

afterEach(() => cleanup());

describe("import-batch resolution drawer", () => {
  it("opens the resolution form in a drawer when a row is deep-linked", () => {
    render(
      <InventoryImportBatchPage
        batches={[batch()]}
        storageLocations={[storageLocation]}
        detail={detail([row()])}
        currentPath="/account/inventory/imports/imb_1?resolveRowId=imr_1"
      />,
    );

    // The drawer opens over the batch surface with the resolution form and progress.
    expect(screen.getByText("Resolve import row 2")).toBeTruthy();
    expect(screen.getByText("Row 1 of 1 to resolve")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply row fix" })).toBeTruthy();
    expect(document.querySelector('select[name="catalogItemId"]')).not.toBeNull();
    expect(document.querySelector('select[name="storageLocationId"]')).not.toBeNull();
    // The resolution form posts the row-resolution intent for the deep-linked row.
    expect(document.querySelector('input[name="intent"][value="resolve-row"]')).not.toBeNull();
    expect(document.querySelector('input[name="rowId"][value="imr_1"]')).not.toBeNull();
  });

  it("keeps the drawer closed for a stale deep link to an already-resolved row", () => {
    render(
      <InventoryImportBatchPage
        batches={[batch({ accepted_count: 1, rejected_count: 0 })]}
        storageLocations={[storageLocation]}
        detail={detail([row({ status: "accepted", resolution_status: "resolved", catalog_item_id: "cat_1" })])}
        currentPath="/account/inventory/imports/imb_1?resolveRowId=imr_1"
      />,
    );

    expect(screen.queryByText("Resolve import row 2")).toBeNull();
    expect(document.querySelector('input[name="intent"][value="resolve-row"]')).toBeNull();
  });
});
