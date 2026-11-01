import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  releaseCheckoutInventoryReservations,
  type CheckoutInventoryReservation,
} from "../../../support/request-support/checkout-confirmation";
import type { CheckoutSessionMutationResult, CheckoutSessionServices } from "./runtime";

export type CancelCheckoutResult = CheckoutSessionMutationResult &
  Readonly<{
    status: "cancelled" | "already-cancelled";
    releasedReservations: readonly CheckoutInventoryReservation[];
  }>;

/**
 * Cancel checkout: the owner's reservations-only session releases every active
 * Inventory hold through Checkout's deterministic release, then records the
 * cancellation. The session is read from its own stream, so a repeat finds it
 * already cancelled and releases nothing, and a session that already created
 * orders or started payment is refused before any hold is touched.
 */
export async function cancelCheckout(
  request: Request,
  sessions: Pick<CheckoutSessionServices, "readSessionForCancellation" | "cancelSession">,
  params: Readonly<{ sessionId: string; accountId: AccountId }>,
  context: EventStoreContext,
): Promise<CancelCheckoutResult> {
  const read = await sessions.readSessionForCancellation(params);
  if (read.status === "already-cancelled") {
    return {
      sessionId: params.sessionId,
      session: read.session,
      status: "already-cancelled",
      releasedReservations: [],
    };
  }

  const releasedReservations = await releaseCheckoutInventoryReservations(request, read.session);
  const result = await sessions.cancelSession(params, context);
  return { ...result, status: "cancelled", releasedReservations };
}
