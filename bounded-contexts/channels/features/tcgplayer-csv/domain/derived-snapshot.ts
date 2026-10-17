import {
  tcgplayerLocalSnapshotRowCeiling,
  type ParsedTcgplayerExport,
  type TcgplayerParsedExportRow,
} from "./contracts";
import { tcgplayerLiveExportHeader } from "./profile";
import { assertClosedRecord, assertRfc3339Instant } from "../../connections/domain/validation";
import { ChannelConnectionError } from "../../connections/domain/contracts";

export type DerivedTcgplayerSnapshot = Readonly<{
  parsed: ParsedTcgplayerExport & Readonly<{ surface: "live" }>;
  fileSha256: string;
  capturedAt: string;
}>;

export function assertDerivedTcgplayerSnapshot(
  value: unknown,
  limits: Readonly<{ maxRecords: number; maxBytes: number }>,
): asserts value is DerivedTcgplayerSnapshot {
  if (
    !Number.isSafeInteger(limits.maxRecords) ||
    limits.maxRecords < 1 ||
    limits.maxRecords > tcgplayerLocalSnapshotRowCeiling ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1
  )
    invalid();
  assertClosedRecord(
    value,
    Object.keys({ parsed: true, fileSha256: true, capturedAt: true } satisfies Record<
      keyof DerivedTcgplayerSnapshot,
      true
    >),
    "derived snapshot",
  );
  if (typeof value.fileSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.fileSha256)) invalid();
  assertRfc3339Instant(value.capturedAt, "capturedAt");
  const parsed = value.parsed;
  assertClosedRecord(
    parsed,
    Object.keys({
      kind: true,
      surface: true,
      header: true,
      conditionColumn: true,
      parsedRowCount: true,
      completeness: true,
      rows: true,
    } satisfies Record<keyof ParsedTcgplayerExport, true>),
    "parsed export",
  );
  if (
    parsed.kind !== "parsed" ||
    parsed.surface !== "live" ||
    parsed.completeness !== "unverified" ||
    parsed.conditionColumn !== "present" ||
    !Array.isArray(parsed.header) ||
    parsed.header.length !== tcgplayerLiveExportHeader.length ||
    parsed.header.some((column, index) => column !== tcgplayerLiveExportHeader[index]) ||
    !Array.isArray(parsed.rows) ||
    parsed.rows.length === 0 ||
    parsed.rows.length !== parsed.parsedRowCount ||
    parsed.rows.length > limits.maxRecords
  )
    invalid();
  const identities = new Set<string>();
  let previousRow = 1;
  for (const row of parsed.rows) {
    assertClosedRecord(
      row,
      Object.keys({
        externalKey: true,
        conditionText: true,
        totalQuantity: true,
        pendingQuantityDelta: true,
        priceAmountText: true,
        priceAmountMinor: true,
        referenceColumns: true,
        rowNumber: true,
      } satisfies Record<keyof TcgplayerParsedExportRow, true>),
      "export row",
    );
    text(row.externalKey, limits.maxBytes);
    if (!/^product:[1-9]\d*$/.test(row.externalKey)) invalid();
    if (row.conditionText !== null) text(row.conditionText, limits.maxBytes);
    integer(row.totalQuantity, 0, 1_000_000);
    integer(row.pendingQuantityDelta, -1_000_000, 1_000_000);
    text(row.priceAmountText, limits.maxBytes);
    if (row.priceAmountMinor !== null) integer(row.priceAmountMinor, 0, Number.MAX_SAFE_INTEGER);
    integer(row.rowNumber, previousRow + 1, Number.MAX_SAFE_INTEGER);
    previousRow = row.rowNumber;
    assertClosedRecord(row.referenceColumns, parsed.header, "reference columns");
    for (const field of Object.values(row.referenceColumns)) text(field, limits.maxBytes);
    const identity = JSON.stringify([row.externalKey, row.conditionText]);
    if (identities.has(identity)) invalid();
    identities.add(identity);
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > limits.maxBytes) invalid();
}

function text(value: unknown, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.length > maxLength) invalid();
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) invalid();
  }
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid();
}
function invalid(): never {
  throw new ChannelConnectionError("invalid-input");
}
