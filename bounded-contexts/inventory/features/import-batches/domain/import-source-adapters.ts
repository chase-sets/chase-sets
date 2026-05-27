import { parseImportCsv, type ImportCsvRow } from "./csv";

export type InventoryImportSourceKey =
  | "native-csv"
  | "tcgplayer-csv"
  | "ebay-csv"
  | "shopify-csv"
  | "whatnot-csv"
  | "cardtrader-csv";
export type InventoryImportQuantityMode = "add" | "replace";

export type InventoryImportExternalReference = Readonly<{
  providerKey: string;
  externalKey: string;
  displayName: string | null;
}>;

export type NormalizedInventoryImportRow = Readonly<{
  rowNumber: number;
  values: Readonly<Record<string, string>>;
  rawRow: Readonly<Record<string, string>>;
  externalReference: InventoryImportExternalReference | null;
  externalReferences: readonly InventoryImportExternalReference[];
  rowFingerprint: string;
}>;

export type InventoryImportSourceAdapter = Readonly<{
  sourceKey: InventoryImportSourceKey;
  adapterVersion: number;
  normalize: (
    input: Readonly<{
      csvText?: string;
      parsedRows?: readonly ImportCsvRow[];
      quantityMode: InventoryImportQuantityMode;
      defaultStorageLocationId?: string | null;
    }>,
  ) => readonly NormalizedInventoryImportRow[];
}>;

const SOURCE_LABELS = {
  "native-csv": "Chase Sets CSV",
  "tcgplayer-csv": "TCGplayer CSV",
  "ebay-csv": "eBay CSV",
  "shopify-csv": "Shopify CSV",
  "whatnot-csv": "Whatnot CSV",
  "cardtrader-csv": "CardTrader CSV",
} satisfies Record<InventoryImportSourceKey, string>;

function clean(value: string | undefined | null) {
  return (value ?? "").trim();
}

function normalizeHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function valueByHeader(row: ImportCsvRow, candidates: readonly string[]) {
  const normalizedCandidates = new Set(candidates.map(normalizeHeader));
  const entry = Object.entries(row.values).find(([header]) => normalizedCandidates.has(normalizeHeader(header)));

  return clean(entry?.[1]);
}

function decimalText(value: string) {
  const cleaned = value.replace(/[$,]/g, "").trim();
  return cleaned;
}

function integerText(value: string) {
  return value.replace(/[,]/g, "").trim();
}

function externalReference(
  providerKey: string,
  externalKey: string,
  displayName: string | null,
): InventoryImportExternalReference | null {
  const normalizedProvider = providerKey.trim().toLowerCase();
  const normalizedKey = externalKey.trim().toLowerCase();

  return normalizedProvider && normalizedKey
    ? {
        providerKey: normalizedProvider,
        externalKey: normalizedKey,
        displayName: displayName?.trim() || null,
      }
    : null;
}

function externalReferences(
  displayName: string | null,
  candidates: readonly (readonly [providerKey: string, externalKey: string])[],
) {
  const references = candidates
    .map(([providerKey, externalKey]) => externalReference(providerKey, externalKey, displayName))
    .filter((reference): reference is InventoryImportExternalReference => Boolean(reference));
  const seen = new Set<string>();

  return references.filter((reference) => {
    const key = `${reference.providerKey}:${reference.externalKey}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function fingerprint(
  sourceKey: InventoryImportSourceKey,
  rowNumber: number,
  values: Readonly<Record<string, string>>,
  references: readonly InventoryImportExternalReference[],
) {
  return [
    sourceKey,
    rowNumber,
    references.map((reference) => `${reference.providerKey}:${reference.externalKey}`).join(","),
    values.catalogItemId ?? "",
    values.storageLocationId ?? "",
    values.totalQuantity ?? "",
    values.listingPriceAmount ?? "",
  ].join("|");
}

function nativeRows(input: Parameters<InventoryImportSourceAdapter["normalize"]>[0]) {
  return input.parsedRows ?? parseImportCsv(input.csvText ?? "");
}

export const nativeCsvImportAdapter: InventoryImportSourceAdapter = {
  sourceKey: "native-csv",
  adapterVersion: 1,
  normalize: (input) =>
    nativeRows(input).map((row) => {
      const values = {
        ...row.values,
        storageLocationId: clean(row.values.storageLocationId) || clean(input.defaultStorageLocationId),
      };

      return {
        rowNumber: row.rowNumber,
        values,
        rawRow: row.values,
        externalReference: null,
        externalReferences: [],
        rowFingerprint: fingerprint("native-csv", row.rowNumber, values, []),
      };
    }),
};

export const tcgplayerCsvImportAdapter: InventoryImportSourceAdapter = {
  sourceKey: "tcgplayer-csv",
  adapterVersion: 1,
  normalize: (input) =>
    parseImportCsv(input.csvText ?? "").map((row) => {
      const sku = valueByHeader(row, ["SKU", "TCGplayer SKU", "TCGplayerSku", "Product SKU"]) || "";
      const productId =
        valueByHeader(row, ["Product ID", "ProductId", "TCGplayer Product ID", "TCGplayerProductId", "TCGplayer ID"]) ||
        "";
      const externalKey = (sku || productId).toLowerCase();
      const quantity =
        valueByHeader(row, ["Quantity", "Qty", "Add to Quantity", "Total Quantity", "Inventory Quantity"]) || "";
      const price = decimalText(
        valueByHeader(row, [
          "TCG Marketplace Price",
          "Marketplace Price",
          "My Price",
          "Price",
          "Listing Price",
          "TCG Low Price",
        ]),
      );
      const positiveQuantity = Number(quantity) > 0 ? quantity : "";
      const title = valueByHeader(row, ["Product Name", "Name", "Title"]);
      const setName = valueByHeader(row, ["Set Name", "Set"]);
      const condition = valueByHeader(row, ["Condition", "Printing Condition"]);
      const sellerSku = valueByHeader(row, ["Seller SKU", "SellerSku", "Custom SKU"]);
      const displayName = [title, setName, condition].filter(Boolean).join(" | ") || null;
      const references = externalReferences(displayName, [
        ["tcgplayer", sku],
        ["tcgplayer", productId],
      ]);
      const values = {
        storageLocationId: clean(input.defaultStorageLocationId),
        totalQuantity: quantity,
        sellerSku: sellerSku || sku,
        listingPriceAmount: price,
        listingQuantityCap: positiveQuantity,
        rowNote: [title, setName, condition].filter(Boolean).join(" | "),
        sourcePriceAmount: price,
        sourceQuantity: quantity,
        tcgplayerSku: sku,
        tcgplayerProductId: productId,
      };

      return {
        rowNumber: row.rowNumber,
        values,
        rawRow: row.values,
        externalReference: references[0] ?? null,
        externalReferences:
          references.length > 0 ? references : externalReferences(displayName, [["tcgplayer", externalKey]]),
        rowFingerprint: fingerprint("tcgplayer-csv", row.rowNumber, values, references),
      };
    }),
};

export const ebayCsvImportAdapter: InventoryImportSourceAdapter = {
  sourceKey: "ebay-csv",
  adapterVersion: 1,
  normalize: (input) =>
    parseImportCsv(input.csvText ?? "").map((row) => {
      const itemId = valueByHeader(row, ["Item ID", "ItemId", "Listing ID", "ListingId"]);
      const variationId = valueByHeader(row, ["Variation ID", "VariationId"]);
      const sellerSku = valueByHeader(row, ["Custom label", "Custom Label", "SKU", "Seller SKU", "Inventory SKU"]);
      const epid = valueByHeader(row, ["ePID", "EPID", "Product ID", "Catalog Product ID"]);
      const gtin = valueByHeader(row, ["GTIN", "EAN", "ISBN"]);
      const upc = valueByHeader(row, ["UPC", "Barcode"]);
      const title = valueByHeader(row, ["Title", "Item title", "Product Name"]);
      const condition = valueByHeader(row, ["Condition", "Condition Name"]);
      const quantity = integerText(
        valueByHeader(row, ["Available quantity", "Available Quantity", "Quantity", "Qty", "Available"]),
      );
      const price = decimalText(valueByHeader(row, ["Current price", "Current Price", "Price", "Start price"]));
      const displayName = [title, condition].filter(Boolean).join(" | ") || null;
      const references = externalReferences(displayName, [
        ["ebay", itemId ? `listing:${itemId}` : ""],
        ["ebay", variationId ? `variation:${variationId}` : ""],
        ["ebay", sellerSku ? `sku:${sellerSku}` : ""],
        ["ebay", epid ? `epid:${epid}` : ""],
        ["ebay", gtin ? `gtin:${gtin}` : ""],
        ["ebay", upc ? `upc:${upc}` : ""],
      ]);
      const values = {
        storageLocationId: clean(input.defaultStorageLocationId),
        totalQuantity: quantity,
        sellerSku,
        listingPriceAmount: price,
        listingQuantityCap: Number(quantity) > 0 ? quantity : "",
        rowNote: displayName ?? "",
        sourcePriceAmount: price,
        sourceQuantity: quantity,
        ebayItemId: itemId,
        ebayVariationId: variationId,
        ebayEpid: epid,
        barcode: upc || gtin,
      };

      return {
        rowNumber: row.rowNumber,
        values,
        rawRow: row.values,
        externalReference: references[0] ?? null,
        externalReferences: references,
        rowFingerprint: fingerprint("ebay-csv", row.rowNumber, values, references),
      };
    }),
};

export const shopifyCsvImportAdapter: InventoryImportSourceAdapter = {
  sourceKey: "shopify-csv",
  adapterVersion: 1,
  normalize: (input) =>
    parseImportCsv(input.csvText ?? "").map((row) => {
      const productId = valueByHeader(row, ["Product ID", "ProductId", "ID"]);
      const variantId = valueByHeader(row, ["Variant ID", "VariantId"]);
      const handle = valueByHeader(row, ["Handle"]);
      const title = valueByHeader(row, ["Title", "Product Title"]);
      const variantTitle = valueByHeader(row, ["Variant Title", "Option1 Value", "Option 1 Value"]);
      const sku = valueByHeader(row, ["Variant SKU", "SKU"]);
      const barcode = valueByHeader(row, ["Variant Barcode", "Barcode", "UPC"]);
      const quantity = integerText(
        valueByHeader(row, [
          "Variant Inventory Qty",
          "Available",
          "On hand",
          "New On Hand",
          "Quantity",
          "Inventory Quantity",
        ]),
      );
      const price = decimalText(valueByHeader(row, ["Variant Price", "Price"]));
      const displayName = [title, variantTitle].filter(Boolean).join(" | ") || null;
      const references = externalReferences(displayName, [
        ["shopify", variantId ? `variant:${variantId}` : ""],
        ["shopify", productId ? `product:${productId}` : ""],
        ["shopify", sku ? `sku:${sku}` : ""],
        ["shopify", barcode ? `barcode:${barcode}` : ""],
        ["shopify", handle ? `handle:${handle}` : ""],
      ]);
      const values = {
        storageLocationId: clean(input.defaultStorageLocationId),
        totalQuantity: quantity,
        sellerSku: sku,
        listingPriceAmount: price,
        listingQuantityCap: Number(quantity) > 0 ? quantity : "",
        rowNote: displayName ?? "",
        sourcePriceAmount: price,
        sourceQuantity: quantity,
        shopifyProductId: productId,
        shopifyVariantId: variantId,
        barcode,
      };

      return {
        rowNumber: row.rowNumber,
        values,
        rawRow: row.values,
        externalReference: references[0] ?? null,
        externalReferences: references,
        rowFingerprint: fingerprint("shopify-csv", row.rowNumber, values, references),
      };
    }),
};

export const whatnotCsvImportAdapter: InventoryImportSourceAdapter = {
  sourceKey: "whatnot-csv",
  adapterVersion: 1,
  normalize: (input) =>
    parseImportCsv(input.csvText ?? "").map((row) => {
      const productId = valueByHeader(row, ["Product ID", "ProductId"]);
      const listingId = valueByHeader(row, ["Listing ID", "ListingId", "Item ID"]);
      const inventoryId = valueByHeader(row, ["Inventory ID", "InventoryId"]);
      const sku = valueByHeader(row, ["SKU", "Seller SKU", "Custom SKU"]);
      const title = valueByHeader(row, ["Title", "Product Name", "Name"]);
      const condition = valueByHeader(row, ["Condition"]);
      const quantity = integerText(valueByHeader(row, ["Quantity", "Qty", "Available"]));
      const price = decimalText(valueByHeader(row, ["Price", "Buy It Now Price", "Listing Price"]));
      const displayName = [title, condition].filter(Boolean).join(" | ") || null;
      const references = externalReferences(displayName, [
        ["whatnot", productId ? `product:${productId}` : ""],
        ["whatnot", listingId ? `listing:${listingId}` : ""],
        ["whatnot", inventoryId ? `inventory:${inventoryId}` : ""],
        ["whatnot", sku ? `sku:${sku}` : ""],
      ]);
      const values = {
        storageLocationId: clean(input.defaultStorageLocationId),
        totalQuantity: quantity,
        sellerSku: sku,
        listingPriceAmount: price,
        listingQuantityCap: Number(quantity) > 0 ? quantity : "",
        rowNote: displayName ?? "",
        sourcePriceAmount: price,
        sourceQuantity: quantity,
        whatnotProductId: productId,
        whatnotListingId: listingId,
      };

      return {
        rowNumber: row.rowNumber,
        values,
        rawRow: row.values,
        externalReference: references[0] ?? null,
        externalReferences: references,
        rowFingerprint: fingerprint("whatnot-csv", row.rowNumber, values, references),
      };
    }),
};

export const cardTraderCsvImportAdapter: InventoryImportSourceAdapter = {
  sourceKey: "cardtrader-csv",
  adapterVersion: 1,
  normalize: (input) =>
    parseImportCsv(input.csvText ?? "").map((row) => {
      const productId = valueByHeader(row, ["Product ID", "ProductId", "CardTrader Product ID"]);
      const blueprintId = valueByHeader(row, ["Blueprint ID", "BlueprintId", "CardTrader Blueprint ID"]);
      const articleId = valueByHeader(row, ["Article ID", "ArticleId", "Inventory ID"]);
      const sku = valueByHeader(row, ["SKU", "Seller SKU", "User Data"]);
      const tcgplayerId = valueByHeader(row, ["TCGplayer ID", "TCGplayerId", "TCG Player ID"]);
      const cardmarketId = valueByHeader(row, ["Cardmarket ID", "CardMarket ID", "idProduct"]);
      const title = valueByHeader(row, ["Name", "Title", "Product Name"]);
      const expansion = valueByHeader(row, ["Expansion", "Set Name", "Set"]);
      const condition = valueByHeader(row, ["Condition"]);
      const quantity = integerText(valueByHeader(row, ["Quantity", "Qty", "Available"]));
      const price = decimalText(valueByHeader(row, ["Price", "Selling Price", "Listing Price"]));
      const displayName = [title, expansion, condition].filter(Boolean).join(" | ") || null;
      const references = externalReferences(displayName, [
        ["cardtrader", productId ? `product:${productId}` : ""],
        ["cardtrader", blueprintId ? `blueprint:${blueprintId}` : ""],
        ["cardtrader", articleId ? `article:${articleId}` : ""],
        ["cardtrader", sku ? `sku:${sku}` : ""],
        ["tcgplayer", tcgplayerId],
        ["cardmarket", cardmarketId ? `product:${cardmarketId}` : ""],
      ]);
      const values = {
        storageLocationId: clean(input.defaultStorageLocationId),
        totalQuantity: quantity,
        sellerSku: sku,
        listingPriceAmount: price,
        listingQuantityCap: Number(quantity) > 0 ? quantity : "",
        rowNote: displayName ?? "",
        sourcePriceAmount: price,
        sourceQuantity: quantity,
        cardTraderProductId: productId,
        cardTraderBlueprintId: blueprintId,
        tcgplayerProductId: tcgplayerId,
        cardmarketProductId: cardmarketId,
      };

      return {
        rowNumber: row.rowNumber,
        values,
        rawRow: row.values,
        externalReference: references[0] ?? null,
        externalReferences: references,
        rowFingerprint: fingerprint("cardtrader-csv", row.rowNumber, values, references),
      };
    }),
};

const adapters = {
  "native-csv": nativeCsvImportAdapter,
  "tcgplayer-csv": tcgplayerCsvImportAdapter,
  "ebay-csv": ebayCsvImportAdapter,
  "shopify-csv": shopifyCsvImportAdapter,
  "whatnot-csv": whatnotCsvImportAdapter,
  "cardtrader-csv": cardTraderCsvImportAdapter,
} satisfies Record<InventoryImportSourceKey, InventoryImportSourceAdapter>;

export function getInventoryImportSourceAdapter(sourceKey: string | null | undefined): InventoryImportSourceAdapter {
  const normalized = clean(sourceKey) || "native-csv";
  const adapter = adapters[normalized as InventoryImportSourceKey];
  if (!adapter) {
    throw new Error(`Unsupported inventory import source '${normalized}'.`);
  }

  return adapter;
}

export function inventoryImportSourceLabel(sourceKey: InventoryImportSourceKey) {
  return SOURCE_LABELS[sourceKey];
}
