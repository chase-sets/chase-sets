export const heldSetExportContract = Object.freeze({
  maxBytes: 16_777_216,
  maxRows: 100_000,
  multipartMaxBytes: 18_874_368,
  fileField: "file",
  requiredHeaders: Object.freeze(["Product Line", "Set Name"] as const),
} as const);

export const heldSetResolutionReasons = [
  "product-line-unresolved",
  "set-unresolved",
  "set-ambiguous",
  "mapping-missing",
  "mapping-not-accepted",
] as const;

export type HeldSetResolutionReason = (typeof heldSetResolutionReasons)[number];

export type HeldSetPair = Readonly<{
  productLine: string;
  setName: string;
  rowCount: number;
}>;

export type ParsedHeldSetExport = Readonly<{
  pairs: readonly HeldSetPair[];
  totalRows: number;
}>;

export type HeldSetResolution = Readonly<{
  resolved: readonly Readonly<{
    scopeRecordId: string;
    productDomain: "pokemon" | "magic" | "yugioh" | "one-piece" | "lorcana";
    scopeKind: "product-line" | "series" | "expansion" | "set";
    productLine: string;
    setName: string;
    rowCount: number;
  }>[];
  unresolved: readonly Readonly<{
    productLine: string;
    setName: string;
    rowCount: number;
    reason: HeldSetResolutionReason;
    productDomain: "pokemon" | "magic" | "yugioh" | "one-piece" | "lorcana" | null;
  }>[];
  totals: Readonly<{
    rows: number;
    distinctPairs: number;
    resolvedPairs: number;
    unresolvedPairs: number;
    resolvedRows: number;
    unresolvedRows: number;
  }>;
}>;

export class HeldSetExportError extends Error {
  public constructor(
    public readonly code: "invalid-upload" | "upload-too-large" | "row-limit-exceeded" | "missing-required-columns",
    message: string,
  ) {
    super(message);
    this.name = "HeldSetExportError";
  }
}

export function normalizeHeldSetLabel(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function displayHeldSetLabel(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function parseHeldSetExport(bytes: Uint8Array): ParsedHeldSetExport {
  if (bytes.byteLength > heldSetExportContract.maxBytes) {
    throw new HeldSetExportError("upload-too-large", "Held-set export exceeds 16777216 bytes.");
  }

  let csv: string;
  try {
    csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HeldSetExportError("invalid-upload", "Held-set export must be UTF-8 CSV.");
  }

  const validationRows = parseCsvRows(csv);
  const header = validationRows.next();
  if (header.done) {
    throw new HeldSetExportError(
      "missing-required-columns",
      "Held-set export must include Product Line and Set Name columns.",
    );
  }
  if (header.value.length > 0) header.value[0] = header.value[0]!.replace(/^\uFEFF/u, "");
  const productLineIndexes = indexesOf(header.value, "Product Line");
  const setNameIndexes = indexesOf(header.value, "Set Name");
  if (productLineIndexes.length !== 1 || setNameIndexes.length !== 1) {
    throw new HeldSetExportError(
      "missing-required-columns",
      "Held-set export must include Product Line and Set Name exactly once.",
    );
  }

  let totalRows = 0;
  for (const _row of validationRows) {
    totalRows += 1;
    if (totalRows > heldSetExportContract.maxRows) {
      throw new HeldSetExportError("row-limit-exceeded", "Held-set export exceeds 100000 logical rows.");
    }
  }

  const pairs = new Map<string, HeldSetPair>();
  const dataRows = parseCsvRows(csv);
  dataRows.next();
  for (const row of dataRows) {
    const productLine = displayHeldSetLabel(row[productLineIndexes[0]!] ?? "");
    const setName = displayHeldSetLabel(row[setNameIndexes[0]!] ?? "");
    const key = `${normalizeHeldSetLabel(productLine)}\u0000${normalizeHeldSetLabel(setName)}`;
    const existing = pairs.get(key);
    pairs.set(key, existing ? { ...existing, rowCount: existing.rowCount + 1 } : { productLine, setName, rowCount: 1 });
  }

  return {
    totalRows,
    pairs: [...pairs.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, pair]) => pair),
  };
}

function indexesOf(values: readonly string[], expected: string): number[] {
  const indexes: number[] = [];
  values.forEach((value, index) => {
    if (value === expected) indexes.push(index);
  });
  return indexes;
}

function* parseCsvRows(csv: string): Generator<string[]> {
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  let hasRecordContent = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        cell += character;
      }
      hasRecordContent = true;
      continue;
    }

    if (character === '"') {
      if (cell.length > 0 || closedQuote) invalidCsv();
      quoted = true;
      hasRecordContent = true;
      continue;
    }
    if (character === ",") {
      row.push(cell);
      cell = "";
      closedQuote = false;
      hasRecordContent = true;
      continue;
    }
    if (character === "\r" || character === "\n") {
      row.push(cell);
      yield row;
      row = [];
      cell = "";
      closedQuote = false;
      hasRecordContent = false;
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      continue;
    }
    if (closedQuote) invalidCsv();
    cell += character;
    hasRecordContent = true;
  }

  if (quoted) invalidCsv();
  if (hasRecordContent || row.length > 0 || cell.length > 0) {
    row.push(cell);
    yield row;
  }
}

function invalidCsv(): never {
  throw new HeldSetExportError("invalid-upload", "Held-set export contains malformed CSV.");
}
