import {
  checkoutEntryAttemptKey,
  checkoutEntryAttemptQuery,
  checkoutEntryAttemptSessionId,
} from "../../../features/command-attempts/api/entry-attempt-contracts";
import { checkoutCartAttemptCommitSource } from "../../../features/command-attempts/api/attempt-submission";
import { readApiErrorCode } from "@chase-sets/http/responses";
import type { CreateCheckoutSessionRequest } from "../../request-support/api-client";
import type { CheckoutRequestApi } from "./checkout-start-source";

/**
 * A response that cannot prove the entry never reached the owner: no HTTP
 * status at all, a timeout, or a server or gateway failure that is not a
 * decided refusal such as a closed checkout.
 */
function isPossibleSendLoss(error: unknown) {
  const { status, body } = (error ?? {}) as { status?: unknown; body?: unknown };
  if (typeof status !== "number") return true;
  return status === 408 || (status >= 500 && readApiErrorCode(body) !== "checkout_closed");
}

/**
 * Whether the submitted form may be sent at all: a malformed key never is, and
 * only a cart entry may go keyless (its readiness snapshot is its scope).
 * Refusing here sends zero commands.
 */
export function checkoutStartEntryRefusedBeforeSend(formData: FormData, sourceType: string) {
  const presented = String(formData.get("entryAttemptKey") ?? "").trim();
  const key = checkoutEntryAttemptKey(presented);
  return (presented.length > 0 && !key) || (!key && sourceType !== "cart");
}

export type CheckoutStartEntryOutcome =
  | Readonly<{ kind: "opened"; session: Readonly<{ session_id: string }> }>
  | Readonly<{ kind: "ambiguous" }>;

/**
 * Sends one Session entry and never resends it. The owner's response opens
 * the Session; a possible-send loss of a keyed entry does exactly one owner
 * lookup of the same attempt, and only a committed attempt naming its Session
 * resolves it. Anything else is ambiguous. A decided refusal propagates.
 */
export async function openCheckoutSessionOnce(
  api: Pick<CheckoutRequestApi, "createCheckoutSession" | "getCheckoutEntryAttempt">,
  sessionRequest: CreateCheckoutSessionRequest,
  presentedAnonymousCartHeader: string | null,
): Promise<CheckoutStartEntryOutcome> {
  try {
    return { kind: "opened", session: await api.createCheckoutSession(sessionRequest) };
  } catch (error) {
    const attemptId = sessionRequest.entryAttemptKey ? checkoutEntryAttemptKey(sessionRequest.entryAttemptKey) : null;
    if (!attemptId || !isPossibleSendLoss(error)) {
      throw error;
    }
    const attempt = await api
      .getCheckoutEntryAttempt(await checkoutEntryAttemptQuery(attemptId, sessionRequest, presentedAnonymousCartHeader))
      .catch(() => null);
    const sessionId = checkoutEntryAttemptSessionId(attempt);
    return sessionId
      ? {
          kind: "opened",
          session: { session_id: sessionId, ...checkoutCartAttemptCommitSource({ attempt, response: null }) },
        }
      : { kind: "ambiguous" };
  }
}
