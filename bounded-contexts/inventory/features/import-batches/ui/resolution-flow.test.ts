import { describe, expect, it } from "vitest";
import type { InventoryImportBatchDetail, InventoryImportBatchRow } from "../read-model/queries";
import {
  activeResolutionRow,
  firstUnresolvedRowId,
  resolveRowRedirectTarget,
  rowNeedsResolution,
  unresolvedResolutionRowIds,
} from "./resolution-flow";

const timestamp = "2026-07-14T00:00:00.000Z";

function row(overrides: Partial<InventoryImportBatchRow> = {}): InventoryImportBatchRow {
  return {
    row_id: "row_1",
    batch_id: "batch_1",
    row_number: 1,
    status: "rejected",
    raw_row: {},
    external_reference: null,
    row_fingerprint: "fp_1",
    quantity_mode: "add",
    quantity_delta: 1,
    set_quantity: null,
    source_price_amount: null,
    resolution_status: "unresolved",
    catalog_item_id: null,
    product_id: null,
    selected_options: [],
    storage_location_id: null,
    total_quantity: null,
    acquisition_cost_amount: null,
    seller_sku: null,
    listing_price_amount: null,
    listing_quantity_cap: null,
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

function detail(
  rows: readonly InventoryImportBatchRow[],
  overrides: Partial<InventoryImportBatchDetail> = {},
): InventoryImportBatchDetail {
  return {
    batch_id: "batch_1",
    account_id: "acc_1",
    status: "uploaded",
    source_key: "native-csv",
    adapter_version: 1,
    quantity_mode: "add",
    default_storage_location_id: null,
    source_filename: null,
    total_count: rows.length,
    accepted_count: rows.filter((candidate) => candidate.status === "accepted").length,
    rejected_count: rows.filter((candidate) => candidate.status === "rejected").length,
    committed_count: rows.filter((candidate) => candidate.status === "committed").length,
    created_at: timestamp,
    updated_at: timestamp,
    rows,
    ...overrides,
  };
}

describe("rowNeedsResolution", () => {
  it("flags unresolved native-csv rejections", () => {
    expect(rowNeedsResolution(row(), "native-csv")).toBe(true);
  });

  it("flags saved-list rejections regardless of resolution status", () => {
    expect(rowNeedsResolution(row({ resolution_status: "native" }), "saved-list")).toBe(true);
  });

  it("does not flag accepted, committed, or already-resolved rows", () => {
    expect(rowNeedsResolution(row({ status: "accepted" }), "native-csv")).toBe(false);
    expect(rowNeedsResolution(row({ resolution_status: "resolved" }), "native-csv")).toBe(false);
    expect(rowNeedsResolution(row({ committed_at: timestamp }), "native-csv")).toBe(false);
  });
});

describe("unresolvedResolutionRowIds", () => {
  it("returns only the rows still needing the seller, in row order", () => {
    const rows = [
      row({ row_id: "row_1", row_number: 1 }),
      row({ row_id: "row_2", row_number: 2, status: "accepted" }),
      row({ row_id: "row_3", row_number: 3 }),
    ];
    expect(unresolvedResolutionRowIds(detail(rows))).toEqual(["row_1", "row_3"]);
  });
});

describe("firstUnresolvedRowId + auto-advance", () => {
  it("returns the first unresolved row for the drawer to open", () => {
    const rows = [row({ row_id: "row_1", status: "accepted" }), row({ row_id: "row_2" })];
    expect(firstUnresolvedRowId(detail(rows))).toBe("row_2");
  });

  it("returns null once every row is clean", () => {
    const rows = [row({ row_id: "row_1", status: "accepted" }), row({ row_id: "row_2", status: "committed" })];
    expect(firstUnresolvedRowId(detail(rows))).toBeNull();
  });

  it("advances to the next unresolved row on the same batch surface", () => {
    const rows = [row({ row_id: "row_1", status: "accepted" }), row({ row_id: "row_2" })];
    expect(resolveRowRedirectTarget("batch_1", detail(rows))).toBe(
      "/account/inventory/imports/batch_1?resolveRowId=row_2",
    );
  });

  it("closes the drawer (no resolveRowId) when the batch is fully resolved", () => {
    const rows = [row({ row_id: "row_1", status: "accepted" })];
    expect(resolveRowRedirectTarget("batch_1", detail(rows))).toBe("/account/inventory/imports/batch_1");
  });
});

describe("activeResolutionRow", () => {
  it("returns the row when it still needs resolution", () => {
    const target = row({ row_id: "row_2" });
    expect(activeResolutionRow(detail([row({ row_id: "row_1" }), target]), "row_2")).toBe(target);
  });

  it("returns null for a stale deep link to an already-resolved row", () => {
    expect(activeResolutionRow(detail([row({ row_id: "row_1", status: "accepted" })]), "row_1")).toBeNull();
  });

  it("returns null when there is no detail or row id", () => {
    expect(activeResolutionRow(null, "row_1")).toBeNull();
    expect(activeResolutionRow(detail([row()]), null)).toBeNull();
  });
});
