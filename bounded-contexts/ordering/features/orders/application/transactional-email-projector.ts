import type { TransactionalEmailOutbox } from "@chase-sets/communications-email";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { mapOrderConfirmedToTransactionalEmail } from "./transactional-email-intents";

export const ORDERING_TRANSACTIONAL_EMAIL_PROJECTION =
  "ordering-order-transactional-email-projection";

export type OrderingOrderCreatedEmailEvent = Readonly<
  TransportEvent & {
    type: "ordering.order.created";
    data: Readonly<{
      orderId: string;
      totalAmount: string;
      shippingDestinationSnapshot: Readonly<{ email?: string | null }>;
    }>;
  }
>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectOrderingEventToTransactionalEmail(
  outbox: TransactionalEmailOutbox,
  event: TransportEvent,
  projectionName = ORDERING_TRANSACTIONAL_EMAIL_PROJECTION,
) {
  if (event.type !== "ordering.order.created") return;
  const data = event.data as OrderingOrderCreatedEmailEvent["data"];
  const buyerEmail = data.shippingDestinationSnapshot.email?.trim();
  if (!buyerEmail) return;

  await outbox.enqueueTransactionalEmail({
    message: mapOrderConfirmedToTransactionalEmail({
      buyerEmail,
      orderId: data.orderId,
      orderTotal: data.totalAmount,
      correlationId: correlationIdFromEvent(event),
    }),
    source: {
      sourceEventId: event.id,
      sourceGlobalPosition: event.globalPosition,
      projectionName,
      occurredAt: event.timing.occurredAt,
    },
  });
}

export function buildOrderingTransactionalEmailProjectionHandlers(
  outbox: TransactionalEmailOutbox,
  projectionName = ORDERING_TRANSACTIONAL_EMAIL_PROJECTION,
): ProjectorHandlerMap {
  return {
    "ordering.order.created": (event) =>
      projectOrderingEventToTransactionalEmail(outbox, event, projectionName),
  };
}
