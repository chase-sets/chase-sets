import { describe, expect, it } from "vitest";
import {
  getInventoryImportSourceAdapter,
  nativeCsvImportAdapter,
  tcgplayerCsvImportAdapter,
} from "./import-source-adapters";

describe("inventory import source adapters", () => {
  it("keeps native rows canonical while applying a default storage location", () => {
    const rows = nativeCsvImportAdapter.normalize({
      csvText: "catalogItemId,totalQuantity,option:condition\ncat_1,2,near_mint",
      quantityMode: "add",
      defaultStorageLocationId: "loc_1",
    });

    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      values: {
        catalogItemId: "cat_1",
        totalQuantity: "2",
        storageLocationId: "loc_1",
      },
      externalReference: null,
    });
  });

  it("normalizes TCGplayer seller portal rows to external references", () => {
    const rows = tcgplayerCsvImportAdapter.normalize({
      csvText: [
        "TCGplayer SKU,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price,Seller SKU",
        "tcg_sku_1,Charizard,Base Set,Near Mint,3,$12.50,box-1",
      ].join("\n"),
      quantityMode: "replace",
      defaultStorageLocationId: "loc_1",
    });

    expect(rows[0]).toMatchObject({
      externalReference: {
        providerKey: "tcgplayer",
        externalKey: "tcg_sku_1",
        displayName: "Charizard | Base Set | Near Mint",
      },
      values: {
        storageLocationId: "loc_1",
        totalQuantity: "3",
        sellerSku: "box-1",
        listingPriceAmount: "12.50",
        listingQuantityCap: "3",
        sourcePriceAmount: "12.50",
      },
    });
  });

  it("normalizes app-style product id rows and signed add quantities", () => {
    const rows = tcgplayerCsvImportAdapter.normalize({
      csvText: "ProductId,Name,Qty,Price\n12345,Pikachu,-2,1.25",
      quantityMode: "add",
      defaultStorageLocationId: "loc_1",
    });

    expect(rows[0]).toMatchObject({
      externalReference: {
        providerKey: "tcgplayer",
        externalKey: "12345",
      },
      values: {
        totalQuantity: "-2",
        listingQuantityCap: "",
      },
    });
  });

  it("rejects unsupported source keys at the registry boundary", () => {
    expect(() => getInventoryImportSourceAdapter("unknown")).toThrow(
      "Unsupported inventory import source",
    );
  });
});
