import {
  type ChannelExportSchemaPin,
  type ChannelExportSurface,
  type ParsedTcgplayerExport,
  type TcgplayerExportIngestLimits,
  type TcgplayerExportParseResult,
  type TcgplayerParsedExportRow,
  type TcgplayerRowRefusalReason,
} from "./contracts";
import { tcgplayerExportSchemaDescriptors } from "./profile";
import { assertTcgplayerExportIngestLimits } from "./validation";

type TokenizedCsv =
  | Readonly<{ kind: "records"; records: readonly (readonly string[])[] }>
  | Readonly<{ kind: "refused"; reason: TcgplayerRowRefusalReason }>;

export function parseTcgplayerMoneyToMinorUnits(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (
    fraction
      .slice(2)
      .split("")
      .some((digit) => digit !== "0")
  )
    return null;
  const minorText = `${whole}${fraction.padEnd(2, "0").slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  const minor = Number(minorText || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

export function formatTcgplayerMinorUnits(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("TCGplayer minor units must be a non-negative safe integer.");
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

export function parseTcgplayerFullExport(
  input: Readonly<{
    csv: string;
    surface: ChannelExportSurface;
    pinnedSchema?: ChannelExportSchemaPin | null;
  }>,
  limits: TcgplayerExportIngestLimits,
): TcgplayerExportParseResult {
  try {
    assertTcgplayerExportIngestLimits(limits);
    assertParseInput(input);
  } catch {
    return { kind: "refused", reason: "invalid-input" };
  }
  const tokenized = tokenizeLogicalRecords(input.csv, limits.maxRecords);
  if (tokenized.kind === "refused") return tokenized;
  const [header, ...records] = tokenized.records;
  if (!header || records.length === 0) return { kind: "refused", reason: "empty-export" };
  if (new Set(header).size !== header.length) return { kind: "refused", reason: "header-duplicate-column" };

  const descriptor = tcgplayerExportSchemaDescriptors.find((candidate) => candidate.surface === input.surface)!;
  if (descriptor.requiredColumns.some((column) => !header.includes(column))) {
    return { kind: "refused", reason: "header-missing-required-column" };
  }
  const expectedHeader = input.surface === "live" ? descriptor.fixedHeader : input.pinnedSchema?.header;
  if (expectedHeader && !arraysEqual(header, expectedHeader)) return { kind: "refused", reason: "header-mismatch" };

  const conditionColumn = header.includes("Condition") ? "present" : "absent";
  if (input.pinnedSchema && input.pinnedSchema.conditionColumn !== conditionColumn) {
    return { kind: "refused", reason: "header-mismatch" };
  }
  const positions = new Map(header.map((column, index) => [column, index]));
  const rows: TcgplayerParsedExportRow[] = [];
  const identities = new Set<string>();
  for (const [index, fields] of records.entries()) {
    if (fields.length !== header.length) return { kind: "refused", reason: "row-width-mismatch" };
    const rawId = fields[positions.get("TCGplayer Id")!]!;
    if (!/^[1-9]\d*$/.test(rawId)) return { kind: "refused", reason: "invalid-input" };
    const totalQuantity = parseInteger(fields[positions.get("Total Quantity")!]!, 0, 1_000_000);
    const pendingQuantityDelta = parseInteger(fields[positions.get("Add to Quantity")!]!, -1_000_000, 1_000_000);
    if (totalQuantity === null || pendingQuantityDelta === null) return { kind: "refused", reason: "invalid-integer" };
    const conditionText = conditionColumn === "present" ? fields[positions.get("Condition")!]! || null : null;
    const externalKey = `product:${rawId}`;
    const identity = `${externalKey}\u0000${conditionText ?? ""}`;
    if (identities.has(identity)) return { kind: "refused", reason: "duplicate-row-identity" };
    identities.add(identity);
    const priceAmountText = fields[positions.get("TCG Marketplace Price")!]!;
    const referenceColumns = Object.fromEntries(
      header.flatMap((column, columnIndex) =>
        column === "Add to Quantity" || column === "TCG Marketplace Price" ? [] : [[column, fields[columnIndex]!]],
      ),
    );
    rows.push({
      externalKey,
      conditionText,
      totalQuantity,
      pendingQuantityDelta,
      priceAmountText,
      priceAmountMinor: parseTcgplayerMoneyToMinorUnits(priceAmountText),
      referenceColumns,
      rowNumber: index + 2,
    });
  }
  const parsed: ParsedTcgplayerExport = {
    kind: "parsed",
    surface: input.surface,
    header,
    conditionColumn,
    parsedRowCount: rows.length,
    completeness: "unverified",
    rows,
  };
  return parsed;
}

export function serializeCsv(header: readonly string[], rows: readonly Readonly<Record<string, string>>[]): string {
  return [header, ...rows.map((row) => header.map((column) => row[column] ?? ""))]
    .map((record) => record.map(quoteCsvField).join(","))
    .join("\r\n");
}

function tokenizeLogicalRecords(input: string, maxRecords: number): TokenizedCsv {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  const finishRecord = (): TcgplayerRowRefusalReason | null => {
    record.push(field);
    records.push(record);
    record = [];
    field = "";
    quoteClosed = false;
    return records.length - 1 > maxRecords ? "record-limit-exceeded" : null;
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (quoteClosed && character !== "," && character !== "\r" && character !== "\n") {
      return { kind: "refused", reason: "invalid-input" };
    }
    if (character === '"') {
      if (field.length !== 0) return { kind: "refused", reason: "invalid-input" };
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
      quoteClosed = false;
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      const refusal = finishRecord();
      if (refusal) return { kind: "refused", reason: refusal };
    } else {
      field += character;
    }
  }
  if (quoted) return { kind: "refused", reason: "unterminated-quoted-field" };
  if (field.length > 0 || record.length > 0 || quoteClosed) {
    const refusal = finishRecord();
    if (refusal) return { kind: "refused", reason: refusal };
  }
  return { kind: "records", records };
}

function quoteCsvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function parseInteger(value: string, min: number, max: number): number | null {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertParseInput(value: unknown): asserts value is Readonly<{
  csv: string;
  surface: ChannelExportSurface;
  pinnedSchema?: ChannelExportSchemaPin | null;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Parse input is invalid.");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !["csv", "surface", "pinnedSchema"].includes(key)) ||
    typeof record.csv !== "string" ||
    (record.surface !== "live" && record.surface !== "staged")
  ) {
    throw new Error("Parse input is invalid.");
  }
  if (record.pinnedSchema === undefined || record.pinnedSchema === null) return;
  if (typeof record.pinnedSchema !== "object" || Array.isArray(record.pinnedSchema)) {
    throw new Error("Pinned schema is invalid.");
  }
  const pin = record.pinnedSchema as Record<string, unknown>;
  const keys = [
    "connectionId",
    "providerKey",
    "surface",
    "header",
    "conditionColumn",
    "pinnedFromSnapshotId",
    "pinnedAt",
  ];
  if (
    Object.keys(pin).length !== keys.length ||
    Object.keys(pin).some((key) => !keys.includes(key)) ||
    typeof pin.connectionId !== "string" ||
    pin.providerKey !== "tcgplayer" ||
    pin.surface !== record.surface ||
    !Array.isArray(pin.header) ||
    pin.header.length === 0 ||
    !pin.header.every((column) => typeof column === "string") ||
    (pin.conditionColumn !== "present" && pin.conditionColumn !== "absent") ||
    typeof pin.pinnedFromSnapshotId !== "string" ||
    typeof pin.pinnedAt !== "string" ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(pin.pinnedAt) ||
    Number.isNaN(Date.parse(pin.pinnedAt))
  ) {
    throw new Error("Pinned schema is invalid.");
  }
}
