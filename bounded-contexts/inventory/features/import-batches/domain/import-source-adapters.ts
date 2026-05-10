import { parseImportCsv, type ImportCsvRow } from "./csv";

export type InventoryImportSourceKey = "native-csv" | "tcgplayer-csv";
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
} satisfies Record<InventoryImportSourceKey, string>;

function clean(value: string | undefined | null) {
  return (value ?? "").trim();
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueByHeader(row: ImportCsvRow, candidates: readonly string[]) {
  const normalizedCandidates = new Set(candidates.map(normalizeHeader));
  const entry = Object.entries(row.values).find(([header]) =>
    normalizedCandidates.has(normalizeHeader(header)),
  );

  return clean(entry?.[1]);
}

function decimalText(value: string) {
  const cleaned = value.replace(/[$,]/g, "").trim();
  return cleaned;
}

function fingerprint(
  sourceKey: InventoryImportSourceKey,
  rowNumber: number,
  values: Readonly<Record<string, string>>,
  externalReference: InventoryImportExternalReference | null,
) {
  return [
    sourceKey,
    rowNumber,
    externalReference?.providerKey ?? "",
    externalReference?.externalKey ?? "",
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
        storageLocationId:
          clean(row.values.storageLocationId) || clean(input.defaultStorageLocationId),
      };

      return {
        rowNumber: row.rowNumber,
        values,
        rawRow: row.values,
        externalReference: null,
        rowFingerprint: fingerprint("native-csv", row.rowNumber, values, null),
      };
    }),
};

export const tcgplayerCsvImportAdapter: InventoryImportSourceAdapter = {
  sourceKey: "tcgplayer-csv",
  adapterVersion: 1,
  normalize: (input) =>
    parseImportCsv(input.csvText ?? "").map((row) => {
      const sku =
        valueByHeader(row, [
          "SKU",
          "TCGplayer SKU",
          "TCGplayerSku",
          "Product SKU",
        ]) || "";
      const productId =
        valueByHeader(row, [
          "Product ID",
          "ProductId",
          "TCGplayer Product ID",
          "TCGplayerProductId",
          "TCGplayer ID",
        ]) || "";
      const externalKey = (sku || productId).toLowerCase();
      const quantity =
        valueByHeader(row, [
          "Quantity",
          "Qty",
          "Add to Quantity",
          "Total Quantity",
          "Inventory Quantity",
        ]) || "";
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
      const externalReference = externalKey
        ? {
            providerKey: "tcgplayer",
            externalKey,
            displayName: [title, setName, condition].filter(Boolean).join(" | ") || null,
          }
        : null;

      return {
        rowNumber: row.rowNumber,
        values,
        rawRow: row.values,
        externalReference,
        rowFingerprint: fingerprint("tcgplayer-csv", row.rowNumber, values, externalReference),
      };
    }),
};

const adapters = {
  "native-csv": nativeCsvImportAdapter,
  "tcgplayer-csv": tcgplayerCsvImportAdapter,
} satisfies Record<InventoryImportSourceKey, InventoryImportSourceAdapter>;

export function getInventoryImportSourceAdapter(
  sourceKey: string | null | undefined,
): InventoryImportSourceAdapter {
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
