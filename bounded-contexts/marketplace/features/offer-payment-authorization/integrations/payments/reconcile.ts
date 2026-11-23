import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { authorizationEvent } from "../../domain/contracts";
import { buyerPaymentInstrumentMirrored } from "./instrument-projection";

function buyerContext(event: TransportEvent): EventStoreContext {
  const buyerAccountId = event.data.buyerAccountId ?? event.data.accountId;
  if (typeof buyerAccountId !== "string" || buyerAccountId.length === 0) throw new Error("Buyer account is required.");
  return {
    tenantId: event.tenantId,
    audit: { ...event.audit, forAccountId: buyerAccountId as EventStoreContext["audit"]["forAccountId"] },
  };
}

export function buyerInstrumentHandoff(
  eventStore: Pick<ReturnType<typeof createPostgresEventStore>, "appendToStreamInTransaction">,
) {
  return (db: Parameters<typeof eventStore.appendToStreamInTransaction>[0], event: TransportEvent) => {
    const context = buyerContext(event);
    const buyerAccountId = context.audit.forAccountId;
    return eventStore
      .appendToStreamInTransaction(db, {
        streamId: `marketplace.buyer-payment-instrument-mirror-${buyerAccountId}`,
        expectedVersion: "any",
        context,
        events: [{ eventType: buyerPaymentInstrumentMirrored, payload: { buyerAccountId } }],
      })
      .then(() => undefined);
  };
}

export function buildBuyerInstrumentReconciliation(
  reconcile: (context: EventStoreContext) => Promise<unknown>,
): ProjectorHandlerMap {
  const handler: ProjectorHandlerMap[string] = async (event) => {
    await reconcile(buyerContext(event));
  };
  return {
    [buyerPaymentInstrumentMirrored]: handler,
    [authorizationEvent.authorized]: handler,
    [authorizationEvent.resumed]: handler,
  };
}
