import { describe, expect, it } from "vitest";
import { parseImportCsv } from "./csv";

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
      [
        "catalogItemId,storageLocationId,totalQuantity,rowNote",
        "cat_1,loc_1,1,\"front clean, back whitening\"",
        "",
      ].join("\r\n"),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.values.rowNote).toBe("front clean, back whitening");
  });
});
