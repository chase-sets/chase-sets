export const setNameDocumentedFields = [
  "setNameId",
  "categoryId",
  "name",
  "cleanSetName",
  "urlName",
  "abbreviation",
  "releaseDate",
  "isSupplemental",
  "active",
] as const;
export type SetNameDocumentedField = (typeof setNameDocumentedFields)[number];

export const tcgplayerSingleCardUnitConstraints = [
  { unitKey: "tcgplayer:mtg:single-card:source-observation-import", productLineId: "1" },
  { unitKey: "tcgplayer:yugioh:single-card:source-observation-import", productLineId: "2" },
  { unitKey: "tcgplayer:pokemon:single-card:source-observation-import", productLineId: "3" },
  { unitKey: "tcgplayer:one-piece:single-card:source-observation-import", productLineId: "68" },
  { unitKey: "tcgplayer:lorcana:single-card:source-observation-import", productLineId: "82" },
] as const;

export type SetNamesRequestResult = Readonly<{
  ok: boolean;
  status: number | null;
  contentClass: "json" | "non-json" | "unknown";
  bytes: number;
  body: unknown;
  code?: string;
}>;
export type SetNamesRequest = (productLineId: string) => Promise<SetNamesRequestResult>;

export type SetNamesReceipt = Readonly<{
  status: number | null;
  contentClass: "json" | "non-json" | "unknown";
  bytes: number;
  resultCount: number;
  activeCount: number;
  errorsCount: number;
  missingFieldCounts: Readonly<Record<SetNameDocumentedField, number>>;
}>;

type FieldCounts = Readonly<{
  present: number;
  absent: number;
  null: number;
  types: Readonly<Record<"string" | "number" | "boolean" | "object" | "array" | "null", number>>;
  maxLength: number;
  nonPrintableCount: number;
}>;
type JsonType = "string" | "number" | "boolean" | "object" | "array" | "null";

export type SetNamesSummary = Readonly<{
  errorsPresent: boolean;
  resultsPresent: boolean;
  otherTopLevelKeyCount: number;
  fields: Readonly<Record<SetNameDocumentedField, FieldCounts>>;
  releaseDate: Readonly<{ dateOnly: number; instant: number; other: number }>;
  categoryIdMismatches: number;
  duplicateSetNameIdCount: number;
  duplicateCleanSetNameCount: number;
  otherFieldCount: number;
}>;

export type SetNamesRow = Readonly<{
  unitKey: string;
  requestedProductLineId: string;
  receipt: SetNamesReceipt;
  summary: SetNamesSummary;
  qualification: Readonly<{ status: "qualified" | "unqualified"; reasons: readonly string[] }>;
}>;

export type SetNamesProbeReport = Readonly<{
  probeVersion: 1;
  extensionVersion: string;
  buildCommit: string;
  browserMajor: string;
  probedAt: string;
  lifecycle: "response-receipt-before-reduction";
  posture: Readonly<{ credentials: "omit"; storage: "memory-only"; destination: "none" }>;
  rows: readonly SetNamesRow[];
}>;

export type SetNamesProbeInput = Readonly<{
  request: SetNamesRequest;
  extensionVersion: string;
  buildCommit: string;
  browserMajor: string;
  probedAt?: string;
  productLineIds?: readonly string[];
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onReceipt?: (receipt: SetNamesReceipt) => void;
  onSummary?: (summary: SetNamesSummary) => void;
}>;

const emptyCounts = (): FieldCounts => ({
  present: 0,
  absent: 0,
  null: 0,
  types: { string: 0, number: 0, boolean: 0, object: 0, array: 0, null: 0 },
  maxLength: 0,
  nonPrintableCount: 0,
});
const emptyMissing = (): Record<SetNameDocumentedField, number> =>
  Object.fromEntries(setNameDocumentedFields.map((field) => [field, 0])) as Record<SetNameDocumentedField, number>;
const emptySummary = (): SetNamesSummary => ({
  errorsPresent: false,
  resultsPresent: false,
  otherTopLevelKeyCount: 0,
  fields: Object.fromEntries(setNameDocumentedFields.map((field) => [field, emptyCounts()])) as Record<
    SetNameDocumentedField,
    FieldCounts
  >,
  releaseDate: { dateOnly: 0, instant: 0, other: 0 },
  categoryIdMismatches: 0,
  duplicateSetNameIdCount: 0,
  duplicateCleanSetNameCount: 0,
  otherFieldCount: 0,
});

export async function probeTcgplayerSetNames(input: SetNamesProbeInput): Promise<SetNamesProbeReport> {
  const ids = input.productLineIds ?? tcgplayerSingleCardUnitConstraints.map((unit) => unit.productLineId);
  const rows: SetNamesRow[] = [];
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const minimum = Math.max(0, input.minIntervalMs ?? 1_000);
  let lastStarted: number | null = null;
  for (const productLineId of ids) {
    if (lastStarted !== null) {
      const wait = minimum - (now() - lastStarted);
      if (wait > 0) await sleep(wait);
    }
    lastStarted = now();
    const result = await input.request(productLineId);
    const receipt = receiptFor(result);
    input.onReceipt?.(receipt);
    const summary = summarize(result.body, productLineId);
    input.onSummary?.(summary);
    const unit = tcgplayerSingleCardUnitConstraints.find((candidate) => candidate.productLineId === productLineId);
    rows.push({
      unitKey: unit?.unitKey ?? "tcgplayer:unknown:single-card:source-observation-import",
      requestedProductLineId: productLineId,
      receipt,
      summary,
      qualification: qualify(result, summary),
    });
  }
  return {
    probeVersion: 1,
    extensionVersion: input.extensionVersion,
    buildCommit: input.buildCommit,
    browserMajor: input.browserMajor,
    probedAt: input.probedAt ?? new Date().toISOString(),
    lifecycle: "response-receipt-before-reduction",
    posture: { credentials: "omit", storage: "memory-only", destination: "none" },
    rows,
  };
}

export function serializeSetNamesProbeReport(report: SetNamesProbeReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export async function sha256SetNamesProbeReport(report: SetNamesProbeReport): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serializeSetNamesProbeReport(report)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function receiptFor(result: SetNamesRequestResult): SetNamesReceipt {
  const summary = summarize(result.body, "");
  const body = asEnvelope(result.body);
  return {
    status: result.status,
    contentClass: result.contentClass,
    bytes: result.bytes,
    resultCount: body.results?.length ?? 0,
    activeCount: body.results?.filter((entry) => isRecord(entry) && entry.active === true).length ?? 0,
    errorsCount: Array.isArray(body.errors) ? body.errors.length : 0,
    missingFieldCounts: summary.fields
      ? (Object.fromEntries(setNameDocumentedFields.map((field) => [field, summary.fields[field].absent])) as Record<
          SetNameDocumentedField,
          number
        >)
      : emptyMissing(),
  };
}

function summarize(body: unknown, requestedProductLineId: string): SetNamesSummary {
  const summary = emptySummary();
  if (!isRecord(body)) return summary;
  const keys = Object.keys(body);
  const results = Array.isArray(body.results) ? body.results : [];
  const fields = { ...summary.fields } as Record<SetNameDocumentedField, FieldCounts>;
  const seenSetNameIds = new Set<unknown>();
  const seenCleanSetNames = new Set<unknown>();
  let duplicateSetNameIdCount = 0;
  let duplicateCleanSetNameCount = 0;
  let categoryIdMismatches = 0;
  let otherFieldCount = 0;
  let releaseDate = summary.releaseDate;
  for (const entry of results) {
    if (!isRecord(entry)) {
      for (const field of setNameDocumentedFields)
        fields[field] = { ...fields[field], absent: fields[field].absent + 1 };
      continue;
    }
    for (const field of setNameDocumentedFields) {
      if (!Object.hasOwn(entry, field)) {
        fields[field] = { ...fields[field], absent: fields[field].absent + 1 };
        continue;
      }
      const value = entry[field];
      if (value === null) {
        fields[field] = {
          ...fields[field],
          present: fields[field].present + 1,
          null: fields[field].null + 1,
          types: { ...fields[field].types, null: fields[field].types.null + 1 },
        };
        continue;
      }
      const type: JsonType = Array.isArray(value) ? "array" : (typeof value as JsonType);
      const types = { ...fields[field].types, [type]: fields[field].types[type] + 1 };
      const stringLength = typeof value === "string" ? value.length : 0;
      const nonPrintable =
        typeof value === "string" ? [...value].filter((character) => /[^\x20-\x7E]/.test(character)).length : 0;
      fields[field] = {
        ...fields[field],
        present: fields[field].present + 1,
        types,
        maxLength: Math.max(fields[field].maxLength, stringLength),
        nonPrintableCount: fields[field].nonPrintableCount + nonPrintable,
      };
      if (field === "releaseDate") {
        releaseDate = {
          dateOnly: releaseDate.dateOnly + (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? 1 : 0),
          instant: releaseDate.instant + (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? 1 : 0),
          other:
            releaseDate.other +
            (typeof value !== "string" || (!/^\d{4}-\d{2}-\d{2}$/.test(value) && !/^\d{4}-\d{2}-\d{2}T/.test(value))
              ? 1
              : 0),
        };
      }
    }
    for (const key of Object.keys(entry))
      if (!setNameDocumentedFields.includes(key as SetNameDocumentedField)) otherFieldCount++;
    if (entry.categoryId !== undefined && String(entry.categoryId) !== requestedProductLineId) categoryIdMismatches++;
    if (seenSetNameIds.has(entry.setNameId)) duplicateSetNameIdCount++;
    else if (entry.setNameId !== undefined && entry.setNameId !== null) seenSetNameIds.add(entry.setNameId);
    if (seenCleanSetNames.has(entry.cleanSetName)) duplicateCleanSetNameCount++;
    else if (entry.cleanSetName !== undefined && entry.cleanSetName !== null) seenCleanSetNames.add(entry.cleanSetName);
  }
  return {
    errorsPresent: Object.hasOwn(body, "errors"),
    resultsPresent: Object.hasOwn(body, "results"),
    otherTopLevelKeyCount: keys.filter((key) => key !== "errors" && key !== "results").length,
    fields,
    releaseDate,
    categoryIdMismatches,
    duplicateSetNameIdCount,
    duplicateCleanSetNameCount,
    otherFieldCount,
  };
}

function qualify(result: SetNamesRequestResult, summary: SetNamesSummary) {
  if (!result.ok) return { status: "unqualified" as const, reasons: [result.code ?? "http-not-success"] };
  const body = asEnvelope(result.body);
  const reasons: string[] = [];
  if (result.status === null || result.status < 200 || result.status >= 300) reasons.push("http-not-success");
  if (result.contentClass !== "json" || !isRecord(result.body)) reasons.push("non-json");
  if (!Array.isArray(body.errors) || body.errors.length > 0) reasons.push("errors-present");
  if (!Array.isArray(body.results) || body.results.length === 0) reasons.push("results-empty");
  if (Array.isArray(body.results) && body.results.some((entry) => !validEntry(entry))) reasons.push("field-invalid");
  if (summary.categoryIdMismatches > 0) reasons.push("category-id-mismatch");
  return { status: reasons.length === 0 ? ("qualified" as const) : ("unqualified" as const), reasons };
}

function validEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const required: Readonly<Record<string, string>> = {
    setNameId: "number",
    categoryId: "number",
    name: "string",
    cleanSetName: "string",
    urlName: "string",
    isSupplemental: "boolean",
    active: "boolean",
  };
  for (const [field, type] of Object.entries(required)) if (typeof value[field] !== type) return false;
  if (Object.hasOwn(value, "abbreviation") && value.abbreviation !== null && typeof value.abbreviation !== "string")
    return false;
  if (
    Object.hasOwn(value, "releaseDate") &&
    value.releaseDate !== null &&
    (typeof value.releaseDate !== "string" || !isReleaseDate(value.releaseDate))
  )
    return false;
  return true;
}

function isReleaseDate(value: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function asEnvelope(value: unknown): { errors?: unknown[]; results?: unknown[] } {
  return isRecord(value)
    ? {
        errors: Array.isArray(value.errors) ? value.errors : undefined,
        results: Array.isArray(value.results) ? value.results : undefined,
      }
    : {};
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
