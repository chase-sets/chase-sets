export type RouteCensusErrorCode =
  | "E_ARTIFACT_INVALID"
  | "E_CHILD_FAILED"
  | "E_ENTRY_SHAPE"
  | "E_EXPECTATION_MISMATCH"
  | "E_HEAD_MISMATCH"
  | "E_OUTPUT_EXISTS"
  | "E_PROVENANCE"
  | "E_PUBLICATION_FAILED"
  | "E_ROOT_INVALID"
  | "E_ROUTE_PATTERN"
  | "E_ROUTE_SHAPE"
  | "E_SCHEMA_MISMATCH"
  | "E_SLOT_CLIENT_UNAVAILABLE"
  | "E_USAGE"
  | "E_WORKTREE_DIRTY";

export class RouteCensusError extends Error {
  readonly code: RouteCensusErrorCode;

  constructor(code: RouteCensusErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RouteCensusError";
    this.code = code;
  }
}

export function fail(code: RouteCensusErrorCode, message: string): never {
  throw new RouteCensusError(code, message);
}

export function asRouteCensusError(error: unknown, fallback: RouteCensusErrorCode): RouteCensusError {
  return error instanceof RouteCensusError
    ? error
    : new RouteCensusError(fallback, error instanceof Error ? error.message : String(error), {
        cause: error,
      });
}
