import type { NotificationOutbox } from "@chase-sets/notifications";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { mapOrderConfirmedToNotification } from "./notification-intents";

export const ORDERING_NOTIFICATION_PROJECTION =
  "ordering-order-notification-projection";

export type OrderingOrderCreatedNotificationEvent = Readonly<
  TransportEvent & {
    type: "ordering.order.created";
    data: Readonly<{
      orderId: string;
      buyerAccountId: AccountId;
      totalAmount: string;
      shippingDestinationSnapshot: Readonly<{ email?: string | null }>;
    }>;
  }
>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectOrderingEventToNotification(
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = ORDERING_NOTIFICATION_PROJECTION,
) {
  if (event.type !== "ordering.order.created") return;
  const data = event.data as OrderingOrderCreatedNotificationEvent["data"];

  await outbox.enqueueNotification({
    message: mapOrderConfirmedToNotification({
      buyerAccountId: data.buyerAccountId,
      buyerEmail: data.shippingDestinationSnapshot.email,
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

export function buildOrderingNotificationProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = ORDERING_NOTIFICATION_PROJECTION,
): ProjectorHandlerMap {
  return {
    "ordering.order.created": (event) =>
      projectOrderingEventToNotification(outbox, event, projectionName),
  };
}
