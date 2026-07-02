import { describe, expect, it } from "vitest";
import { buildNativeInventoryExportCsv, buildNativeInventoryImportCsvTemplate, parseImportCsv } from "./csv";

describe("parseImportCsv", () => {
  it("parses a valid stock intake row with dynamic option columns", () => {
    const rows = parseImportCsv(
      [
        "catalogItemId,storageLocationId,totalQuantity,option:condition,listingPriceAmount,listingQuantityCap",
        "cat_1,loc_1,3,opt_near_mint,12.50,2",
      ].join("\n"),
    );

    expect(rows).toEqual([
      {
        rowNumber: 2,
        values: {
          catalogItemId: "cat_1",
          storageLocationId: "loc_1",
          totalQuantity: "3",
          "option:condition": "opt_near_mint",
          listingPriceAmount: "12.50",
          listingQuantityCap: "2",
        },
      },
    ]);
  });

  it("keeps quoted commas inside row notes and skips blank rows", () => {
    const rows = parseImportCsv(
      ["catalogItemId,storageLocationId,totalQuantity,rowNote", 'cat_1,loc_1,1,"front clean, back whitening"', ""].join(
        "\r\n",
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.values.rowNote).toBe("front clean, back whitening");
  });
});

describe("buildNativeInventoryImportCsvTemplate", () => {
  it("renders native headers and active storage location examples", () => {
    const csv = buildNativeInventoryImportCsvTemplate([
      { storage_location_id: "loc_main", name: "Main shelf" },
      { storage_location_id: "loc_case", name: 'Case "A", top' },
    ]);

    expect(csv.split("\n")[0]).toBe(
      "catalogItemId,storageLocationId,totalQuantity,option:form,option:condition,acquisitionCostAmount,sellerSku,listingPriceAmount,listingQuantityCap,rowNote",
    );
    expect(csv).toContain("cat_example,loc_main,1,Raw,Near Mint,,,,,Example for Main shelf");
    expect(csv).toContain('cat_example,loc_case,1,Raw,Near Mint,,,,,"Example for Case ""A"", top"');
  });

  it("renders a header-only template when the account has no active storage locations", () => {
    expect(buildNativeInventoryImportCsvTemplate([])).toBe(
      "catalogItemId,storageLocationId,totalQuantity,option:form,option:condition,acquisitionCostAmount,sellerSku,listingPriceAmount,listingQuantityCap,rowNote",
    );
  });
});

describe("buildNativeInventoryExportCsv", () => {
  it("renders current inventory in native import format with dynamic option columns", () => {
    const csv = buildNativeInventoryExportCsv([
      {
        catalog_item_id: "cat_1",
        storage_location_id: "loc_1",
        total_quantity: 3,
        selected_options: [
          { dimensionId: "form", optionId: "Raw" },
          { dimensionId: "condition", optionId: "Near Mint" },
        ],
        acquisition_cost_amount: "1.25",
      },
      {
        catalog_item_id: "cat_2",
        storage_location_id: "loc_2",
        total_quantity: 0,
        selected_options: [{ dimensionId: "language", optionId: "en" }],
        acquisition_cost_amount: null,
        seller_sku: "seller-2",
        listing_price_amount: "5.00",
        listing_quantity_cap: 2,
        row_note: "quoted, note",
      },
    ]);

    expect(csv).toBe(
      [
        "catalogItemId,storageLocationId,totalQuantity,option:form,option:condition,option:language,acquisitionCostAmount,sellerSku,listingPriceAmount,listingQuantityCap,rowNote",
        "cat_1,loc_1,3,Raw,Near Mint,,1.25,,,,",
        'cat_2,loc_2,0,,,en,,seller-2,5.00,2,"quoted, note"',
      ].join("\n"),
    );
  });

  it("renders a header-only export when the account has no inventory", () => {
    expect(buildNativeInventoryExportCsv([])).toBe(
      "catalogItemId,storageLocationId,totalQuantity,acquisitionCostAmount,sellerSku,listingPriceAmount,listingQuantityCap,rowNote",
    );
  });
});
