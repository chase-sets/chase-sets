/**
 * The staged import grammar is captured as data.  Builders must not grow a
 * second, hand-maintained list of provider fields.
 */
export type TcgplayerStagedImportFieldClass =
  | Readonly<{ kind: "composed-column"; column: "Add to Quantity" | "TCG Marketplace Price" }>
  | Readonly<{ kind: "verbatim-reference-column"; column: string }>
  | Readonly<{ kind: "closed-constant"; value: string }>
  | Readonly<{
      kind: "closed-derivation";
      derivation: "prior-hop-continuation" | "batch-file-name" | "composed-row-count";
    }>;

export type TcgplayerStagedImportField = Readonly<{
  key: string;
  class: TcgplayerStagedImportFieldClass;
}>;

export type TcgplayerStagedImportFieldClassification = Readonly<{
  schemaVersion: 1;
  source: "candidate-unverified" | "founder-session";
  observedInputClasses: readonly (
    | "id-present"
    | "price-valid"
    | "pro-online-store-reserve-empty"
    | "pro-online-store-price-empty"
  )[];
  initialize: readonly TcgplayerStagedImportField[];
  upload: readonly TcgplayerStagedImportField[];
  finalize: readonly TcgplayerStagedImportField[];
}>;

export class TcgplayerStagedImportClassificationError extends Error {
  constructor(
    readonly code:
      | "invalid-record"
      | "unknown-field"
      | "duplicate-field"
      | "unclassified-field"
      | "credential-shaped-field"
      | "founder-session-required",
  ) {
    super(`staged-import-classification-${code}`);
  }
}

const observedInputClasses = [
  "id-present",
  "price-valid",
  "pro-online-store-reserve-empty",
  "pro-online-store-price-empty",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new TcgplayerStagedImportClassificationError("invalid-record");
  return value;
}

function credentialShaped(value: string): boolean {
  return /(?:cookie|credential|token|ticket|session|anti[-_]?forgery|password|secret)/i.test(value);
}

function decodeClass(value: unknown): TcgplayerStagedImportFieldClass {
  if (!isRecord(value)) throw new TcgplayerStagedImportClassificationError("unclassified-field");
  if (typeof value.kind !== "string") throw new TcgplayerStagedImportClassificationError("unclassified-field");
  switch (value.kind) {
    case "composed-column": {
      const row = exactRecord(value, ["kind", "column"]);
      if (row.column !== "Add to Quantity" && row.column !== "TCG Marketplace Price")
        throw new TcgplayerStagedImportClassificationError("invalid-record");
      return { kind: "composed-column", column: row.column };
    }
    case "verbatim-reference-column": {
      const row = exactRecord(value, ["kind", "column"]);
      if (typeof row.column !== "string" || !row.column || row.column.length > 256)
        throw new TcgplayerStagedImportClassificationError("invalid-record");
      if (credentialShaped(row.column)) throw new TcgplayerStagedImportClassificationError("credential-shaped-field");
      return { kind: "verbatim-reference-column", column: row.column };
    }
    case "closed-constant": {
      const row = exactRecord(value, ["kind", "value"]);
      if (typeof row.value !== "string" || row.value.length > 1024 || credentialShaped(row.value))
        throw new TcgplayerStagedImportClassificationError("credential-shaped-field");
      return { kind: "closed-constant", value: row.value };
    }
    case "closed-derivation": {
      const row = exactRecord(value, ["kind", "derivation"]);
      if (
        row.derivation !== "prior-hop-continuation" &&
        row.derivation !== "batch-file-name" &&
        row.derivation !== "composed-row-count"
      )
        throw new TcgplayerStagedImportClassificationError("invalid-record");
      return { kind: "closed-derivation", derivation: row.derivation };
    }
    default:
      throw new TcgplayerStagedImportClassificationError("unknown-field");
  }
}

function decodeFields(value: unknown): readonly TcgplayerStagedImportField[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128)
    throw new TcgplayerStagedImportClassificationError("invalid-record");
  const keys = new Set<string>();
  return value.map((candidate) => {
    const row = exactRecord(candidate, ["key", "class"]);
    if (typeof row.key !== "string" || !row.key || row.key.length > 256)
      throw new TcgplayerStagedImportClassificationError("invalid-record");
    if (credentialShaped(row.key)) throw new TcgplayerStagedImportClassificationError("credential-shaped-field");
    if (keys.has(row.key)) throw new TcgplayerStagedImportClassificationError("duplicate-field");
    keys.add(row.key);
    return { key: row.key, class: decodeClass(row.class) };
  });
}

/** Decode the closed field grammar. No unknown nested key survives this boundary. */
export function decodeTcgplayerStagedImportFieldClassification(
  input: unknown,
  options: Readonly<{ requireSource?: "founder-session" }> = {},
): TcgplayerStagedImportFieldClassification {
  const row = exactRecord(input, [
    "schemaVersion",
    "source",
    "observedInputClasses",
    "initialize",
    "upload",
    "finalize",
  ]);
  if (row.schemaVersion !== 1 || (row.source !== "candidate-unverified" && row.source !== "founder-session"))
    throw new TcgplayerStagedImportClassificationError("invalid-record");
  if (options.requireSource === "founder-session" && row.source !== "founder-session")
    throw new TcgplayerStagedImportClassificationError("founder-session-required");
  if (
    !Array.isArray(row.observedInputClasses) ||
    row.observedInputClasses.length !== observedInputClasses.length ||
    row.observedInputClasses.some(
      (item) => !observedInputClasses.includes(item as (typeof observedInputClasses)[number]),
    ) ||
    new Set(row.observedInputClasses).size !== observedInputClasses.length
  )
    throw new TcgplayerStagedImportClassificationError("invalid-record");
  return Object.freeze({
    schemaVersion: 1,
    source: row.source,
    observedInputClasses: [...observedInputClasses],
    initialize: decodeFields(row.initialize),
    upload: decodeFields(row.upload),
    finalize: decodeFields(row.finalize),
  });
}

const reference = (key: string, column: string): TcgplayerStagedImportField => ({
  key,
  class: { kind: "verbatim-reference-column", column },
});
const composed = (key: string, column: "Add to Quantity" | "TCG Marketplace Price"): TcgplayerStagedImportField => ({
  key,
  class: { kind: "composed-column", column },
});
const constant = (key: string, value: string): TcgplayerStagedImportField => ({
  key,
  class: { kind: "closed-constant", value },
});
const derived = (
  key: string,
  derivation: "prior-hop-continuation" | "batch-file-name" | "composed-row-count",
): TcgplayerStagedImportField => ({ key, class: { kind: "closed-derivation", derivation } });

/** Historical candidate from the captured field names. It is deliberately not founder-session authority. */
export const tcgplayerStagedImportCandidateClassification: TcgplayerStagedImportFieldClassification = Object.freeze({
  schemaVersion: 1,
  source: "candidate-unverified",
  observedInputClasses: [...observedInputClasses],
  initialize: [derived("filename", "batch-file-name"), constant("type", "csv")],
  upload: [
    reference("data[n][Id]", "TCGplayer Id"),
    // The founder capture names these fields, while the executable mapper's
    // staged rows expose the profile columns below.  The candidate remains a
    // hypothesis, but it must be buildable from real composed rows.
    reference("data[n][ProductConditionId]", "Condition"),
    reference("data[n][CategoryName]", "Product Line"),
    reference("data[n][SetName]", "Set Name"),
    reference("data[n][ProductName]", "Product Name"),
    reference("data[n][ConditionName]", "Condition"),
    composed("data[n][AddToQuantity]", "Add to Quantity"),
    composed("data[n][MyPrice]", "TCG Marketplace Price"),
    constant("data[n][ProOnlineStoreReserveQuantity]", ""),
    constant("data[n][ProOnlineStorePrice]", ""),
    reference("data[n][Number]", "Number"),
    constant("data[n][isPriceValid]", "true"),
    derived("stagedPricingUploadId", "prior-hop-continuation"),
    derived("fileName", "batch-file-name"),
    constant("type", "csv"),
  ],
  finalize: [
    derived("stagedPricingUploadId", "prior-hop-continuation"),
    derived("productCount", "composed-row-count"),
    constant("type", "csv"),
  ],
});
