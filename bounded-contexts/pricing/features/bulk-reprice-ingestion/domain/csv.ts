import { MONEY_AMOUNT_MAX, tryMoneyToCents } from "@chase-sets/primitives/money";

/**
 * CSV/JSON row parsing for bulk reprice ingestion (m113). Intentionally
 * self-contained: this feature directory owns its own tiny RFC4180-ish CSV
 * tokenizer instead of importing Inventory's `import-batches/domain/csv.ts`
 * -- reaching across bounded contexts for a ~30-line parser would violate
 * both the cross-context import rules and this feature's own removability
 * constraint (see ../../../docs/bulk-reprice-ingestion.md). Duplication here is the correct trade.
 */

export type BulkRepriceInputRow = Readonly<{
  rowNumber: number;
  sellerSku: string | null;
  listingId: string | null;
  newPriceAmount: string | null;
  validationErrors: readonly string[];
}>;

export const BULK_REPRICE_CSV_HEADERS = ["sellerSku", "listingId", "newPrice"] as const;

const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/;

export function buildBulkRepriceCsvTemplate(): string {
  const example = ["ABC-123", "", "12.99"];
  return [BULK_REPRICE_CSV_HEADERS, example].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function buildBulkRepriceResultsCsv(
  rows: readonly Readonly<{
    row_number: number;
    seller_sku: string | null;
    listing_id: string | null;
    requested_price_amount: string | null;
    resolved_listing_id: string | null;
    previous_price_amount: string | null;
    outcome: string;
    error_message: string | null;
  }>[],
): string {
  const headers = [
    "rowNumber",
    "sellerSku",
    "listingId",
    "requestedPrice",
    "resolvedListingId",
    "previousPrice",
    "outcome",
    "errorMessage",
  ];
  const csvRows = rows.map((row) => [
    String(row.row_number),
    row.seller_sku ?? "",
    row.listing_id ?? "",
    row.requested_price_amount ?? "",
    row.resolved_listing_id ?? "",
    row.previous_price_amount ?? "",
    row.outcome,
    row.error_message ?? "",
  ]);
  return [headers, ...csvRows].map((row) => row.map(spreadsheetSafeCsvCell).join(",")).join("\n");
}

function validateRow(
  rowNumber: number,
  sellerSkuRaw: string,
  listingIdRaw: string,
  newPriceRaw: string,
): BulkRepriceInputRow {
  const sellerSku = sellerSkuRaw.trim() || null;
  const listingId = listingIdRaw.trim() || null;
  const newPriceAmount = newPriceRaw.trim() || null;
  const validationErrors: string[] = [];

  if (!sellerSku && !listingId) {
    validationErrors.push("Row must include a sellerSku or a listingId.");
  }
  if (!newPriceAmount) {
    validationErrors.push("Row is missing a new price.");
  } else {
    const cents = MONEY_PATTERN.test(newPriceAmount) ? tryMoneyToCents(newPriceAmount) : null;
    if (cents === null || cents <= 0n) {
      validationErrors.push(
        `New price '${newPriceAmount}' is not a valid positive money amount at or below ${MONEY_AMOUNT_MAX}.`,
      );
    }
  }

  return { rowNumber, sellerSku, listingId, newPriceAmount, validationErrors };
}

export function parseBulkRepriceCsv(text: string): readonly BulkRepriceInputRow[] {
  const records = parseRecords(text);
  if (records.length === 0) {
    return [];
  }

  const headers = (records[0] ?? []).map((header) => header.trim().toLowerCase());
  const sellerSkuIndex = headers.indexOf("sellersku");
  const listingIdIndex = headers.indexOf("listingid");
  const newPriceIndex = headers.indexOf("newprice");

  return records.slice(1).flatMap((record, index) => {
    if (record.every((value) => value.trim().length === 0)) {
      return [];
    }

    return [
      validateRow(
        index + 2,
        sellerSkuIndex >= 0 ? (record[sellerSkuIndex] ?? "") : "",
        listingIdIndex >= 0 ? (record[listingIdIndex] ?? "") : "",
        newPriceIndex >= 0 ? (record[newPriceIndex] ?? "") : "",
      ),
    ];
  });
}

export function parseBulkRepriceJsonRows(
  rows: readonly Readonly<{ sellerSku?: unknown; listingId?: unknown; newPriceAmount?: unknown }>[],
): readonly BulkRepriceInputRow[] {
  return rows.map((row, index) =>
    validateRow(
      index + 1,
      typeof row.sellerSku === "string" ? row.sellerSku : "",
      typeof row.listingId === "string" ? row.listingId : "",
      typeof row.newPriceAmount === "string" || typeof row.newPriceAmount === "number"
        ? String(row.newPriceAmount)
        : "",
    ),
  );
}

function csvCell(value: string) {
  if (!/[",\r\n]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/** OWASP spreadsheet-formula neutralization for downloaded result cells. */
function spreadsheetSafeCsvCell(value: string) {
  const safeValue = /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  return csvCell(safeValue);
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

  if (currentValue.length > 0 || currentRecord.length > 0) {
    currentRecord.push(currentValue);
    records.push(currentRecord);
  }

  return records.filter((record) => record.length > 0);
}
