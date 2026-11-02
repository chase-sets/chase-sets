/**
 * Request-side outcome of one Saved Checkout Instrument Attempt. Only these states and a code from
 * the closed table below leave the classifier; a raw error message never does.
 */
export type SavedPaymentMethodAttemptFailureState =
  | "refused"
  | "unconfirmed"
  | "conflict"
  | "account-changed"
  | "reauth-required";

export const SAVED_PAYMENT_METHOD_ATTEMPT_FAILURE_CODES: Readonly<
  Record<string, SavedPaymentMethodAttemptFailureState>
> = {
  attempt_conflict: "conflict",
  attempt_unconfirmed: "unconfirmed",
  account_changed: "account-changed",
  authentication_required: "reauth-required",
  authorization_forbidden: "refused",
  not_found: "refused",
  validation_failed: "refused",
};

function apiFailure(error: unknown): Readonly<{ status: number; body: unknown }> | null {
  return error instanceof Error && "status" in error && typeof error.status === "number" && "body" in error
    ? { status: error.status, body: error.body }
    : null;
}

function errorBodyCode(body: unknown) {
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  const error = (body as Readonly<{ error: unknown }>).error;
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

/**
 * Maps a `PaymentsApiError` by `error.code`, then HTTP status, then transport failure. Anything
 * that may have reached the server without an answer is `unconfirmed`, never `refused`.
 */
export function classifySavedPaymentMethodAttemptFailure(
  error: unknown,
): Readonly<{ state: SavedPaymentMethodAttemptFailureState; code: string | null }> {
  const failure = apiFailure(error);
  if (!failure) return { state: "unconfirmed", code: null };
  const code = errorBodyCode(failure.body);
  const known = code && Object.hasOwn(SAVED_PAYMENT_METHOD_ATTEMPT_FAILURE_CODES, code) ? code : null;
  if (known) return { state: SAVED_PAYMENT_METHOD_ATTEMPT_FAILURE_CODES[known]!, code: known };
  const state =
    failure.status === 401
      ? "reauth-required"
      : failure.status === 409
        ? "conflict"
        : failure.status >= 400 && failure.status < 500
          ? "refused"
          : "unconfirmed";
  return { state, code: null };
}
