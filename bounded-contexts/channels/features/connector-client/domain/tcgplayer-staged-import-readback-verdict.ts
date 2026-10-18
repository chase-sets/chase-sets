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
  origin?: "worker" | "page";
  source?: "worker" | "page";
  method: "GET";
  path: string;
  status: number;
  contentType: string;
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
  | Readonly<{
      kind: "basis-diverged";
      counts: Readonly<{ preRows: number; postRows: number; members: number }>;
    }>;

export type TcgplayerStagedImportPreflight =
  | Readonly<{ kind: "proceed"; counts: Readonly<{ preRows: number; members: number }> }>
  | Readonly<{ kind: "basis-diverged"; counts: Readonly<{ preRows: number; members: number }> }>
  | Readonly<{
      kind: "outcome-unknown";
      reason: "missing-completeness-discriminator" | "incomplete-readback" | "overflow-readback";
      counts: Readonly<{ preRows: number; members: number }>;
    }>;

export class TcgplayerStagedImportReadbackError extends Error {
  constructor(readonly code: "invalid-record" | "overflow-readback" | "incomplete-readback") {
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

function count(pre: TcgplayerStagedImportReadback, post: TcgplayerStagedImportReadback, members: readonly unknown[]) {
  return { preRows: pre.rows.length, postRows: post.rows.length, members: members.length };
}

function idOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.startsWith("product:") ? value.slice("product:".length) : value;
  return /^\d+$/.test(id) ? id : null;
}

function asSellerColumns(row: Record<string, unknown>): Record<string, string> {
  const source = row.sellerColumns ?? row.referenceColumns ?? row.columns;
  if (!source || typeof source !== "object" || Array.isArray(source))
    throw new TcgplayerStagedImportReadbackError("invalid-record");
  const columns: Record<string, string> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (marketColumns.has(key)) continue;
    if (typeof value !== "string") throw new TcgplayerStagedImportReadbackError("invalid-record");
    columns[key] = value;
  }
  return columns;
}

function asMarketColumns(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const columns: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>))
    if (typeof entry === "string") columns[key] = entry;
  return columns;
}

function decodeRows(rows: unknown, limits: Readonly<{ maxRows: number }>): readonly TcgplayerStagedImportReadbackRow[] {
  if (!Array.isArray(rows) || rows.length > limits.maxRows)
    throw new TcgplayerStagedImportReadbackError("overflow-readback");
  const ids = new Set<string>();
  return rows.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new TcgplayerStagedImportReadbackError("invalid-record");
    const row = value as Record<string, unknown>;
    const id = idOf(
      row.id ?? row.externalKey ?? (row.referenceColumns as Record<string, unknown> | undefined)?.["TCGplayer Id"],
    );
    if (!id || ids.has(id)) throw new TcgplayerStagedImportReadbackError("invalid-record");
    ids.add(id);
    return {
      id,
      sellerColumns: Object.freeze(asSellerColumns(row)),
      marketColumns: Object.freeze(asMarketColumns(row.marketColumns)),
    };
  });
}

/** Decode an object-shaped worker readback without retaining its raw bytes. */
export function decodeTcgplayerStagedImportReadback(
  input: unknown,
  limits: Readonly<{ maxRows?: number }> = {},
): TcgplayerStagedImportReadback {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TcgplayerStagedImportReadbackError("invalid-record");
  const row = input as Record<string, unknown>;
  const rows = decodeRows(row.rows, { maxRows: limits.maxRows ?? tcgplayerStagedImportReadbackLimits.maxRows });
  const completeness = row.completeness;
  if (completeness === null || completeness === undefined) return Object.freeze({ rows, completeness: null });
  if (!completeness || typeof completeness !== "object" || Array.isArray(completeness))
    throw new TcgplayerStagedImportReadbackError("invalid-record");
  const marker = completeness as Record<string, unknown>;
  if (marker.kind === "overflow") return Object.freeze({ rows: [], completeness: { kind: "overflow" } });
  if (marker.kind === "incomplete" && (marker.reason === "partial" || marker.reason === "missing"))
    return Object.freeze({ rows, completeness: { kind: "incomplete", reason: marker.reason } });
  const expectedRows = marker.expectedRows;
  if (
    marker.kind === "complete" &&
    typeof expectedRows === "number" &&
    Number.isSafeInteger(expectedRows) &&
    expectedRows >= 0
  )
    return Object.freeze({ rows, completeness: { kind: "complete", expectedRows } });
  throw new TcgplayerStagedImportReadbackError("invalid-record");
}

/** A bounded CSV fallback. The discriminator is intentionally absent: callers must supply it separately. */
export function parseTcgplayerStagedImportReadback(
  input: string,
  limits: Readonly<{ maxBytes?: number; maxRows?: number }> = {},
): TcgplayerStagedImportReadback {
  const maxBytes = limits.maxBytes ?? tcgplayerStagedImportReadbackLimits.maxBytes;
  if (new TextEncoder().encode(input).byteLength > maxBytes)
    throw new TcgplayerStagedImportReadbackError("overflow-readback");
  const lines = input.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) throw new TcgplayerStagedImportReadbackError("incomplete-readback");
  const header = lines[0]!.split(",");
  const positions = new Map(header.map((key, index) => [key, index]));
  const rows = lines.slice(1).map((line) => {
    const fields = line.split(",");
    const id = fields[positions.get("TCGplayer Id") ?? -1];
    if (!id) throw new TcgplayerStagedImportReadbackError("invalid-record");
    const sellerColumns: Record<string, string> = {};
    for (const [key, index] of positions) if (!marketColumns.has(key)) sellerColumns[key] = fields[index] ?? "";
    return { id, sellerColumns, marketColumns: {} };
  });
  return decodeTcgplayerStagedImportReadback({ rows, completeness: null }, limits);
}

function complete(readback: TcgplayerStagedImportReadback): "ok" | "missing" | "incomplete" | "overflow" {
  if (!readback.completeness) return "missing";
  if (readback.completeness.kind === "overflow") return "overflow";
  if (readback.completeness.kind === "incomplete") return "incomplete";
  return readback.completeness.expectedRows === readback.rows.length ? "ok" : "incomplete";
}

function basisMatches(row: TcgplayerStagedImportReadbackRow, member: Record<string, unknown>): boolean {
  if (typeof member.pendingQuantityDelta === "number" && member.pendingQuantityDelta !== 0) return false;
  const basis = member.basisSellerColumns ?? (member.basis as Record<string, unknown> | undefined)?.sellerColumns;
  if (basis && typeof basis === "object" && !Array.isArray(basis)) {
    const expected: Record<string, string> = {};
    for (const [key, value] of Object.entries(basis as Record<string, unknown>))
      if (typeof value === "string") expected[key] = value;
    return sellerEqual(row.sellerColumns, expected);
  }
  const total = member.basisTotalQuantity;
  const price = member.basisPriceAmountMinor;
  if (total !== undefined && String(total) !== row.sellerColumns["Total Quantity"]) return false;
  if (price !== undefined && Number.isSafeInteger(price)) {
    const actual = Number(row.sellerColumns["TCG Marketplace Price"]);
    if (!Number.isFinite(actual) || Math.round(actual * 100) !== Number(price)) return false;
  }
  return true;
}

export function preflightTcgplayerStagedImport(
  pre: TcgplayerStagedImportReadback,
  members: readonly Record<string, unknown>[],
): TcgplayerStagedImportPreflight {
  const state = complete(pre);
  const counts = { preRows: pre.rows.length, members: members.length };
  if (state === "missing") return { kind: "outcome-unknown", reason: "missing-completeness-discriminator", counts };
  if (state === "overflow") return { kind: "outcome-unknown", reason: "overflow-readback", counts };
  if (state === "incomplete") return { kind: "outcome-unknown", reason: "incomplete-readback", counts };
  const rows = new Map(pre.rows.map((row) => [row.id, row]));
  for (const member of members) {
    const id = idOf(member.id ?? member.externalKey);
    const row = id ? rows.get(id) : undefined;
    if (!row || !basisMatches(row, member)) return { kind: "basis-diverged", counts };
  }
  return { kind: "proceed", counts };
}

function expectedMemberRow(
  pre: TcgplayerStagedImportReadbackRow,
  member: Record<string, unknown>,
): Record<string, string> {
  const expected = { ...pre.sellerColumns };
  const csv = member.csvRow;
  if (csv && typeof csv === "object" && !Array.isArray(csv)) {
    const source = csv as Record<string, unknown>;
    const delta = source["Add to Quantity"];
    const price = source["TCG Marketplace Price"];
    if (typeof delta === "string" && /^-?\d+$/.test(delta) && /^-?\d+$/.test(expected["Total Quantity"] ?? ""))
      expected["Total Quantity"] = String(Number(expected["Total Quantity"]) + Number(delta));
    if (typeof delta === "string") expected["Add to Quantity"] = delta;
    if (typeof price === "string") expected["TCG Marketplace Price"] = price;
  }
  return expected;
}

function sellerEqual(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

export function deriveTcgplayerStagedImportReadbackVerdict(
  input: Readonly<{
    pre: TcgplayerStagedImportReadback;
    post: TcgplayerStagedImportReadback;
    members: readonly Record<string, unknown>[];
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
    (input.authority.origin ?? input.authority.source) !== "worker" ||
    input.authority.method !== "GET" ||
    input.authority.path !== "/Admin/Pricing/DownloadStagedInventoryExportCSV" ||
    input.authority.status !== 200 ||
    !input.authority.contentType.toLowerCase().startsWith("text/csv")
  )
    return { kind: "outcome-unknown", reason: "authority-unavailable", counts };
  const preflight = preflightTcgplayerStagedImport(input.pre, input.members);
  if (preflight.kind === "basis-diverged") return { kind: "basis-diverged", counts };
  if (preflight.kind === "outcome-unknown") return { kind: "outcome-unknown", reason: preflight.reason, counts };
  const preIds = new Set(input.pre.rows.map((row) => row.id));
  const postIds = new Set(input.post.rows.map((row) => row.id));
  if (preIds.size !== postIds.size || [...preIds].some((id) => !postIds.has(id)))
    return { kind: "outcome-unknown", reason: "id-set-changed", counts };
  const members = new Map(input.members.map((member) => [idOf(member.id ?? member.externalKey), member]));
  const preRows = new Map(input.pre.rows.map((row) => [row.id, row]));
  const postRows = new Map(input.post.rows.map((row) => [row.id, row]));
  for (const [id, member] of members) {
    if (!id) return { kind: "outcome-unknown", reason: "member-projection-mismatch", counts };
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

export const decideTcgplayerStagedImportReadbackVerdict = deriveTcgplayerStagedImportReadbackVerdict;
export const assessTcgplayerStagedImportPreflight = preflightTcgplayerStagedImport;
export const decideStagedImportReadbackVerdict = deriveTcgplayerStagedImportReadbackVerdict;
