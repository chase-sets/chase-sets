import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { evolveCheckoutSession, initialCheckoutSessionState, type CheckoutSessionEvent } from "../domain/domain";

export function createCheckoutInventoryReservationAuthority(pool: PgTransactionalPool) {
  const eventStore = createPostgresEventStore({ pool });
  return async (
    input: Readonly<{
      checkoutSessionId: string;
      lineKey: string;
      inventoryItemId: string;
      quantity: number;
      operation?: "create" | "extend" | "release";
      context: EventStoreContext;
    }>,
  ): Promise<Readonly<{ accountId: string; canMutate: boolean }> | null> => {
    const events = await readCompleteStream(eventStore, { streamId: `checkout.session-${input.checkoutSessionId}` });
    if (
      !events.length ||
      !input.context.audit.performedByUserId ||
      events.some((event) => event.tenantId !== input.context.tenantId)
    )
      return null;
    const state = events.reduce(
      (state, event) =>
        evolveCheckoutSession(state, { type: event.eventType, data: event.payload } as CheckoutSessionEvent),
      initialCheckoutSessionState,
    );
    if (state.sessionId !== input.checkoutSessionId || state.buyerAccountId !== input.context.audit.forAccountId)
      return null;
    const retainedStates = events.reduce<(typeof state)[]>((states, event) => {
      states.push(
        evolveCheckoutSession(states.at(-1) ?? initialCheckoutSessionState, {
          type: event.eventType,
          data: event.payload,
        } as CheckoutSessionEvent),
      );
      return states;
    }, []);
    const lines = retainedStates.flatMap((retained) => [
      ...(retained.fulfillmentPreviewSnapshot?.sellerGroups.flatMap((group) => group.lines) ?? []),
      ...retained.checkoutReservations,
    ]);
    const matches = lines.filter(
      (line) =>
        line.lineKey === input.lineKey &&
        line.inventoryItemId === input.inventoryItemId &&
        line.quantity === input.quantity,
    );
    const sellers = new Set(matches.map((line) => line.sellerAccountId));
    if (sellers.size !== 1) return null;
    return {
      accountId: matches[0]!.sellerAccountId,
      canMutate: input.operation === "release" || (!state.cancelledAt && state.orderIds.length === 0),
    };
  };
}
