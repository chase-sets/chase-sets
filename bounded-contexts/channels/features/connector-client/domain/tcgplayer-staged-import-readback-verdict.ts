export const tcgplayerStagedImportReadbackLimits = Object.freeze({ maxBytes: 1_048_576, maxRows: 512 });

export type TcgplayerStagedImportReadbackRow = Readonly<{
  id: string;
  sellerColumns: Readonly<Record<string, string>>;
  marketColumns: Readonly<Record<string, string>>;
}>;

export type TcgplayerStagedImportReadback = Readonly<{
  rows: readonly TcgplayerStagedImportReadbackRow[];
  completeness:
    | Readonly<{ kind: "complete"; expectedRows: number }>
    | Readonly<{ kind: "incomplete"; reason: "partial" | "missing" }>
    | Readonly<{ kind: "overflow" }>
    | null;
}>;

export type TcgplayerStagedImportReadbackAuthority = Readonly<{
  origin: "worker" | "page";
  method: "GET";
  path: string;
  status: number;
  contentType: string;
}>;

export type TcgplayerStagedImportReadbackMember = Readonly<{
  externalKey: string;
  basisTotalQuantity: number;
  basisPriceAmountMinor: number;
  csvRow: Readonly<{ "Add to Quantity": string; "TCG Marketplace Price": string }>;
}>;

export type TcgplayerStagedImportReadbackVerdict =
  | Readonly<{ kind: "applied"; counts: Readonly<{ preRows: number; postRows: number; members: number }> }>
  | Readonly<{
      kind: "outcome-unknown";
      reason:
        | "missing-completeness-discriminator"
        | "incomplete-readback"
        | "overflow-readback"
        | "authority-unavailable"
        | "id-set-changed"
        | "member-projection-mismatch"
        | "non-member-drift";
      counts: Readonly<{ preRows: number; postRows: number; members: number }>;
    }>
  | Readonly<{ kind: "basis-diverged"; counts: Readonly<{ preRows: number; postRows: number; members: number }> }>;

export type TcgplayerStagedImportPreflight =
  | Readonly<{ kind: "proceed"; counts: Readonly<{ preRows: number; members: number }> }>
  | Readonly<{ kind: "basis-diverged"; counts: Readonly<{ preRows: number; members: number }> }>
  | Readonly<{
      kind: "outcome-unknown";
      reason:
        | "missing-completeness-discriminator"
        | "incomplete-readback"
        | "overflow-readback"
        | "member-projection-mismatch";
      counts: Readonly<{ preRows: number; members: number }>;
    }>;

export class TcgplayerStagedImportReadbackError extends Error {
  constructor(readonly code: "invalid-record") {
    super(`staged-import-readback-${code}`);
  }
}

const marketColumns = new Set([
  "TCG Market Price",
  "TCG Direct Low",
  "TCG Low Price With Shipping",
  "TCG Low Price",
  "Photo URL",
]);
const composedRowColumns = new Set([
  "TCGplayer Id",
  "Product Line",
  "Set Name",
  "Product Name",
  "Title",
  "Number",
  "Rarity",
  "Condition",
  "TCG Market Price",
  "TCG Direct Low",
  "TCG Low Price With Shipping",
  "TCG Low Price",
  "Total Quantity",
  "Add to Quantity",
  "TCG Marketplace Price",
  "Photo URL",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function idOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.startsWith("product:") ? value.slice("product:".length) : value;
  return /^\d+$/.test(id) ? id : null;
}

function decodeStringRecord(value: unknown, stripMarket: boolean): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) return null;
  const columns: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    if (stripMarket && marketColumns.has(key)) continue;
    columns[key] = entry;
  }
  return Object.freeze(columns);
}

function decodeRows(rows: unknown, maxRows: number): readonly TcgplayerStagedImportReadbackRow[] | "overflow" | null {
  if (!Array.isArray(rows)) return null;
  if (rows.length > maxRows) return "overflow";
  const ids = new Set<string>();
  const decoded: TcgplayerStagedImportReadbackRow[] = [];
  for (const value of rows) {
    if (!isRecord(value) || !exactKeys(value, ["id", "sellerColumns"], ["marketColumns"])) return null;
    const id = idOf(value.id);
    const sellerColumns = decodeStringRecord(value.sellerColumns, true);
    const market = value.marketColumns === undefined ? {} : decodeStringRecord(value.marketColumns, false);
    if (!id || !sellerColumns || !market || ids.has(id)) return null;
    ids.add(id);
    decoded.push({ id, sellerColumns, marketColumns: market });
  }
  return Object.freeze(decoded);
}

export function decodeTcgplayerStagedImportReadback(
  input: unknown,
  limits: Readonly<{ maxRows?: number }> = {},
): TcgplayerStagedImportReadback {
  if (!isRecord(input) || !exactKeys(input, ["rows", "completeness"]))
    throw new TcgplayerStagedImportReadbackError("invalid-record");
  const rows = decodeRows(input.rows, limits.maxRows ?? tcgplayerStagedImportReadbackLimits.maxRows);
  if (rows === "overflow") return Object.freeze({ rows: [], completeness: { kind: "overflow" } });
  if (!rows) throw new TcgplayerStagedImportReadbackError("invalid-record");
  const completeness = input.completeness;
  if (completeness === null) return Object.freeze({ rows, completeness: null });
  if (!isRecord(completeness) || typeof completeness.kind !== "string")
    throw new TcgplayerStagedImportReadbackError("invalid-record");
  if (completeness.kind === "overflow" && exactKeys(completeness, ["kind"]))
    return Object.freeze({ rows: [], completeness: { kind: "overflow" } });
  if (
    completeness.kind === "incomplete" &&
    exactKeys(completeness, ["kind", "reason"]) &&
    (completeness.reason === "partial" || completeness.reason === "missing")
  )
    return Object.freeze({ rows, completeness: { kind: "incomplete", reason: completeness.reason } });
  if (
    completeness.kind === "complete" &&
    exactKeys(completeness, ["kind", "expectedRows"]) &&
    typeof completeness.expectedRows === "number" &&
    Number.isSafeInteger(completeness.expectedRows) &&
    completeness.expectedRows >= 0
  )
    return Object.freeze({ rows, completeness: { kind: "complete", expectedRows: completeness.expectedRows } });
  throw new TcgplayerStagedImportReadbackError("invalid-record");
}

function parseCsv(input: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  let saw = false;
  const pushRecord = () => {
    if (saw || record.length > 0 || field.length > 0) records.push([...record, field]);
    record = [];
    field = "";
    saw = false;
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
          afterQuote = true;
        }
      } else field += character;
      saw = true;
      continue;
    }
    if (afterQuote) {
      if (character === ",") {
        record.push(field);
        field = "";
        afterQuote = false;
        continue;
      }
      if (character === "\r" || character === "\n") {
        afterQuote = false;
        if (character === "\r" && input[index + 1] === "\n") index += 1;
        pushRecord();
        continue;
      }
      throw new TcgplayerStagedImportReadbackError("invalid-record");
    }
    if (character === '"') {
      if (field.length !== 0) throw new TcgplayerStagedImportReadbackError("invalid-record");
      quoted = true;
      saw = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
      saw = true;
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      pushRecord();
    } else {
      field += character;
      saw = true;
    }
  }
  if (quoted) throw new TcgplayerStagedImportReadbackError("invalid-record");
  if (afterQuote || saw || record.length > 0 || field.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** Parse RFC 4180 CSV; the completeness discriminator stays caller-supplied. */
export function parseTcgplayerStagedImportReadback(
  input: string,
  limits: Readonly<{ maxBytes?: number; maxRows?: number }> = {},
): TcgplayerStagedImportReadback {
  const maxBytes = limits.maxBytes ?? tcgplayerStagedImportReadbackLimits.maxBytes;
  if (new TextEncoder().encode(input).byteLength > maxBytes)
    return Object.freeze({ rows: [], completeness: { kind: "overflow" } });
  const records = parseCsv(input);
  if (records.length < 2) return Object.freeze({ rows: [], completeness: { kind: "incomplete", reason: "missing" } });
  const header = records[0]!;
  if (header.length === 0 || header.some((column) => column.length === 0) || new Set(header).size !== header.length)
    throw new TcgplayerStagedImportReadbackError("invalid-record");
  const positions = new Map(header.map((key, index) => [key, index]));
  if (!positions.has("TCGplayer Id")) throw new TcgplayerStagedImportReadbackError("invalid-record");
  const rows = records.slice(1).map((fields) => {
    if (fields.length !== header.length) throw new TcgplayerStagedImportReadbackError("invalid-record");
    const id = fields[positions.get("TCGplayer Id")!]!;
    if (!idOf(id)) throw new TcgplayerStagedImportReadbackError("invalid-record");
    const sellerColumns: Record<string, string> = {};
    const marketColumnsOut: Record<string, string> = {};
    for (const [key, index] of positions) {
      const value = fields[index]!;
      if (marketColumns.has(key)) marketColumnsOut[key] = value;
      else sellerColumns[key] = value;
    }
    return { id, sellerColumns, marketColumns: marketColumnsOut };
  });
  return decodeTcgplayerStagedImportReadback({ rows, completeness: null }, { maxRows: limits.maxRows });
}

function count(pre: TcgplayerStagedImportReadback, post: TcgplayerStagedImportReadback, members: readonly unknown[]) {
  return { preRows: pre.rows.length, postRows: post.rows.length, members: members.length };
}

function decodeMember(value: unknown): TcgplayerStagedImportReadbackMember | null {
  if (!isRecord(value) || !exactKeys(value, ["externalKey", "basisTotalQuantity", "basisPriceAmountMinor", "csvRow"]))
    return null;
  const csv = isRecord(value.csvRow) ? value.csvRow : null;
  if (
    !idOf(value.externalKey) ||
    typeof value.basisTotalQuantity !== "number" ||
    !Number.isSafeInteger(value.basisTotalQuantity) ||
    value.basisTotalQuantity < 0 ||
    typeof value.basisPriceAmountMinor !== "number" ||
    !Number.isSafeInteger(value.basisPriceAmountMinor) ||
    value.basisPriceAmountMinor < 0 ||
    !csv ||
    !Object.hasOwn(csv, "Add to Quantity") ||
    !Object.hasOwn(csv, "TCG Marketplace Price") ||
    Object.keys(csv).some((key) => !composedRowColumns.has(key)) ||
    Object.values(csv).some((entry) => typeof entry !== "string") ||
    typeof csv["Add to Quantity"] !== "string" ||
    !/^-?\d+$/.test(csv["Add to Quantity"]) ||
    typeof csv["TCG Marketplace Price"] !== "string" ||
    !/^\d+(?:\.\d{1,2})?$/.test(csv["TCG Marketplace Price"])
  )
    return null;
  const addToQuantity = csv["Add to Quantity"];
  const marketplacePrice = csv["TCG Marketplace Price"];
  if (typeof addToQuantity !== "string" || typeof marketplacePrice !== "string") return null;
  const externalKey = value.externalKey;
  const basisTotalQuantity = value.basisTotalQuantity;
  const basisPriceAmountMinor = value.basisPriceAmountMinor;
  if (
    typeof externalKey !== "string" ||
    typeof basisTotalQuantity !== "number" ||
    typeof basisPriceAmountMinor !== "number"
  )
    return null;
  return {
    externalKey,
    basisTotalQuantity,
    basisPriceAmountMinor,
    csvRow: {
      "Add to Quantity": addToQuantity,
      "TCG Marketplace Price": marketplacePrice,
    },
  };
}

function decodeMembers(value: readonly unknown[]): readonly TcgplayerStagedImportReadbackMember[] | null {
  if (value.length === 0) return null;
  const decoded = value.map(decodeMember);
  if (decoded.some((member) => member === null)) return null;
  const ids = new Set(decoded.map((member) => idOf(member!.externalKey)));
  if (ids.size !== decoded.length) return null;
  return decoded as readonly TcgplayerStagedImportReadbackMember[];
}

function complete(readback: TcgplayerStagedImportReadback): "ok" | "missing" | "incomplete" | "overflow" {
  if (!readback.completeness) return "missing";
  if (readback.completeness.kind === "overflow") return "overflow";
  if (readback.completeness.kind === "incomplete") return "incomplete";
  return readback.completeness.expectedRows === readback.rows.length && readback.rows.length > 0 ? "ok" : "incomplete";
}

function minor(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
}

function basisMatches(row: TcgplayerStagedImportReadbackRow, member: TcgplayerStagedImportReadbackMember): boolean {
  return (
    row.sellerColumns["Total Quantity"] === String(member.basisTotalQuantity) &&
    row.sellerColumns["Add to Quantity"] === "0" &&
    minor(row.sellerColumns["TCG Marketplace Price"] ?? "") === member.basisPriceAmountMinor
  );
}

export function preflightTcgplayerStagedImport(
  pre: TcgplayerStagedImportReadback,
  members: readonly unknown[],
): TcgplayerStagedImportPreflight {
  const state = complete(pre);
  const counts = { preRows: pre.rows.length, members: members.length };
  if (state === "missing") return { kind: "outcome-unknown", reason: "missing-completeness-discriminator", counts };
  if (state === "overflow") return { kind: "outcome-unknown", reason: "overflow-readback", counts };
  if (state === "incomplete") return { kind: "outcome-unknown", reason: "incomplete-readback", counts };
  const decoded = decodeMembers(members);
  if (!decoded) return { kind: "outcome-unknown", reason: "member-projection-mismatch", counts };
  const rows = new Map(pre.rows.map((row) => [row.id, row]));
  for (const member of decoded) {
    const row = rows.get(idOf(member.externalKey)!);
    if (!row || !basisMatches(row, member)) return { kind: "basis-diverged", counts };
  }
  return { kind: "proceed", counts };
}

function sellerEqual(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function expectedMemberRow(
  pre: TcgplayerStagedImportReadbackRow,
  member: TcgplayerStagedImportReadbackMember,
): Record<string, string> {
  const expected = { ...pre.sellerColumns };
  const delta = Number(member.csvRow["Add to Quantity"]);
  const total = Number(expected["Total Quantity"]);
  if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(total)) return {};
  expected["Total Quantity"] = String(total + delta);
  expected["Add to Quantity"] = member.csvRow["Add to Quantity"];
  expected["TCG Marketplace Price"] = member.csvRow["TCG Marketplace Price"];
  return expected;
}

export function deriveTcgplayerStagedImportReadbackVerdict(
  input: Readonly<{
    pre: TcgplayerStagedImportReadback;
    post: TcgplayerStagedImportReadback;
    members: readonly unknown[];
    authority: TcgplayerStagedImportReadbackAuthority;
  }>,
): TcgplayerStagedImportReadbackVerdict {
  const counts = count(input.pre, input.post, input.members);
  const preState = complete(input.pre);
  const postState = complete(input.post);
  if (preState === "missing" || postState === "missing")
    return { kind: "outcome-unknown", reason: "missing-completeness-discriminator", counts };
  if (preState === "overflow" || postState === "overflow")
    return { kind: "outcome-unknown", reason: "overflow-readback", counts };
  if (preState === "incomplete" || postState === "incomplete")
    return { kind: "outcome-unknown", reason: "incomplete-readback", counts };
  if (
    input.authority.origin !== "worker" ||
    input.authority.method !== "GET" ||
    input.authority.path !== "/Admin/Pricing/DownloadStagedInventoryExportCSV" ||
    input.authority.status !== 200 ||
    !input.authority.contentType.toLowerCase().startsWith("text/csv")
  )
    return { kind: "outcome-unknown", reason: "authority-unavailable", counts };
  const preflight = preflightTcgplayerStagedImport(input.pre, input.members);
  if (preflight.kind === "basis-diverged") return { kind: "basis-diverged", counts };
  if (preflight.kind === "outcome-unknown") return { kind: "outcome-unknown", reason: preflight.reason, counts };
  const decoded = decodeMembers(input.members)!;
  const preRows = new Map(input.pre.rows.map((row) => [row.id, row]));
  const postRows = new Map(input.post.rows.map((row) => [row.id, row]));
  if (preRows.size !== postRows.size || [...preRows.keys()].some((id) => !postRows.has(id)))
    return { kind: "outcome-unknown", reason: "id-set-changed", counts };
  const members = new Map(decoded.map((member) => [idOf(member.externalKey)!, member]));
  for (const [id, member] of members) {
    const before = preRows.get(id);
    const after = postRows.get(id);
    if (!before || !after || !sellerEqual(expectedMemberRow(before, member), after.sellerColumns))
      return { kind: "outcome-unknown", reason: "member-projection-mismatch", counts };
  }
  for (const before of input.pre.rows) {
    if (members.has(before.id)) continue;
    const after = postRows.get(before.id);
    if (!after || !sellerEqual(before.sellerColumns, after.sellerColumns))
      return { kind: "outcome-unknown", reason: "non-member-drift", counts };
  }
  return { kind: "applied", counts };
}
