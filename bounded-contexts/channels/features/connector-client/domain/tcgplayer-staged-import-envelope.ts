import {
  decodeTcgplayerStagedImportFieldClassification,
  type TcgplayerStagedImportField,
  type TcgplayerStagedImportFieldClassification,
} from "./tcgplayer-staged-import-classification";

export type TcgplayerStagedImportContinuation = Readonly<{
  stagedPricingUploadId: string;
  batchFileName: string;
}>;

export type TcgplayerStagedImportEnvelope = Readonly<{
  initialize: string;
  upload: string;
  finalize: string;
}>;

export class TcgplayerStagedImportEnvelopeError extends Error {
  constructor(
    readonly code:
      | "classification-unavailable"
      | "zero-composed-rows"
      | "row-outside-observed-input-classes"
      | "missing-reference-column"
      | "invalid-composed-value"
      | "credential-shaped-value",
  ) {
    super(`staged-import-envelope-${code}`);
  }
}

type Row = Readonly<Record<string, unknown>>;

function connectorValue(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value))
    throw new TcgplayerStagedImportEnvelopeError("invalid-composed-value");
  return value;
}

function fieldValue(
  field: TcgplayerStagedImportField,
  row: Row | undefined,
  continuation: TcgplayerStagedImportContinuation,
  count: number,
): string {
  switch (field.class.kind) {
    case "closed-constant":
      if (/(?:cookie|credential|token|ticket|session|anti[-_]?forgery|password|secret)/i.test(field.class.value))
        throw new TcgplayerStagedImportEnvelopeError("credential-shaped-value");
      return field.class.value;
    case "verbatim-reference-column": {
      const value = row?.[field.class.column];
      if (typeof value !== "string") throw new TcgplayerStagedImportEnvelopeError("missing-reference-column");
      return value;
    }
    case "composed-column": {
      const value = row?.[field.class.column];
      if (typeof value !== "string" || !value) throw new TcgplayerStagedImportEnvelopeError("invalid-composed-value");
      return value;
    }
    case "closed-derivation":
      if (field.class.derivation === "prior-hop-continuation")
        return connectorValue(continuation.stagedPricingUploadId);
      if (field.class.derivation === "batch-file-name") return connectorValue(continuation.batchFileName);
      return String(count);
  }
}

function keyFor(field: TcgplayerStagedImportField, index: number): string {
  return field.key.replaceAll("[n]", `[${index}]`);
}

function formBody(
  fields: readonly TcgplayerStagedImportField[],
  rows: readonly Row[],
  continuation: TcgplayerStagedImportContinuation,
): string {
  const params = new URLSearchParams();
  const repeated = fields.filter((field) => field.key.includes("[n]"));
  const scalar = fields.filter((field) => !field.key.includes("[n]"));
  for (const [index, row] of rows.entries())
    for (const field of repeated)
      params.append(keyFor(field, index), fieldValue(field, row, continuation, rows.length));
  for (const field of scalar) params.append(field.key, fieldValue(field, rows[0], continuation, rows.length));
  return params.toString();
}

function validateRows(rows: readonly Row[]): void {
  if (rows.length === 0) throw new TcgplayerStagedImportEnvelopeError("zero-composed-rows");
  if (rows.length > 500) throw new TcgplayerStagedImportEnvelopeError("row-outside-observed-input-classes");
  for (const row of rows) {
    const id = row["TCGplayer Id"];
    const price = row["TCG Marketplace Price"];
    if (typeof id !== "string" || !/^\d+$/.test(id) || typeof price !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(price))
      throw new TcgplayerStagedImportEnvelopeError("row-outside-observed-input-classes");
    for (const key of ["ProOnlineStoreReserveQuantity", "ProOnlineStorePrice"]) {
      const value = row[key];
      if (value !== undefined && value !== "")
        throw new TcgplayerStagedImportEnvelopeError("row-outside-observed-input-classes");
    }
  }
}

/** Build all three ordered bodies directly from the decoded field grammar. */
export function buildTcgplayerStagedImportEnvelope(
  input: Readonly<{
    classification: TcgplayerStagedImportFieldClassification;
    composedRows: readonly Row[];
    continuation: TcgplayerStagedImportContinuation;
  }>,
): TcgplayerStagedImportEnvelope {
  let classification: TcgplayerStagedImportFieldClassification;
  try {
    classification = decodeTcgplayerStagedImportFieldClassification(input.classification);
  } catch {
    throw new TcgplayerStagedImportEnvelopeError("classification-unavailable");
  }
  validateRows(input.composedRows);
  for (const field of classification.upload) {
    if (field.class.kind !== "verbatim-reference-column") continue;
    for (const row of input.composedRows)
      if (typeof row[field.class.column] !== "string")
        throw new TcgplayerStagedImportEnvelopeError("missing-reference-column");
  }
  return Object.freeze({
    initialize: formBody(classification.initialize, input.composedRows, input.continuation),
    upload: formBody(classification.upload, input.composedRows, input.continuation),
    finalize: formBody(classification.finalize, input.composedRows, input.continuation),
  });
}
