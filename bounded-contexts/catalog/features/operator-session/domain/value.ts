export class CatalogOperatorSessionError extends Error {
  constructor(
    public readonly code:
      | "invalid-session-value"
      | "invalid-session-instant"
      | "invalid-session-fence"
      | "revision-exhausted"
      | "custody-unavailable",
  ) {
    super(code);
    this.name = "CatalogOperatorSessionError";
  }
}

export function validateOperatorSessionValue(value: string): void {
  if (typeof value !== "string" || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(value)) {
    throw new CatalogOperatorSessionError("invalid-session-value");
  }
}

export function validateOperatorSessionInstant(value: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value.replace(/(?<=:\d{2})Z$/, ".000Z")
  ) {
    throw new CatalogOperatorSessionError("invalid-session-instant");
  }
}

export function validateOperatorSessionRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new CatalogOperatorSessionError("invalid-session-fence");
}

export function nextOperatorSessionRevision(revision: number): number {
  if (revision === Number.MAX_SAFE_INTEGER) throw new CatalogOperatorSessionError("revision-exhausted");
  return revision + 1;
}
