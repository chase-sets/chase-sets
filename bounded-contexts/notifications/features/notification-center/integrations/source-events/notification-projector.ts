import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { NotificationOutbox } from "@chase-sets/notifications";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { mapOrderCreatedToNotification, mapShipmentDeliveredToNotification } from "./notification-intents";

export const NOTIFICATIONS_ORDERING_PROJECTION = "notifications-ordering-facts-projection";
export const NOTIFICATIONS_FULFILLMENT_PROJECTION = "notifications-fulfillment-facts-projection";

type OrderCreatedEvent = TransportEvent &
  Readonly<{
    type: "ordering.order.created";
    data: Readonly<{
      orderId: string;
      buyerAccountId: AccountId;
      totalAmount: string;
      shippingDestinationSnapshot: Readonly<{ email?: string | null }>;
    }>;
  }>;

type ShipmentDeliveredEvent = TransportEvent &
  Readonly<{
    type: "fulfillment.shipment.delivered";
    data: Readonly<{
      shipmentId: string;
      orderId: string;
      buyerAccountId: AccountId;
      trackingIdentifier: string | null;
      shippingDestinationSnapshot: Readonly<{ email?: string | null }>;
    }>;
  }>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

export async function projectSourceEventToNotification(
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName: string,
) {
  if (event.type === "ordering.order.created") {
    const data = event.data as OrderCreatedEvent["data"];
    await outbox.enqueueNotification({
      message: mapOrderCreatedToNotification({
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
    return;
  }

  if (event.type === "fulfillment.shipment.delivered") {
    const data = event.data as ShipmentDeliveredEvent["data"];
    const trackingNumber = data.trackingIdentifier ?? data.shipmentId;
    await outbox.enqueueNotification({
      message: mapShipmentDeliveredToNotification({
        buyerAccountId: data.buyerAccountId,
        buyerEmail: data.shippingDestinationSnapshot.email,
        shipmentId: data.shipmentId,
        orderId: data.orderId,
        trackingNumber,
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
}

export function buildNotificationsOrderingProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = NOTIFICATIONS_ORDERING_PROJECTION,
): ProjectorHandlerMap {
  return {
    "ordering.order.created": (event) => projectSourceEventToNotification(outbox, event, projectionName),
  };
}

export function buildNotificationsFulfillmentProjectionHandlers(
  outbox: NotificationOutbox,
  projectionName = NOTIFICATIONS_FULFILLMENT_PROJECTION,
): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.delivered": (event) => projectSourceEventToNotification(outbox, event, projectionName),
  };
}
