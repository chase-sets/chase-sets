export type ImportCsvRow = Readonly<{
  rowNumber: number;
  values: Readonly<Record<string, string>>;
}>;

export type NativeInventoryImportTemplateStorageLocation = Readonly<{
  storage_location_id: string;
  name: string;
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
