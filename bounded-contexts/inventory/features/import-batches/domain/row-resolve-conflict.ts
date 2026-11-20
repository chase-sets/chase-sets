import { InventoryDomainError } from "../../../support/runtime-support/common";

/** Opaque row version: the row's `updated_at` as UTC microsecond text, projected by `getImportBatch`. */
const ROW_VERSION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const ROW_FINGERPRINT_MAX_LENGTH = 2048;

export function isImportRowVersion(value: unknown): value is string {
  return typeof value === "string" && ROW_VERSION.test(value) && Number.isFinite(Date.parse(value));
}

export function isImportRowFingerprint(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ROW_FINGERPRINT_MAX_LENGTH &&
    [...value].every((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f)
  );
}

export const importRowResolveConflictCodes = [
  "invalid_row_facts",
  "missing_row_facts",
  "stale_row_facts",
  "terminal_row",
  "row_not_found",
  "batch_not_resolvable",
  "attempt_conflict",
] as const;
export type ImportRowResolveConflictCode = (typeof importRowResolveConflictCodes)[number];

const messages: Readonly<Record<ImportRowResolveConflictCode, string>> = {
  invalid_row_facts: "Import row facts are invalid. Reload the batch and try again.",
  missing_row_facts: "Import row facts are missing. Reload the batch and try again.",
  stale_row_facts: "Import row changed since it was loaded. Reload the batch and try again.",
  terminal_row: "Committed import rows cannot be changed.",
  row_not_found: "Import row not found.",
  batch_not_resolvable: "Import batch is not accepting row fixes right now. Reload the batch and try again.",
  attempt_conflict: "This row fix was already submitted with different values. Reload the batch and try again.",
};

/** A refused resolve: one closed code and a fixed message, never caller or database text. */
export class ImportRowResolveConflict extends InventoryDomainError {
  readonly code: ImportRowResolveConflictCode;

  constructor(code: ImportRowResolveConflictCode) {
    super(messages[code]);
    this.code = code;
  }
}
