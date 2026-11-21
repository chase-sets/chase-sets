import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, PaymentId } from "@chase-sets/primitives/typed-ids";
import {
  failMarkedPaymentCreationReservation,
  listPaymentCreationReservationsForSweep,
  lockMarkedPaymentCreationReservation,
  recordReservationHoldCleanup,
} from "../read-model/queries";
import type { BalanceCreditResolver } from "./balance-credit-resolver";
import type { PaymentTransactionRunner } from "./webhook-transaction";

const RESERVATION_STALE_MS = 15 * 60 * 1000;

export async function sweepPaymentCreationReservations(
  deps: Readonly<{
    db: PgQueryable;
    runPaymentTransaction: PaymentTransactionRunner;
    balanceCreditResolver?: BalanceCreditResolver;
  }>,
  params: Readonly<{ startedAt: string; limit?: number }>,
  context: EventStoreContext,
): Promise<ReadonlyArray<{ kind: "creation-reservation"; payment_id: string; reason: string }>> {
  const staleBefore = new Date(Date.parse(params.startedAt) - RESERVATION_STALE_MS);
  const paymentIds = await listPaymentCreationReservationsForSweep(deps.db, {
    staleBefore: staleBefore.toISOString(),
    limit: params.limit,
  });
  const attention: { kind: "creation-reservation"; payment_id: string; reason: string }[] = [];
  for (const paymentId of paymentIds) {
    const buyerAccountId = await deps.runPaymentTransaction(async ({ db, eventStore }) => {
      const reservation = await lockMarkedPaymentCreationReservation(db, paymentId);
      if (!reservation) return null;
      const stale = reservation.status === "active" && new Date(reservation.created_at) < staleBefore;
      const pending = reservation.status === "failed" && reservation.release_pending === true;
      if (!stale && !pending) return null;

      // Selection is advisory: creation can append while the sweep waits for the reservation lock.
      const events = await eventStore.readStream({ streamId: `payments.payment-${paymentId}`, limit: 1 });
      if (events.length > 0) return null;
      if (!pending && !(await failMarkedPaymentCreationReservation(db, paymentId))) return null;
      return reservation.buyer_account_id as AccountId;
    });
    if (buyerAccountId === null) continue;

    // Only the committed failed reservation fences the creator. The wallet uses a separate pool.
    let acknowledged = false;
    try {
      const outcome = await deps.balanceCreditResolver?.retireSpendHold?.(
        { paymentId: paymentId as PaymentId, buyerAccountId, reason: "payment-cancelled" },
        context,
      );
      acknowledged = outcome === "released" || outcome === "retired" || outcome === "already-settled";
    } catch {
      // No durable wallet acknowledgement; keep the reservation pending for the next scan.
    }

    const failures = await deps.runPaymentTransaction(({ db }) =>
      recordReservationHoldCleanup(db, { paymentId, acknowledged }),
    );
    if (!acknowledged && failures === 3) {
      attention.push({
        kind: "creation-reservation",
        payment_id: paymentId,
        reason: "Payment creation spend hold cleanup has not been acknowledged after three reconciliation attempts.",
      });
    }
  }
  return attention;
}
