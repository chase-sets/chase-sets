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
    acquisition_occurred_at: null,
    acquisition_cost_amount: null,
    acquisition_cost_currency_code: null,
    seller_sku: "SKU-1",
    listing_price_amount: null,
    listing_price_currency_code: null,
    listing_quantity_cap: null,
    row_note: null,
    validation_errors: ["Seller SKU 'box-a-101' is not mapped for this account."],
    committed_inventory_item_id: null,
    committed_listing_id: null,
    committed_at: null,
    needs_seller: true,
    created_at: timestamp,
    updated_at: timestamp,
    row_version: "2026-05-09T00:00:00.123456Z",
    ...overrides,
  };
}

function detail(rows: readonly InventoryImportBatchRow[]): InventoryImportBatchDetail {
  return { ...batch({ total_count: rows.length }), can_commit: false, commit_ready_count: 0, rows };
}

afterEach(() => cleanup());

describe("import-batch resolution drawer", () => {
  it("uses API flags for the deep-linked drawer and its page-scoped position", () => {
    render(
      <InventoryImportBatchPage
        batches={[]}
        storageLocations={[storageLocation]}
        currentPath="/account/inventory/imports/imb_1?resolveRowId=imr_second"
        detail={detail([
          row({ needs_seller: false }),
          row({ row_id: "imr_first", row_number: 3, status: "accepted", needs_seller: true }),
          row({ row_id: "imr_second", row_number: 4, status: "accepted", needs_seller: true }),
        ])}
      />,
    );
    expect(screen.getByText("Resolve import row 4")).toBeTruthy();
    expect(screen.getByText("Row 2 of 2 to resolve")).toBeTruthy();
  });

  it("does not open a rejected unresolved row when needs_seller is false", () => {
    render(
      <InventoryImportBatchPage
        batches={[]}
        storageLocations={[storageLocation]}
        detail={detail([row({ needs_seller: false })])}
        currentPath="/account/inventory/imports/imb_1?resolveRowId=imr_1"
      />,
    );
    expect(screen.queryByText("Resolve import row 2")).toBeNull();
  });
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
    expect(screen.getByRole("combobox", { name: "Catalog item" })).toBeTruthy();
    expect(document.querySelector('input[type="hidden"][name="catalogItemId"]')).not.toBeNull();
    expect(document.querySelector('select[name="storageLocationId"]')).not.toBeNull();
    // The resolution form posts the row-resolution intent for the deep-linked row.
    expect(document.querySelector('input[name="intent"][value="resolve-row"]')).not.toBeNull();
    expect(document.querySelector('input[name="rowId"][value="imr_1"]')).not.toBeNull();
    // issue-7169-ac7: the form carries the exact row facts it rendered and a persisted attempt slot.
    expect(
      document.querySelector('input[name="expectedRowVersion"][value="2026-05-09T00:00:00.123456Z"]'),
    ).not.toBeNull();
    expect(document.querySelector('input[name="expectedRowFingerprint"][value="native-csv|2"]')).not.toBeNull();
    expect(document.querySelector('input[name="inventoryMutationAttemptId"]')).not.toBeNull();
  });

  it("keeps the drawer closed for a stale deep link to an already-resolved row", () => {
    render(
      <InventoryImportBatchPage
        batches={[batch({ accepted_count: 1, rejected_count: 0 })]}
        storageLocations={[storageLocation]}
        detail={detail([
          row({ status: "accepted", resolution_status: "resolved", catalog_item_id: "cat_1", needs_seller: false }),
        ])}
        currentPath="/account/inventory/imports/imb_1?resolveRowId=imr_1"
      />,
    );

    expect(screen.queryByText("Resolve import row 2")).toBeNull();
    expect(document.querySelector('input[name="intent"][value="resolve-row"]')).toBeNull();
  });
});
