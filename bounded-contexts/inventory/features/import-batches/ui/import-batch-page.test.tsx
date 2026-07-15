import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { InventoryImportBatch, InventoryImportBatchDetail, InventoryImportBatchRow } from "../read-model/queries";
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
    external_reference: null,
    row_fingerprint: "native-csv|2|cat_1",
    quantity_mode: "add",
    quantity_delta: 3,
    set_quantity: null,
    source_price_amount: null,
    resolution_status: "native",
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
  const acceptedCount = rows.filter((entry) => entry.status === "accepted" || entry.status === "committed").length;
  const committedCount = rows.filter((entry) => entry.status === "committed").length;
  const rejectedCount = rows.filter((entry) => entry.status === "rejected").length;
  return {
    ...batch({
      total_count: rows.length,
      accepted_count: acceptedCount,
      rejected_count: rejectedCount,
      committed_count: committedCount,
      status: rows.length > 0 && acceptedCount > 0 && acceptedCount === committedCount ? "committed" : "uploaded",
    }),
    rows,
  };
}

describe("InventoryImportBatchPage", () => {
  it("renders the empty upload and recent import state", () => {
    const html = renderToString(<InventoryImportBatchPage batches={[]} storageLocations={[]} detail={null} />);

    expect(html).toContain("Inventory import");
    expect(html).toContain("Upload CSV");
    expect(html).toContain("Download native template");
    expect(html).toContain("/api/inventory/import-batches/templates/native-csv");
    expect(html).toContain("Export current inventory");
    expect(html).toContain("/api/inventory/import-batches/exports/native-csv");
    expect(html).toContain("No imports yet");
  });

  it("renders accepted, rejected, and committed row outcomes", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[batch()]}
        storageLocations={[]}
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

  it("renders a resolve trigger and attention banner for unresolved native rows", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[batch()]}
        storageLocations={[]}
        currentPath="/account/inventory/imports/imb_1"
        detail={detail([
          row({
            status: "rejected",
            resolution_status: "unresolved",
            catalog_item_id: null,
            product_id: null,
            storage_location_id: "loc_active",
            validation_errors: ["Seller SKU 'box-a-101' is not mapped for this account."],
          }),
        ])}
      />,
    );

    // The batch surface shows the resolution work and a deep link into the drawer;
    // the in-cell picker is gone (resolution now happens in the drawer).
    expect(html).toContain("1 rows need you");
    expect(html).toContain("Resolve rows");
    expect(html).toContain("resolveRowId=imr_1");
    expect(html).not.toMatch(/<select[^>]*name="catalogItemId"/);
  });

  it("renders a resolve trigger for Saved List rows that need a location", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[batch({ source_key: "saved-list", default_storage_location_id: null })]}
        storageLocations={[]}
        currentPath="/account/inventory/imports/imb_1"
        detail={{
          ...detail([
            row({
              status: "rejected",
              storage_location_id: null,
              validation_errors: ["storageLocationId or defaultStorageLocationId is required."],
            }),
          ]),
          source_key: "saved-list",
          default_storage_location_id: null,
        }}
      />,
    );

    expect(html).toContain("Saved List");
    expect(html).toContain("resolveRowId=imr_1");
    expect(html).not.toMatch(/<select[^>]*name="storageLocationId"/);
  });

  it("renders the all-rejected and fully committed states without commit controls", () => {
    const allRejected = renderToString(
      <InventoryImportBatchPage
        batches={[batch()]}
        storageLocations={[]}
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
        storageLocations={[]}
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
    expect(committed).toContain("/account/listings/new?inventoryItemId=inv_1");
    expect(committed).not.toContain("Commit accepted rows");
  });

  it("renders mixed committed import outcomes with inventory and listing handoffs", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[
          batch({ status: "committed", total_count: 2, accepted_count: 1, rejected_count: 1, committed_count: 1 }),
        ]}
        storageLocations={[]}
        currentPath="/account/inventory/imports/imb_1?afterWrite=fresh&postWriteHandoff=handoff"
        detail={detail([
          row({
            status: "committed",
            committed_inventory_item_id: "inv_1",
            committed_at: timestamp,
          }),
          row({
            row_id: "imr_2",
            row_number: 3,
            status: "rejected",
            validation_errors: ["Catalog item was not found."],
            catalog_item_id: "cat_missing",
            product_id: null,
          }),
        ])}
      />,
    );

    expect(html).toContain("Inventory item inv_1 created.");
    expect(html).toContain("Catalog item was not found.");
    expect(html).toContain("/account/inventory?afterWrite=fresh&amp;postWriteHandoff=handoff");
    expect(html).toContain(
      "/account/listings/new?inventoryItemId=inv_1&amp;afterWrite=fresh&amp;postWriteHandoff=handoff",
    );
    expect(html).not.toContain("Commit accepted rows");
  });

  it("renders a route-owned import updating notice", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[]}
        storageLocations={[]}
        detail={null}
        detailLoadMessage="The import batch is still updating. Reload this page in a moment."
      />,
    );

    expect(html).toContain("Import still updating");
    expect(html).toContain("The import batch is still updating. Reload this page in a moment.");
  });

  it("preserves import freshness metadata in inventory and listing handoff links", () => {
    const html = renderToString(
      <InventoryImportBatchPage
        batches={[batch({ status: "committed" })]}
        storageLocations={[]}
        currentPath="/account/inventory/imports/imb_1?afterWrite=fresh&postWriteHandoff=handoff"
        detail={detail([
          row({
            status: "committed",
            committed_inventory_item_id: "inv_1",
            committed_at: timestamp,
          }),
        ])}
      />,
    );

    expect(html).toContain("/account/inventory?afterWrite=fresh&amp;postWriteHandoff=handoff");
    expect(html).toContain(
      "/account/listings/new?inventoryItemId=inv_1&amp;afterWrite=fresh&amp;postWriteHandoff=handoff",
    );
  });
});
