import { describe, expect, it } from "vitest";
import {
  cardTraderCsvImportAdapter,
  ebayCsvImportAdapter,
  getInventoryImportSourceAdapter,
  nativeCsvImportAdapter,
  savedListImportAdapter,
  shopifyCsvImportAdapter,
  tcgplayerCsvImportAdapter,
  whatnotCsvImportAdapter,
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
      selectedOptionCandidates: [{ dimensionKey: "condition", value: "near_mint" }],
    });
    expect(rows[0]?.rowFingerprint).toContain("condition:nearmint");
  });

  it("emits native seller SKU rows as account SKU reference candidates", () => {
    const rows = nativeCsvImportAdapter.normalize({
      csvText: "Seller SKU,storageLocationId,totalQuantity\nBox-A-001,loc_1,2",
      quantityMode: "add",
    });

    expect(rows[0]).toMatchObject({
      externalReference: {
        providerKey: "account",
        externalKey: "sku:box-a-001",
        targetIntent: "account-sku",
      },
      values: {
        sellerSku: "Box-A-001",
      },
    });
  });

  it("preserves immutable Saved List source evidence without applying a location default", () => {
    const rows = savedListImportAdapter.normalize({
      parsedRows: [
        {
          rowNumber: 1,
          values: {
            sourceListId: "svl_1",
            sourceListVersion: "4",
            sourceLineId: "sll_1",
            sourceRowId: "saved-list:svl_1:v4:sll_1",
            catalogItemId: "cat_1",
            productId: "product_1",
            totalQuantity: "2",
            "option:condition": "near_mint",
          },
        },
      ],
      quantityMode: "add",
      defaultStorageLocationId: "loc_ignored",
    });

    expect(rows[0]).toMatchObject({
      rowNumber: 1,
      values: {
        sourceListId: "svl_1",
        sourceListVersion: "4",
        sourceLineId: "sll_1",
        sourceRowId: "saved-list:svl_1:v4:sll_1",
        catalogItemId: "cat_1",
        productId: "product_1",
        totalQuantity: "2",
      },
      selectedOptionCandidates: [{ dimensionKey: "condition", value: "near_mint" }],
    });
    expect(rows[0]?.values).not.toHaveProperty("storageLocationId");
    expect(rows[0]?.values).not.toHaveProperty("acquisitionCostAmount");
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
        externalKey: "sku:tcg_sku_1",
        displayName: "Charizard | Base Set | Near Mint",
      },
      externalReferences: [
        {
          providerKey: "tcgplayer",
          externalKey: "sku:tcg_sku_1",
          targetIntent: "product-reference",
        },
        {
          providerKey: "account",
          externalKey: "sku:box-1",
          targetIntent: "account-sku",
        },
      ],
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
        externalKey: "product:12345",
      },
      values: {
        totalQuantity: "-2",
        listingQuantityCap: "",
      },
    });
  });

  it("keeps TCGplayer product id as an ordered fallback when the row also has a SKU", () => {
    const rows = tcgplayerCsvImportAdapter.normalize({
      csvText:
        "TCGplayer SKU,Product ID,Product Name,Set Name,Condition,Quantity,TCG Marketplace Price\nmissing_sku,12345,Pikachu,Jungle,Near Mint,2,1.25",
      quantityMode: "replace",
      defaultStorageLocationId: "loc_1",
    });

    expect(rows[0]?.externalReferences.map((reference) => reference.externalKey)).toEqual([
      "sku:missing_sku",
      "product:12345",
    ]);
  });

  it("normalizes eBay active listing exports into exact mapping candidates", () => {
    const rows = ebayCsvImportAdapter.normalize({
      csvText:
        "Item ID,Custom label,Title,Condition,Available quantity,Current price,ePID,UPC\n1001,box-1,Charizard,Near Mint,2,$12.50,epid-1,012345678905",
      quantityMode: "replace",
      defaultStorageLocationId: "loc_1",
    });

    expect(rows[0]).toMatchObject({
      externalReferences: [
        { providerKey: "ebay", externalKey: "listing:1001" },
        { providerKey: "ebay", externalKey: "sku:box-1" },
        { providerKey: "ebay", externalKey: "epid:epid-1" },
        { providerKey: "gtin", externalKey: "012345678905" },
      ],
      values: {
        totalQuantity: "2",
        sellerSku: "box-1",
        listingPriceAmount: "12.50",
      },
    });
  });

  it("normalizes Shopify product exports into variant, SKU, barcode, and handle candidates", () => {
    const rows = shopifyCsvImportAdapter.normalize({
      csvText:
        "Handle,Title,Variant ID,Variant SKU,Variant Barcode,Variant Inventory Qty,Variant Price\nbase-charizard,Charizard,987,box-1,012345678905,3,15.00",
      quantityMode: "replace",
      defaultStorageLocationId: "loc_1",
    });

    expect(rows[0]).toMatchObject({
      externalReferences: [
        { providerKey: "shopify", externalKey: "variant:987" },
        { providerKey: "shopify", externalKey: "sku:box-1" },
        { providerKey: "gtin", externalKey: "012345678905" },
        { providerKey: "shopify", externalKey: "handle:base-charizard" },
      ],
      values: {
        totalQuantity: "3",
        listingQuantityCap: "3",
      },
    });
  });

  it("normalizes parsed provider rows through the same source profile semantics", () => {
    const rows = shopifyCsvImportAdapter.normalize({
      parsedRows: [
        {
          rowNumber: 1,
          values: {
            Title: "Charizard",
            "Variant ID": "987",
            "Variant Inventory Qty": "3",
            "Variant Price": "15.00",
          },
        },
      ],
      quantityMode: "replace",
      defaultStorageLocationId: "loc_1",
    });

    expect(rows[0]).toMatchObject({
      rowNumber: 1,
      externalReference: {
        providerKey: "shopify",
        externalKey: "variant:987",
      },
      values: {
        title: "Charizard",
        totalQuantity: "3",
        listingPriceAmount: "15.00",
        listingQuantityCap: "3",
      },
    });
  });

  it("normalizes Whatnot exports into listing and product candidates", () => {
    const rows = whatnotCsvImportAdapter.normalize({
      csvText: "Product ID,Listing ID,SKU,Title,Condition,Quantity,Price\nprod_1,lst_1,box-1,Charizard,Near Mint,1,20",
      quantityMode: "replace",
      defaultStorageLocationId: "loc_1",
    });

    expect(rows[0]?.externalReferences.map((reference) => `${reference.providerKey}:${reference.externalKey}`)).toEqual(
      ["whatnot:product:prod_1", "whatnot:listing:lst_1", "whatnot:sku:box-1"],
    );
  });

  it("normalizes CardTrader exports and reuses cross-provider TCGplayer/Cardmarket ids", () => {
    const rows = cardTraderCsvImportAdapter.normalize({
      csvText:
        "Product ID,Blueprint ID,TCGplayer ID,Cardmarket ID,Name,Expansion,Condition,Quantity,Price\nct_prod_1,ct_bp_1,12345,67890,Charizard,Base Set,Near Mint,4,11.25",
      quantityMode: "replace",
      defaultStorageLocationId: "loc_1",
    });

    expect(rows[0]?.externalReferences.map((reference) => `${reference.providerKey}:${reference.externalKey}`)).toEqual(
      [
        "cardtrader:product:ct_prod_1",
        "cardtrader:blueprint:ct_bp_1",
        "tcgplayer:product:12345",
        "cardmarket:product:67890",
      ],
    );
  });

  it("rejects unsupported source keys at the registry boundary", () => {
    expect(() => getInventoryImportSourceAdapter("unknown")).toThrow("Unsupported inventory import source");
  });
});
