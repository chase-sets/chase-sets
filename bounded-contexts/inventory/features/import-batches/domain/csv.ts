export type ImportCsvRow = Readonly<{
  rowNumber: number;
  values: Readonly<Record<string, string>>;
}>;

export type NativeInventoryImportTemplateStorageLocation = Readonly<{
  storage_location_id: string;
  name: string;
}>;

export type NativeInventoryExportRow = Readonly<{
  catalog_item_id: string;
  storage_location_id: string;
  total_quantity: number;
  selected_options: readonly Readonly<{
    dimensionId: string;
    optionId: string;
  }>[];
  acquisition_cost_amount: string | null;
  seller_sku?: string | null;
  listing_price_amount?: string | null;
  listing_quantity_cap?: number | null;
  row_note?: string | null;
}>;

export const nativeInventoryImportCsvTemplateHeaders = [
  "catalogItemId",
  "storageLocationId",
  "totalQuantity",
  "option:form",
  "option:condition",
  "acquisitionCostAmount",
  "sellerSku",
  "listingPriceAmount",
  "listingQuantityCap",
  "rowNote",
] as const;

export function buildNativeInventoryImportCsvTemplate(
  storageLocations: readonly NativeInventoryImportTemplateStorageLocation[],
) {
  const rows = storageLocations.map((location) => [
    "cat_example",
    location.storage_location_id,
    "1",
    "Raw",
    "Near Mint",
    "",
    "",
    "",
    "",
    `Example for ${location.name}`,
  ]);

  return [nativeInventoryImportCsvTemplateHeaders, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function buildNativeInventoryExportCsv(rows: readonly NativeInventoryExportRow[]) {
  const optionColumns = nativeInventoryExportOptionColumns(rows);
  const headers = [
    "catalogItemId",
    "storageLocationId",
    "totalQuantity",
    ...optionColumns.map((dimensionId) => `option:${dimensionId}`),
    "acquisitionCostAmount",
    "sellerSku",
    "listingPriceAmount",
    "listingQuantityCap",
    "rowNote",
  ];

  const csvRows = rows.map((row) => {
    const selectedOptions = new Map(row.selected_options.map((option) => [option.dimensionId, option.optionId]));
    return [
      row.catalog_item_id,
      row.storage_location_id,
      String(row.total_quantity),
      ...optionColumns.map((dimensionId) => selectedOptions.get(dimensionId) ?? ""),
      row.acquisition_cost_amount ?? "",
      row.seller_sku ?? "",
      row.listing_price_amount ?? "",
      row.listing_quantity_cap == null ? "" : String(row.listing_quantity_cap),
      row.row_note ?? "",
    ];
  });

  return [headers, ...csvRows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function parseImportCsv(text: string): ImportCsvRow[] {
  const records = parseRecords(text);
  if (records.length === 0) {
    return [];
  }

  const headers = records[0]?.map((header) => header.trim()) ?? [];
  return records.slice(1).flatMap((record, index) => {
    if (record.every((value) => value.trim().length === 0)) {
      return [];
    }

    const values: Record<string, string> = {};
    headers.forEach((header, headerIndex) => {
      if (header.length > 0) {
        values[header] = record[headerIndex]?.trim() ?? "";
      }
    });

    return [{ rowNumber: index + 2, values }];
  });
}

function nativeInventoryExportOptionColumns(rows: readonly NativeInventoryExportRow[]) {
  const dimensionIds: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    for (const option of row.selected_options) {
      const dimensionId = option.dimensionId.trim();
      if (dimensionId.length > 0 && !seen.has(dimensionId)) {
        seen.add(dimensionId);
        dimensionIds.push(dimensionId);
      }
    }
  }

  return dimensionIds;
}

function csvCell(value: string) {
  if (!/[",\r\n]/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let currentRecord: string[] = [];
  let currentValue = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentValue += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      currentRecord.push(currentValue);
      currentValue = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      currentRecord.push(currentValue);
      records.push(currentRecord);
      currentRecord = [];
      currentValue = "";
      continue;
    }

    currentValue += char;
  }

  currentRecord.push(currentValue);
  records.push(currentRecord);
  return records.filter((record) => record.some((value) => value.trim().length > 0));
}
