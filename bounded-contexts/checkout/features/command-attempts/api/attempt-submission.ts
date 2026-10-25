import {
  checkoutCommandAttemptStateForResult,
  computeCheckoutCommandAttemptRequestHash,
  parseCheckoutCommandAttemptResult,
  type CheckoutCartAttemptKind,
  type CheckoutCommandAttemptResult,
  type CheckoutCommandAttemptResolvedState,
} from "./contracts";

export type CheckoutCartAttemptQuery = Readonly<{
  attemptId: string;
  kind: CheckoutCartAttemptKind;
  target: string;
  requestHash: string;
}>;

/**
 * One resolved submission. `response` is present only when the owner's own
 * response arrived; a submission resolved by lookup carries the owner's result
 * and no response.
 */
export type CheckoutCartAttemptSubmission<TResponse> = Readonly<{
  state: CheckoutCommandAttemptResolvedState;
  query: CheckoutCartAttemptQuery;
  attempt: CheckoutCommandAttemptResult | null;
  response: TResponse | null;
  resolvedBy: "response" | "lookup" | "refusal";
  message: string | null;
}>;

function errorStatus(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function errorBody(error: unknown) {
  return typeof error === "object" && error !== null && "body" in error ? (error as { body: unknown }).body : null;
}

function errorMessage(error: unknown) {
  const body = errorBody(error) as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : null;
}

/**
 * A response that cannot prove the request never reached the owner: no HTTP
 * status at all, a timeout, or a server/gateway failure. Connectivity never
 * proves success or failure (decision 1), so only one owner lookup may resolve
 * it.
 */
function isPossibleSendLoss(status: number | null) {
  return status === null || status === 408 || status >= 500;
}

/**
 * Sends one deliberate cart submission and resolves it without ever resending.
 *
 * - The owner's response resolves it directly.
 * - A decided refusal (4xx) is failed-safe or ambiguous by the closed attempt
 *   result it carries; a refusal without one never reached a decision.
 * - A possible-send loss triggers exactly one lookup of the same attempt; a
 *   lookup that cannot answer, or answers `not-observed`, is `ambiguous` and the
 *   caller keeps the action disabled until the user explicitly resends the same
 *   attempt.
 */
export async function submitCheckoutCartAttempt<TResponse extends Readonly<{ attempt: unknown }>>(
  input: Readonly<{
    attemptId: string;
    kind: CheckoutCartAttemptKind;
    target: string;
    body: unknown;
    send: () => Promise<TResponse>;
    lookup: (query: CheckoutCartAttemptQuery) => Promise<CheckoutCommandAttemptResult>;
  }>,
): Promise<CheckoutCartAttemptSubmission<TResponse>> {
  const query: CheckoutCartAttemptQuery = {
    attemptId: input.attemptId,
    kind: input.kind,
    target: input.target,
    requestHash: await computeCheckoutCommandAttemptRequestHash(input.body),
  };
  try {
    const response = await input.send();
    const attempt = parseCheckoutCommandAttemptResult(response.attempt);
    return {
      state: attempt ? checkoutCommandAttemptStateForResult(attempt) : "ambiguous",
      query,
      attempt,
      response,
      resolvedBy: "response",
      message: null,
    };
  } catch (error) {
    const status = errorStatus(error);
    if (!isPossibleSendLoss(status)) {
      const attempt = parseCheckoutCommandAttemptResult((errorBody(error) as { attempt?: unknown } | null)?.attempt);
      return {
        state: attempt ? checkoutCommandAttemptStateForResult(attempt) : "failed-safe",
        query,
        attempt,
        response: null,
        resolvedBy: "refusal",
        message: errorMessage(error),
      };
    }
    let attempt: CheckoutCommandAttemptResult | null = null;
    try {
      attempt = await input.lookup(query);
    } catch {
      attempt = null;
    }
    return {
      state: attempt ? checkoutCommandAttemptStateForResult(attempt) : "ambiguous",
      query,
      attempt,
      response: null,
      resolvedBy: "lookup",
      message: null,
    };
  }
}

/**
 * The commit receipt a resolved submission proves. The owner's own response
 * already carries one; a submission resolved by lookup carries the attempt
 * event's stored position instead, which is appended in the same all-or-nothing
 * write as the cart events, so a fresh read after it waits for the same commit.
 */
export function checkoutCartAttemptCommitSource(
  submission: Pick<CheckoutCartAttemptSubmission<unknown>, "attempt" | "response">,
) {
  if (submission.response) {
    return submission.response;
  }
  const receipt = submission.attempt?.commitReceipt;
  return receipt
    ? {
        commitPosition: receipt.globalPosition,
        commitEventIds: [receipt.eventId],
        commitPositions: [
          { sourceContextName: "checkout", maxGlobalPosition: receipt.globalPosition, eventIds: [receipt.eventId] },
        ],
      }
    : null;
}
